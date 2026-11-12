// Catálogo de productos de Stripe para el desglose por módulo.
// Cada renglón del cobro apunta a un producto creado por scripts/setup-stripe.js, identificado por metadata.sora_key:
//   go_estandar_documentos · go_pro_reloj · …   (módulos con precio, uno por plan)
//   go_incluido_ausencias · go_incluido_ia · …  (incluidos sin costo, renglón en $0)
'use strict';

const { MODULOS, INCLUIDOS } = require('./cotizar.js');

const NOMBRE_PLAN = { estandar: 'Estándar', pro: 'PRO' };

// Lo que debe existir en Stripe (lo usa setup-stripe.js para crear y checkout.js para buscar).
function catalogo() {
  const L = [];
  for (const plan of Object.keys(NOMBRE_PLAN)) {
    for (const [k, nombre] of Object.entries(MODULOS)) {
      L.push({ sora_key: `go_${plan}_${k}`, name: `${nombre} · Sora Go ${NOMBRE_PLAN[plan]}`, description: `Sora Go plan ${NOMBRE_PLAN[plan]} · ${nombre}` });
    }
  }
  for (const [k, nombre] of Object.entries(INCLUIDOS)) {
    L.push({ sora_key: `go_incluido_${k}`, name: `${nombre} (incluido)`, description: 'Incluido sin costo en tu plan Sora Go' });
  }
  return L;
}

let cache = null, cacheEn = 0;
async function mapaProductos(stripe) {
  if (cache && Date.now() - cacheEn < 10 * 60 * 1000) return cache;
  const m = {};
  for await (const p of stripe.products.list({ active: true, limit: 100 })) {
    if (p.metadata && p.metadata.sora_key) m[p.metadata.sora_key] = p.id;
  }
  cache = m; cacheEn = Date.now();
  return m;
}

async function productoDe(stripe, sora_key) {
  let m = await mapaProductos(stripe);
  if (!m[sora_key]) { cache = null; m = await mapaProductos(stripe); }   // por si se acaba de correr el setup
  if (!m[sora_key]) throw Object.assign(new Error(`Falta el producto ${sora_key} en Stripe. Corre npm run setup:stripe.`), { status: 500, interno: true });
  return m[sora_key];
}

function _limpiarCache() { cache = null; }

module.exports = { catalogo, productoDe, NOMBRE_PLAN, _limpiarCache };
