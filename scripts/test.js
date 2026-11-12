#!/usr/bin/env node
// Pruebas de calculadora1 sin tocar Stripe real: Stripe se simula y la página corre en jsdom.
//   npm test
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const Stripe = require('stripe');

process.env.STRIPE_SECRET_KEY = 'sk_test_simulada';
process.env.STRIPE_TAX_RATE_IVA = 'txr_iva';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_prueba';
process.env.PUBLIC_BASE_URL = 'https://ejemplo.sora.mx';

const raiz = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(raiz, 'public/calculadora1.html'), 'utf8');
const { cotizarSeleccion } = require('../lib/cotizar.js');
const { _setStripeParaPruebas } = require('../lib/stripe.js');

let ok = 0;
const t = async (nombre, fn) => { try { await fn(); ok++; console.log('  ✓', nombre); } catch (e) { console.error('  ✗', nombre, '\n   ', e.message); process.exitCode = 1; } };

// ---- Stripe simulado
const llamadas = [];
const stripeReal = new Stripe('sk_test_simulada');
_setStripeParaPruebas({
  products: { list: () => (async function* () { for (const it of require('../lib/productos.js').catalogo()) yield { id: 'prod_' + it.sora_key, metadata: { sora_key: it.sora_key } }; })() },
  checkout: { sessions: {
    create: async (params, opts) => { llamadas.push({ params, opts }); return { id: 'cs_test_abc', url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }; },
    retrieve: async id => ({ id, status: 'complete', payment_status: 'paid', customer_details: { email: 'ana@empresa.mx' }, metadata: { plan: 'pro', empleados: '60', facturacion: 'anual', documentos: 'true', recibos: 'false', reloj: 'true', vacaciones: 'false', empresa: 'Empresa SA' }, amount_subtotal: 100000, total_details: { amount_tax: 16000 }, amount_total: 116000, currency: 'mxn', livemode: false, line_items: { data: [{ description: 'Expedientes digitales · Sora Go PRO', amount_subtotal: 100000 }, { description: 'Gestión de ausencias (incluido)', amount_subtotal: 0 }] }, subscription: { items: { data: [{ current_period_end: 1800000000 }] } } }),
  } },
  webhooks: stripeReal.webhooks,
});

// ---- Mini req/res para llamar a los handlers
function llamar(handler, { method = 'POST', url = '/', body, headers = {} } = {}) {
  return new Promise(resolve => {
    const { Readable } = require('stream');
    const crudo = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const req = Readable.from([Buffer.from(crudo)]);
    Object.assign(req, { method, url, headers: { host: 'localhost', ...headers } });
    const res = { statusCode: 200, h: {}, setHeader(k, v) { this.h[k] = v; }, end(b) { resolve({ status: this.statusCode, json: b ? JSON.parse(b) : null }); } };
    handler(req, res);
  });
}

