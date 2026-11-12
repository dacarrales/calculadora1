// Valida la selección que manda la calculadora y calcula el cobro con el MISMO motor que la página.
// El navegador nunca decide el monto: este módulo es la única fuente del importe que se cobra.
'use strict';

const SoraPricingFactory = require('./pricing-engine.js');
const CFG = require('./pricing-config.json');

const SP = SoraPricingFactory(CFG);
const IVA_TASA = 0.16;   // debe coincidir con el Tax Rate de Stripe (STRIPE_TAX_RATE_IVA)

// Nombres que ve el cliente en Stripe (mismos que la calculadora).
const MODULOS = { documentos: 'Expedientes digitales', recibos: 'Recibos de nómina', reloj: 'Reloj checador', vacaciones: 'Vacaciones y ausencias' };
const INCLUIDOS = { ausencias: 'Gestión de ausencias', demandas: 'Gestión de demandas', ia: 'Asistente de IA laboral', integraciones: 'Integraciones API y SSO' };

// Desglose mensual por solución — misma lógica que lineas() de la calculadora. Suma exacto al total del motor.
function lineasMensuales(plan, e, sel) {
  const L = [];
  const mods = (sel.documentos ? 1 : 0) + (sel.recibos ? 1 : 0);
  const m1 = SP.planMensual(plan, e, 1).total;
  if (sel.documentos) L.push({ k: 'documentos', v: m1 });
  if (sel.recibos) L.push({ k: 'recibos', v: sel.documentos ? SP.planMensual(plan, e, 2).total - m1 : m1 });
  if (sel.reloj) L.push({ k: 'reloj', v: SP.relojMensual(e, mods > 0, plan).total });
  if (sel.vacaciones) L.push({ k: 'vacaciones', v: SP.complementosMensual(['vacaciones'], e).total });
  return L;
}
// Pago anual por solución: cada línea ×12 con el descuento anual, en pesos enteros.
// El residuo de redondeo va a la línea más grande para que la suma sea exacto el anualTotal12 del motor.
function repartirAnual(L, totalAnual) {
  const f = 12 * (1 - CFG.descuentoAnual);
  const out = L.map(l => ({ ...l, anual: Math.round(l.v * f) }));
  const dif = totalAnual - out.reduce((s, l) => s + l.anual, 0);
  if (dif && out.length) { const i = out.reduce((bi, l, j) => (l.anual > out[bi].anual ? j : bi), 0); out[i].anual += dif; }
  return out;
}
// Lo incluido sin costo — misma regla que incluidos() de la calculadora.
function incluidos(plan, sel) {
  const L = [];
  if (sel.documentos || sel.recibos) L.push('ausencias');
  if (sel.documentos) L.push('demandas');
  L.push('ia');
  if (plan === 'pro') L.push('integraciones');
  return L;
}

class ErrorSeleccion extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const bool = (v, campo) => {
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw new ErrorSeleccion(`"${campo}" debe ser true o false`);
  return v;
};

/**
 * @param {object} b  { empleados, plan, documentos, recibos, reloj, vacaciones, facturacion }
 * @returns cotización + importes en centavos (MXN)
 */
function cotizarSeleccion(b) {
  if (!b || typeof b !== 'object') throw new ErrorSeleccion('Selección vacía');

  const empleados = Number(b.empleados);
  if (!Number.isInteger(empleados) || empleados < 1) throw new ErrorSeleccion('Número de colaboradores inválido');
  if (empleados > CFG.soraGoHasta) {
    throw new ErrorSeleccion(`Sora Go es para empresas de hasta ${CFG.soraGoHasta} colaboradores`);
  }

  const plan = String(b.plan || '').toLowerCase();
  if (!CFG.planes.includes(plan)) throw new ErrorSeleccion('Plan inválido');

  const facturacion = b.facturacion === 'anual' ? 'anual' : b.facturacion === 'mensual' ? 'mensual' : null;
  if (!facturacion) throw new ErrorSeleccion('Facturación inválida (mensual | anual)');

  const sel = {
    documentos: bool(b.documentos, 'documentos'),
    recibos: bool(b.recibos, 'recibos'),
    reloj: bool(b.reloj, 'reloj'),
    vacaciones: bool(b.vacaciones, 'vacaciones'),
  };
  if (!sel.documentos && !sel.recibos && !sel.reloj) {
    throw new ErrorSeleccion('Se necesita Expedientes, Recibos o Reloj checador');
  }

  // Mismo input que arma la calculadora: Ausencias siempre va (el motor la marca incluida sin costo).
  const q = SP.cotiza({
    empleados,
    plan,
    documentos: sel.documentos,
    recibos: sel.recibos,
    reloj: sel.reloj,
    complementos: ['ausencias', ...(sel.vacaciones ? ['vacaciones'] : [])],
    facturacion,
  });

  const anual = facturacion === 'anual';
  const subtotal = anual ? q.anualTotal12 : q.totalMensual;   // pesos enteros, sin IVA

  // Desglose por solución: es lo que se manda a Stripe, un renglón por módulo.
  const mens = lineasMensuales(q.planAplicado, empleados, sel);
  if (mens.reduce((x, l) => x + l.v, 0) !== q.totalMensual) throw new Error('El desglose no cuadra con el total del motor');
  const conAnual = anual ? repartirAnual(mens, q.anualTotal12) : mens;
  const lineas = conAnual.map(l => {
    const pesos = anual ? l.anual : l.v;
    return { k: l.k, nombre: MODULOS[l.k], mensual: l.v, importeCentavos: pesos * 100, ivaCentavos: Math.round(pesos * 100 * IVA_TASA) };
  });
  const subtotalCentavos = lineas.reduce((x, l) => x + l.importeCentavos, 0);
  if (subtotalCentavos !== Math.round(subtotal * 100)) throw new Error('El desglose anual no cuadra con el total del motor');
  // Stripe calcula el IVA por renglón; como los importes son pesos enteros, el 16% es exacto en centavos.
  const ivaCentavos = lineas.reduce((x, l) => x + l.ivaCentavos, 0);
  const totalCentavos = subtotalCentavos + ivaCentavos;

  return {
    seleccion: { empleados, plan: q.planAplicado, facturacion, ...sel },
    planSolicitado: plan,
    planForzado: q.planForzado,
    intervalo: anual ? 'year' : 'month',
    lineas,
    incluidos: incluidos(q.planAplicado, sel).map(k => ({ k, nombre: INCLUIDOS[k] })),
    totalMensualSinIva: q.totalMensual,
    subtotalCentavos,
    ivaCentavos,
    totalCentavos,
    pisoAplicado: q.pisoAplicado,
    versionPricing: CFG.version,
  };
}

module.exports = { cotizarSeleccion, ErrorSeleccion, IVA_TASA, CFG, SP, MODULOS, INCLUIDOS, lineasMensuales, repartirAnual };
