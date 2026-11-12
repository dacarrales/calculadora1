// POST /api/webhook — Recibe los eventos de Stripe, verifica la firma y avisa a Sora.
//
// Eventos que se escuchan (configúralos así en Stripe → Developers → Webhooks):
//   checkout.session.completed      → contratación pagada: dar de alta / activar la cuenta
//   invoice.paid                    → cada cobro pagado (alta y renovaciones): aquí se timbra el CFDI
//   invoice.payment_failed          → cobro rechazado: avisar y, si persiste, suspender
//   customer.subscription.updated   → cambio de estado (past_due, cancel_at_period_end, etc.)
//   customer.subscription.deleted   → suscripción terminada: desactivar la cuenta
//
// Qué hace hoy (modo de prueba): registra el evento en los logs y, si existe
// SORA_WEBHOOK_FORWARD_URL, reenvía un JSON compacto (Dapta, Zapier, un endpoint de producto…).
// Stripe reintenta si respondemos error, así que quien reciba el reenvío debe deduplicar por `event_id`.
'use strict';

const { getStripe, requerido } = require('../lib/stripe.js');
const { leerCrudo, enviar } = require('../lib/http.js');

const EVENTOS = new Set([
  'checkout.session.completed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const idDe = v => (v && typeof v === 'object' ? v.id : v) || null;

// Las versiones nuevas de la API movieron algunos campos; se leen ambos lugares.
function subscripcionDeFactura(inv) {
  return idDe(inv.subscription)
    || idDe(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription)
    || null;
}
function periodoFin(sub) {
  return sub.current_period_end
    || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end)
    || null;
}

function resumir(event) {
  const o = event.data.object;
  const base = { event_id: event.id, tipo: event.type, creado: new Date(event.created * 1000).toISOString(), modo: event.livemode ? 'live' : 'test' };
  switch (event.type) {
    case 'checkout.session.completed':
      return { ...base,
        accion: 'alta_cuenta',
        checkout_session: o.id,
        cliente: idDe(o.customer),
        suscripcion: idDe(o.subscription),
        email: (o.customer_details && o.customer_details.email) || o.customer_email || null,
        nombre_facturacion: (o.customer_details && o.customer_details.name) || null,
        rfc: ((o.customer_details && o.customer_details.tax_ids) || []).map(t => t.value).join(',') || null,
        estado_pago: o.payment_status,
        subtotal_centavos: o.amount_subtotal,
        iva_centavos: o.total_details ? o.total_details.amount_tax : null,
        total_centavos: o.amount_total,
        moneda: o.currency,
        metadata: o.metadata || {},
      };
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return { ...base,
        accion: event.type === 'invoice.paid' ? 'timbrar_cfdi' : 'cobro_fallido',
        factura: o.id,
        numero: o.number || null,
        motivo: o.billing_reason || null,          // subscription_create | subscription_cycle | …
        cliente: idDe(o.customer),
        suscripcion: subscripcionDeFactura(o),
        email: o.customer_email || null,
        rfc: (o.customer_tax_ids || []).map(t => t.value).join(',') || null,
        subtotal_centavos: o.subtotal,
        iva_centavos: (o.total_taxes || o.total_tax_amounts || []).reduce((s, t) => s + (t.amount || 0), 0),
        total_centavos: o.total,
        pagado_centavos: o.amount_paid,
        intento: o.attempt_count || null,
        pdf: o.invoice_pdf || null,
      };
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return { ...base,
        accion: event.type.endsWith('deleted') ? 'baja_cuenta' : 'cambio_suscripcion',
        suscripcion: o.id,
        cliente: idDe(o.customer),
        estado: o.status,                            // active | past_due | unpaid | canceled | …
        cancela_al_final: !!o.cancel_at_period_end,
        periodo_fin: periodoFin(o) ? new Date(periodoFin(o) * 1000).toISOString() : null,
        metadata: o.metadata || {},
      };
    default:
      return base;
  }
}

async function reenviar(payload) {
  const url = process.env.SORA_WEBHOOK_FORWARD_URL;
  if (!url) return { omitido: true };
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.SORA_WEBHOOK_FORWARD_SECRET) headers['X-Sora-Webhook-Secret'] = process.env.SORA_WEBHOOK_FORWARD_SECRET;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`Reenvío respondió ${r.status}`);
  return { ok: true };
}

async function webhook(req, res) {
  if (req.method !== 'POST') return enviar(res, 405, { error: 'Método no permitido' });

  let event;
  try {
    const crudo = await leerCrudo(req);
    const firma = req.headers['stripe-signature'];
    if (!firma) return enviar(res, 400, { error: 'Falta la firma de Stripe' });
    event = getStripe().webhooks.constructEvent(crudo, firma, requerido('STRIPE_WEBHOOK_SECRET'));
  } catch (err) {
    console.error('[webhook] firma inválida o configuración incompleta:', err.message);
    return enviar(res, 400, { error: 'Firma inválida' });
  }

  if (!EVENTOS.has(event.type)) return enviar(res, 200, { recibido: true, ignorado: event.type });

  const payload = resumir(event);
  console.log('[webhook]', JSON.stringify(payload));

  try {
    const r = await reenviar(payload);
    return enviar(res, 200, { recibido: true, reenvio: r });
  } catch (err) {
    // Respondemos error para que Stripe reintente (hasta ~3 días).
    console.error('[webhook] reenvío falló:', err.message);
    return enviar(res, 502, { error: 'Reenvío falló; Stripe reintentará' });
  }
}

module.exports = webhook;
// Vercel: no parsear el cuerpo; la firma se valida contra el cuerpo crudo.
module.exports.config = { api: { bodyParser: false } };
module.exports._resumir = resumir;
