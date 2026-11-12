// POST /api/checkout — Crea la Stripe Checkout Session de Sora Go (suscripción, pago inmediato).
//
// La calculadora manda SOLO la selección (y el total que mostró, para detectar desfases).
// El importe se recalcula aquí con el mismo motor de pricing. Nunca se usa un monto del navegador.
'use strict';

const crypto = require('crypto');
const { cotizarSeleccion, ErrorSeleccion } = require('../lib/cotizar.js');
const { getStripe, requerido } = require('../lib/stripe.js');
const { leerJson, enviar, baseUrl } = require('../lib/http.js');
const { productoDe, NOMBRE_PLAN } = require('../lib/productos.js');

const txt = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
const emailValido = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

module.exports = async function checkout(req, res) {
  if (req.method !== 'POST') return enviar(res, 405, { error: 'Método no permitido' });

  try {
    const b = await leerJson(req);
    const c = cotizarSeleccion(b.seleccion);

    // Si la página mostró otro precio o usa otra versión de pricing, no se cobra: se pide recargar.
    if (b.versionPricing !== c.versionPricing) {
      return enviar(res, 409, { error: 'Los precios se actualizaron. Recarga la página para ver tu total vigente.', codigo: 'version_pricing' });
    }
    if (Number(b.totalEsperadoCentavos) !== c.totalCentavos) {
      return enviar(res, 409, { error: 'El total cambió. Recarga la página para ver tu total vigente.', codigo: 'total_distinto' });
    }

    const lead = b.lead || {};
    const email = txt(lead.email, 200).toLowerCase();
    if (!emailValido(email)) throw new ErrorSeleccion('Escribe un correo válido');

    const s = c.seleccion;
    const prio = b.prioridad || {};
    const attr = b.atribucion || {};
    // Metadata de Stripe: máx. 50 llaves, 500 caracteres por valor. Todo como texto.
    const meta = {
      origen: 'calculadora1',
      version_pricing: c.versionPricing,
      empleados: String(s.empleados),
      plan: s.plan,
      facturacion: s.facturacion,
      documentos: String(s.documentos),
      recibos: String(s.recibos),
      reloj: String(s.reloj),
      vacaciones: String(s.vacaciones),
      total_mensual_sin_iva: String(c.totalMensualSinIva),
      subtotal_centavos: String(c.subtotalCentavos),
      iva_centavos: String(c.ivaCentavos),
      total_centavos: String(c.totalCentavos),
      nombre: txt(lead.nombre, 120),
      empresa: txt(lead.empresa, 160),
      modulo_prioritario: txt(prio.sora_go_modulo_prioritario, 40),
      orden_activacion: txt(Array.isArray(prio.orden_activacion) ? prio.orden_activacion.join('>') : '', 120),
      sora_ref: txt(b.soraRef, 60),
      utm_source: txt(attr.utm_source, 150),
      utm_medium: txt(attr.utm_medium, 150),
      utm_campaign: txt(attr.utm_campaign, 150),
      utm_content: txt(attr.utm_content, 150),
    };
    for (const k of Object.keys(meta)) if (meta[k] === '') delete meta[k];

    const iva = requerido('STRIPE_TAX_RATE_IVA');
    const base = baseUrl(req);
    const stripe = getStripe();
    const recurring = { interval: c.intervalo };   // month = suscripción mensual · year = anualidad que se renueva cada año

    // Un renglón por solución contratada (con IVA) + lo incluido sin costo en $0, para que el cliente
    // vea el desglose en Stripe, en su recibo y en cada factura de renovación.
    const line_items = [];
    for (const l of c.lineas) {
      line_items.push({
        quantity: 1,
        tax_rates: [iva],
        price_data: { currency: 'mxn', product: await productoDe(stripe, `go_${s.plan}_${l.k}`), unit_amount: l.importeCentavos, recurring },
      });
    }
    for (const inc of c.incluidos) {
      line_items.push({
        quantity: 1,
        price_data: { currency: 'mxn', product: await productoDe(stripe, `go_incluido_${inc.k}`), unit_amount: 0, recurring },
      });
    }
    meta.desglose = c.lineas.map(l => `${l.k}:${l.importeCentavos}`).join('|');

    const params = {
      mode: 'subscription',
      locale: 'es-419',
      customer_email: email,
      client_reference_id: meta.sora_ref || undefined,
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },             // RFC del cliente para el CFDI
      payment_method_types: ['card'],
      line_items,
      subscription_data: {
        description: `Sora Go ${NOMBRE_PLAN[s.plan]} · ${s.empleados} colaboradores · ${s.facturacion === 'anual' ? 'pago anual' : 'pago mensual'}`,
        metadata: meta,
      },
      metadata: meta,
      success_url: `${base}/exito.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/cancelado.html`,
    };
    // Doble clic con exactamente los mismos datos en el mismo minuto → Stripe devuelve la misma sesión.
    const huella = crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 32);
    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `c1-${huella}-${Math.floor(Date.now() / 60000)}`,
    });

    return enviar(res, 200, {
      url: session.url,
      subtotalCentavos: c.subtotalCentavos,
      ivaCentavos: c.ivaCentavos,
      totalCentavos: c.totalCentavos,
      lineas: c.lineas.map(l => ({ k: l.k, nombre: l.nombre, importeCentavos: l.importeCentavos })),
    });
  } catch (err) {
    if (err instanceof ErrorSeleccion) return enviar(res, err.status, { error: err.message });
    console.error('[checkout]', err && err.message, err && err.raw ? err.raw : '');
    if (err && err.interno) return enviar(res, 500, { error: 'El pago no está configurado todavía. Avísale al equipo de Sora.' });
    return enviar(res, 502, { error: 'No pudimos abrir el pago. Intenta de nuevo en un momento.' });
  }
};
