#!/usr/bin/env node
// Crea (o reutiliza) en Stripe lo que necesita calculadora1 y te imprime las variables de entorno.
//   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js [https://tu-dominio]
// Si pasas la URL pública, también registra el endpoint de webhooks.
// Es seguro correrlo varias veces: busca por metadata.sora_key antes de crear.
'use strict';

const Stripe = require('stripe');
const { catalogo } = require('../lib/productos.js');

const key = process.env.STRIPE_SECRET_KEY || '';
const live = key.startsWith('sk_live_');
if (!key.startsWith('sk_test_') && !live) { console.error('Define STRIPE_SECRET_KEY (sk_test_...)'); process.exit(1); }
if (live && !process.argv.includes('--live')) { console.error('Es una clave LIVE. Si de verdad es para producción, agrega --live.'); process.exit(1); }

const stripe = new Stripe(key);
const urlPublica = process.argv.slice(2).find(a => /^https:\/\//.test(a));

const EVENTOS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_failed', 'customer.subscription.updated', 'customer.subscription.deleted'];

async function productos() {
  const existentes = {};
  for await (const p of stripe.products.list({ limit: 100, active: true })) if (p.metadata && p.metadata.sora_key) existentes[p.metadata.sora_key] = p;
  const creados = [];
  for (const it of catalogo()) {
    if (existentes[it.sora_key]) continue;
    creados.push(await stripe.products.create({ name: it.name, description: it.description, metadata: { sora_key: it.sora_key } }));
  }
  return { total: catalogo().length, creados: creados.length };
}

async function ivaRate() {
  const lista = await stripe.taxRates.list({ limit: 100, active: true });
  const hay = lista.data.find(t => t.metadata && t.metadata.sora_key === 'iva_mx_16');
  if (hay) return hay;
  return stripe.taxRates.create({
    display_name: 'IVA', description: 'IVA 16% México', percentage: 16, inclusive: false,
    country: 'MX', jurisdiction: 'MX', tax_type: 'vat', metadata: { sora_key: 'iva_mx_16' },
  });
}

async function webhook() {
  if (!urlPublica) return null;
  const destino = urlPublica.replace(/\/+$/, '') + '/api/webhook';
  const lista = await stripe.webhookEndpoints.list({ limit: 100 });
  const hay = lista.data.find(w => w.url === destino);
  if (hay) return { ...hay, secret: null, reutilizado: true };
  return stripe.webhookEndpoints.create({ url: destino, enabled_events: EVENTOS, description: 'Sora Go · calculadora1' });
}

(async () => {
  const prods = await productos();
  const iva = await ivaRate();
  const wh = await webhook();

  console.log(`\nListo (${live ? 'LIVE' : 'modo de prueba'}). Copia esto a tus variables de entorno:\n`);
  console.log(`STRIPE_SECRET_KEY=${key.slice(0, 12)}…  (la que ya usaste)`);
  console.log(`# Productos del desglose por módulo: ${prods.total} en Stripe (${prods.creados} nuevos). No requieren variable: se buscan por metadata.sora_key.`);
  console.log(`STRIPE_TAX_RATE_IVA=${iva.id}`);
  if (wh && wh.secret) console.log(`STRIPE_WEBHOOK_SECRET=${wh.secret}`);
  else if (wh && wh.reutilizado) console.log('STRIPE_WEBHOOK_SECRET=  (el endpoint ya existía: copia su "Signing secret" desde el dashboard)');
  else console.log('STRIPE_WEBHOOK_SECRET=  (en local: lo imprime `stripe listen`; en Vercel: corre este script con tu URL pública)');
  if (urlPublica) console.log(`PUBLIC_BASE_URL=${urlPublica.replace(/\/+$/, '')}`);
  console.log('');
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
