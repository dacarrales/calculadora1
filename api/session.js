// GET /api/session?id=cs_... — Datos de la contratación para la página de éxito.
// Solo expone lo que el propio cliente acaba de ver en Stripe (nada de IDs internos sensibles).
'use strict';

const { getStripe } = require('../lib/stripe.js');
const { enviar } = require('../lib/http.js');

module.exports = async function session(req, res) {
  if (req.method !== 'GET') return enviar(res, 405, { error: 'Método no permitido' });
  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return enviar(res, 400, { error: 'Sesión inválida' });

  try {
    const s = await getStripe().checkout.sessions.retrieve(id, { expand: ['subscription', 'line_items'] });
    const sub = s.subscription && typeof s.subscription === 'object' ? s.subscription : null;
    const fin = sub && (sub.current_period_end || (sub.items && sub.items.data[0] && sub.items.data[0].current_period_end));
    const m = s.metadata || {};
    return enviar(res, 200, {
      estado: s.status,                       // complete | open | expired
      pagado: s.payment_status === 'paid',
      email: (s.customer_details && s.customer_details.email) || s.customer_email || null,
      empresa: m.empresa || null,
      plan: m.plan === 'pro' ? 'PRO' : 'Estándar',
      empleados: Number(m.empleados) || null,
      facturacion: m.facturacion || null,
      soluciones: ['documentos', 'recibos', 'reloj', 'vacaciones'].filter(k => m[k] === 'true'),
      // Desglose tal como lo cobró Stripe: un renglón por solución (los incluidos van en $0).
      lineas: ((s.line_items && s.line_items.data) || []).map(li => ({ nombre: li.description, importeCentavos: li.amount_subtotal })),
      subtotalCentavos: s.amount_subtotal,
      ivaCentavos: s.total_details ? s.total_details.amount_tax : null,
      totalCentavos: s.amount_total,
      moneda: s.currency,
      proximoCobro: fin ? new Date(fin * 1000).toISOString() : null,
      modo: s.livemode ? 'live' : 'test',
    });
  } catch (err) {
    console.error('[session]', err.message);
    return enviar(res, 404, { error: 'No encontramos esa contratación' });
  }
};