(async () => {
  console.log('\nMotor y paridad');
  await t('el motor del HTML es idéntico a lib/pricing-engine.js', () => {
    assert(html.includes(fs.readFileSync(path.join(raiz, 'lib/pricing-engine.js'), 'utf8')));
  });
  await t('la config de precios del HTML es idéntica a lib/pricing-config.json', () => {
    const a = html.indexOf('const SORA_PRICING_CONFIG = ') + 28;
    const deHtml = JSON.parse(html.slice(a, html.indexOf('};\n// Motor de pricing', a) + 1));
    assert.deepStrictEqual(deHtml, require('../lib/pricing-config.json'));
  });
  await t('no hay claves secretas en public/', () => {
    for (const f of fs.readdirSync(path.join(raiz, 'public'))) {
      const c = fs.readFileSync(path.join(raiz, 'public', f), 'utf8');
      assert(!/sk_(test|live)_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}/.test(c), f);
    }
  });

  console.log('\nValidación y cálculo en el servidor');
  await t('20 colab · Expedientes · Estándar · mensual = $500 + IVA $80', () => {
    const c = cotizarSeleccion({ empleados: 20, plan: 'estandar', documentos: true, facturacion: 'mensual' });
    assert.strictEqual(c.subtotalCentavos, 50000); assert.strictEqual(c.ivaCentavos, 8000); assert.strictEqual(c.totalCentavos, 58000); assert.strictEqual(c.intervalo, 'month');
  });
  await t('anual cobra 12 meses con −15% (60 colab PRO, todo)', () => {
    const c = cotizarSeleccion({ empleados: 60, plan: 'pro', documentos: true, recibos: true, reloj: true, vacaciones: true, facturacion: 'anual' });
    assert.strictEqual(c.subtotalCentavos, 50796 * 100); assert.strictEqual(c.intervalo, 'year');
  });
  await t('aplica el mínimo del plan (5 colab Expedientes Estándar = $499)', () => {
    const c = cotizarSeleccion({ empleados: 5, plan: 'estandar', documentos: true, facturacion: 'mensual' });
    assert.strictEqual(c.subtotalCentavos, 49900); assert(c.pisoAplicado);
  });
  await t('rechaza más de 99 colaboradores', () => assert.throws(() => cotizarSeleccion({ empleados: 100, plan: 'estandar', documentos: true, facturacion: 'mensual' }), /hasta 99/));
  await t('rechaza selección sin solución base', () => assert.throws(() => cotizarSeleccion({ empleados: 10, plan: 'estandar', vacaciones: true, facturacion: 'mensual' }), /Expedientes/));
  await t('rechaza tipos raros (documentos: "true")', () => assert.throws(() => cotizarSeleccion({ empleados: 10, plan: 'estandar', documentos: 'true', facturacion: 'mensual' })));
  await t('rechaza plan descontinuado', () => assert.throws(() => cotizarSeleccion({ empleados: 10, plan: 'basico', documentos: true, facturacion: 'mensual' })));

  console.log('\n/api/checkout');
  const checkout = require('../api/checkout.js');
  const sel = { empleados: 20, plan: 'estandar', documentos: true, recibos: false, reloj: false, vacaciones: false, facturacion: 'mensual' };
  const cuerpo = (extra = {}) => ({ seleccion: sel, versionPricing: require('../lib/pricing-config.json').version, totalEsperadoCentavos: 58000, lead: { email: 'ana@empresa.mx', nombre: 'Ana', empresa: 'Empresa SA' }, soraRef: 'SG-123', ...extra });
  await t('crea la sesión con el importe del servidor, IVA y suscripción mensual', async () => {
    const r = await llamar(checkout, { body: cuerpo() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.url, 'https://checkout.stripe.com/c/pay/cs_test_abc');
    const p = llamadas.at(-1).params;
    assert.strictEqual(p.mode, 'subscription');
    assert.strictEqual(p.line_items[0].price_data.unit_amount, 50000);
    assert.strictEqual(p.line_items[0].price_data.currency, 'mxn');
    assert.strictEqual(p.line_items[0].price_data.recurring.interval, 'month');
    assert.strictEqual(p.line_items[0].price_data.product, 'prod_go_estandar_documentos');
    assert.deepStrictEqual(p.line_items[0].tax_rates, ['txr_iva']);
    // incluidos sin costo en $0 y sin IVA: ausencias, demandas, IA
    assert.deepStrictEqual(p.line_items.slice(1).map(l => [l.price_data.product, l.price_data.unit_amount, l.tax_rates]), [['prod_go_incluido_ausencias', 0, undefined], ['prod_go_incluido_demandas', 0, undefined], ['prod_go_incluido_ia', 0, undefined]]);
    assert.strictEqual(p.customer_email, 'ana@empresa.mx');
    assert.strictEqual(p.success_url, 'https://ejemplo.sora.mx/exito.html?session_id={CHECKOUT_SESSION_ID}');
    assert.strictEqual(p.cancel_url, 'https://ejemplo.sora.mx/cancelado.html');
    assert.strictEqual(p.subscription_data.metadata.total_centavos, '58000');
    assert(!('trial_period_days' in p.subscription_data), 'no debe haber prueba gratis');
    assert(llamadas.at(-1).opts.idempotencyKey.startsWith('c1-'));
  });
  await t('ignora un total manipulado: 409 y no crea sesión', async () => {
    const n = llamadas.length;
    const r = await llamar(checkout, { body: cuerpo({ totalEsperadoCentavos: 100 }) });
    assert.strictEqual(r.status, 409); assert.strictEqual(llamadas.length, n);
  });
  await t('versión de pricing distinta: 409', async () => {
    const r = await llamar(checkout, { body: cuerpo({ versionPricing: 'vieja' }) });
    assert.strictEqual(r.status, 409);
  });
  await t('correo inválido: 400', async () => {
    const r = await llamar(checkout, { body: cuerpo({ lead: { email: 'nope' } }) });
    assert.strictEqual(r.status, 400);
  });
  await t('anual PRO con 4 módulos: un renglón por módulo, intervalo year, suma = pago anual del motor', async () => {
    const s2 = { ...sel, empleados: 60, plan: 'pro', recibos: true, reloj: true, vacaciones: true, facturacion: 'anual' };
    const c = cotizarSeleccion(s2);
    const r = await llamar(checkout, { body: cuerpo({ seleccion: s2, totalEsperadoCentavos: c.totalCentavos }) });
    assert.strictEqual(r.status, 200);
    const p = llamadas.at(-1).params;
    const conPrecio = p.line_items.filter(l => l.tax_rates);
    assert.deepStrictEqual(conPrecio.map(l => l.price_data.product), ['prod_go_pro_documentos', 'prod_go_pro_recibos', 'prod_go_pro_reloj', 'prod_go_pro_vacaciones']);
    assert(p.line_items.every(l => l.price_data.recurring.interval === 'year'));
    assert.strictEqual(conPrecio.reduce((x, l) => x + l.price_data.unit_amount, 0), 50796 * 100);
    assert(p.line_items.some(l => l.price_data.product === 'prod_go_incluido_integraciones'));
  });
  await t('todas las combinaciones (1–99 colab, planes, módulos, mensual/anual) cuadran por renglón', () => {
    let n = 0;
    for (let e = 1; e <= 99; e++) for (const plan of ['estandar', 'pro']) for (let m = 1; m < 16; m++) for (const facturacion of ['mensual', 'anual']) {
      const x = { empleados: e, plan, documentos: !!(m & 1), recibos: !!(m & 2), reloj: !!(m & 4), vacaciones: !!(m & 8), facturacion };
      if (!x.documentos && !x.recibos && !x.reloj) continue;
      const c = cotizarSeleccion(x);
      assert.strictEqual(c.lineas.reduce((a, l) => a + l.importeCentavos, 0), c.subtotalCentavos);
      assert(c.lineas.every(l => l.importeCentavos % 100 === 0 && l.importeCentavos >= 0));
      n++;
    }
    assert.strictEqual(n, 5544);
  });
  await t('GET no permitido', async () => assert.strictEqual((await llamar(checkout, { method: 'GET' })).status, 405));

  console.log('\n/api/webhook');
  const webhook = require('../api/webhook.js');
  const evento = { id: 'evt_1', type: 'checkout.session.completed', created: 1760000000, livemode: false, data: { object: { id: 'cs_test_abc', customer: 'cus_1', subscription: 'sub_1', customer_details: { email: 'ana@empresa.mx', name: 'Empresa SA', tax_ids: [{ type: 'mx_rfc', value: 'EMP010101AAA' }] }, payment_status: 'paid', amount_subtotal: 50000, total_details: { amount_tax: 8000 }, amount_total: 58000, currency: 'mxn', metadata: { plan: 'estandar' } } } };
  const firmar = p => stripeReal.webhooks.generateTestHeaderString({ payload: p, secret: 'whsec_prueba' });

  // receptor local para probar el reenvío
  const recibidos = [];
  const receptor = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { recibidos.push({ h: req.headers, b: JSON.parse(b) }); res.end('ok'); }); });
  await new Promise(r => receptor.listen(0, r));
  process.env.SORA_WEBHOOK_FORWARD_URL = `http://127.0.0.1:${receptor.address().port}/`;
  process.env.SORA_WEBHOOK_FORWARD_SECRET = 'secreto-reenvio';

  await t('firma válida: 200 y reenvía la alta con RFC e IVA', async () => {
    const p = JSON.stringify(evento);
    const r = await llamar(webhook, { body: p, headers: { 'stripe-signature': firmar(p) } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const env = recibidos.at(-1);
    assert.strictEqual(env.h['x-sora-webhook-secret'], 'secreto-reenvio');
    assert.strictEqual(env.b.accion, 'alta_cuenta'); assert.strictEqual(env.b.rfc, 'EMP010101AAA'); assert.strictEqual(env.b.iva_centavos, 8000); assert.strictEqual(env.b.event_id, 'evt_1');
  });
  await t('firma inválida: 400 y no reenvía', async () => {
    const n = recibidos.length; const p = JSON.stringify(evento);
    const r = await llamar(webhook, { body: p, headers: { 'stripe-signature': firmar(p).replace(/v1=./, 'v1=0') } });
    assert.strictEqual(r.status, 400); assert.strictEqual(recibidos.length, n);
  });
  await t('cuerpo alterado tras firmar: 400', async () => {
    const p = JSON.stringify(evento);
    const r = await llamar(webhook, { body: p.replace('58000', '1'), headers: { 'stripe-signature': firmar(p) } });
    assert.strictEqual(r.status, 400);
  });
  await t('invoice.paid → timbrar_cfdi (lee la suscripción en el formato nuevo de la API)', async () => {
    const e = { id: 'evt_2', type: 'invoice.paid', created: 1760000000, livemode: false, data: { object: { id: 'in_1', billing_reason: 'subscription_cycle', customer: 'cus_1', parent: { subscription_details: { subscription: 'sub_1' } }, customer_email: 'ana@empresa.mx', customer_tax_ids: [{ value: 'EMP010101AAA' }], subtotal: 50000, total_taxes: [{ amount: 8000 }], total: 58000, amount_paid: 58000 } } };
    const p = JSON.stringify(e);
    const r = await llamar(webhook, { body: p, headers: { 'stripe-signature': firmar(p) } });
    assert.strictEqual(r.status, 200);
    const b = recibidos.at(-1).b; assert.strictEqual(b.accion, 'timbrar_cfdi'); assert.strictEqual(b.suscripcion, 'sub_1'); assert.strictEqual(b.iva_centavos, 8000);
  });
  await t('evento no escuchado: 200 ignorado', async () => {
    const p = JSON.stringify({ ...evento, id: 'evt_3', type: 'charge.refunded' });
    const r = await llamar(webhook, { body: p, headers: { 'stripe-signature': firmar(p) } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.ignorado, 'charge.refunded');
  });
  await t('si el reenvío falla responde 502 para que Stripe reintente', async () => {
    process.env.SORA_WEBHOOK_FORWARD_URL = 'http://127.0.0.1:1/';
    const p = JSON.stringify(evento);
    const r = await llamar(webhook, { body: p, headers: { 'stripe-signature': firmar(p) } });
    assert.strictEqual(r.status, 502);
    delete process.env.SORA_WEBHOOK_FORWARD_URL;
  });
  receptor.close();

  console.log('\n/api/session');
  const session = require('../api/session.js');
  await t('devuelve el resumen para la página de éxito', async () => {
    const r = await llamar(session, { method: 'GET', url: '/api/session?id=cs_test_abc' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.pagado, true); assert.strictEqual(r.json.ivaCentavos, 16000); assert.deepStrictEqual(r.json.soluciones, ['documentos', 'reloj']); assert(r.json.proximoCobro);
  });
  await t('id con formato raro: 400', async () => assert.strictEqual((await llamar(session, { method: 'GET', url: '/api/session?id=../../x' })).status, 400));

  console.log('\nPágina (jsdom): recorrido completo hasta Stripe');
  const { JSDOM } = require('jsdom');
  const peticiones = [];
  const vc = new (require('jsdom').VirtualConsole)();
  vc.on('jsdomError', e => { if (!/navigation/.test(e.message)) console.error(e); });   // la redirección a Stripe no existe en jsdom
  const dom = new JSDOM(html.replace(/<link[^>]+fonts[^>]+>/g, ''), {
    url: 'https://ejemplo.sora.mx/calculadora1.html?utm_source=meta&utm_campaign=go', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
      w.fetch = async (url, opts) => { peticiones.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc', totalCentavos: JSON.parse(opts.body).totalEsperadoCentavos }) }; };
    },
  });
  const w = dom.window, d = w.document, S = w.__sora.S;
  const espera = ms => new Promise(r => setTimeout(r, ms));
  await t('muestra el aviso de modo de prueba', () => assert.strictEqual(d.getElementById('test-band').hidden, false));
  await t('recorre diagnóstico → calculadora con IVA desglosado y botón "Contratar y pagar"', async () => {
    w.toggleNeed('documentos'); w.toggleNeed('reloj'); w.needsContinuar();
    d.getElementById('empnum').value = '35'; w.empContinuar();
    w.responder('documentos', 'A'); await espera(260);
    w.responder('reloj', 'B'); await espera(260);
    assert.strictEqual(w.eval('PASOS[S.paso]'), 'resultado');
    w.irCalc();
    assert.strictEqual(w.eval('PASOS[S.paso]'), 'calc');
    const txt = d.querySelector('.totbox').textContent;
    assert(txt.includes('Contratar y pagar'), 'falta el botón');
    assert(!/prueba gratis/i.test(d.getElementById('app').textContent), 'quedó copy de prueba gratis');
    assert(txt.includes('IVA (16%)') && txt.includes('Total a cobrar hoy'));
  });
  await t('el total y el desglose por módulo de la página coinciden con el servidor (mensual y anual)', () => {
    const s = { empleados: 35, plan: w.eval('planAplicado()'), documentos: true, recibos: false, reloj: true, vacaciones: false, facturacion: 'mensual' };
    const porLinea = c => c.lineas.map(l => [l.k, l.importeCentavos / 100]);
    assert.strictEqual(w.__sora.cobroHoy().total, cotizarSeleccion(s).totalCentavos);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.__sora.lineasCobro().map(l => [l.k, l.v]))), porLinea(cotizarSeleccion(s)));
    w.setBill('anu');
    assert.strictEqual(w.__sora.cobroHoy().total, cotizarSeleccion({ ...s, facturacion: 'anual' }).totalCentavos);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(w.__sora.lineasCobro().map(l => [l.k, l.v]))), porLinea(cotizarSeleccion({ ...s, facturacion: 'anual' })));
  });
  await t('pide prioridad antes de contratar', () => {
    w.convertir();
    assert.strictEqual(S.captura, false); assert(S.prio.falta);
    w.elegirPrimero('documentos'); w.listoPrio();
  });
  await t('modal: valida correo y manda la selección (no el monto) a /api/checkout', async () => {
    w.convertir();
    assert(d.querySelector('.modal').textContent.includes('Ir a pagar'));
    w.setLead('email', 'mal'); await w.enviarLead();
    assert(S.leadErr); assert.strictEqual(peticiones.length, 0);
    w.setLead('email', 'ana@empresa.mx'); w.setLead('empresa', 'Empresa SA');
    await w.enviarLead(); await espera(20);
    assert.strictEqual(peticiones.length, 1);
    const b = peticiones[0].body;
    assert.strictEqual(peticiones[0].url, '/api/checkout');
    assert.strictEqual(b.seleccion.facturacion, 'anual'); assert.strictEqual(b.seleccion.empleados, 35);
    assert.strictEqual(b.lead.email, 'ana@empresa.mx'); assert.strictEqual(b.atribucion.utm_source, 'meta');
    assert.strictEqual(b.prioridad.sora_go_modulo_prioritario, 'expediente');
    assert(!('unit_amount' in b.seleccion) && !('precio' in b.seleccion));
  });
  await t('guarda la configuración y la recupera con ?retomar=1', async () => {
    const guardado = w.sessionStorage.getItem('sora_calc1_estado');
    assert(guardado);
    const dom2 = new JSDOM(html.replace(/<link[^>]+fonts[^>]+>/g, ''), { url: 'https://ejemplo.sora.mx/calculadora1.html?retomar=1', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(w2) { w2.scrollTo = () => {}; w2.HTMLElement.prototype.scrollIntoView = () => {}; w2.sessionStorage.setItem('sora_calc1_estado', guardado); } });
    const w2 = dom2.window;
    assert.strictEqual(w2.eval('PASOS[S.paso]'), 'calc');
    assert.strictEqual(w2.__sora.S.emp, 35); assert.strictEqual(w2.__sora.S.bill, 'anu');
    assert.strictEqual(w2.__sora.cobroHoy().total, w.__sora.cobroHoy().total);
    dom2.window.close();
  });
  await t('error del backend se muestra en el modal y reactiva el botón', async () => {
    S.enviando = false;
    w.fetch = async () => ({ ok: false, json: async () => ({ error: 'El total cambió. Recarga la página para ver tu total vigente.' }) });
    w.convertir(); await w.enviarLead(); await espera(20);
    assert(d.querySelector('.modal-err').textContent.includes('El total cambió')); assert.strictEqual(S.enviando, false);
  });
  await t('Enterprise (≥100) no ve calculadora ni pago', () => {
    S.captura = false; S.emp = 150; w.render();   // estando en la calculadora, pasa a 100+ colaboradores
    assert.strictEqual(w.eval('PASOS[S.paso]'), 'resultado');
    assert(!d.getElementById('app').textContent.includes('Contratar y pagar'));
    assert(d.getElementById('app').textContent.includes('Hablar con Linda'));
  });
  dom.window.close();

  console.log('\nServidor local');
  const server = require('./dev-server.js');
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await t('sirve calculadora1, éxito y cancelado', async () => {
    for (const p of ['/calculadora1.html', '/exito.html', '/cancelado.html', '/estilo-pago.css']) assert.strictEqual((await fetch(base + p)).status, 200, p);
    assert.strictEqual((await fetch(base + '/../package.json')).status, 404);
  });
  await t('enruta /api/checkout', async () => {
    const r = await fetch(base + '/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo()) });
    assert.strictEqual(r.status, 200);
  });
  server.close();

  console.log(`\n${ok} pruebas pasaron${process.exitCode ? ', con fallas' : ''}.`);
})();
