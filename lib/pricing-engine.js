// Motor de pricing de Sora — ÚNICA implementación en JS.
// No se edita a mano en ningún consumidor: build.js lo inyecta en la
// calculadora (index.html) y en el script del skill reunion-comercial.
// Los números viven en pricing-config.json. La fuente de verdad es el Sheet.
(function (root, factory) {
  root.SoraPricingFactory = factory;
  if (typeof module === 'object' && module.exports) module.exports = factory;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CFG) {
  'use strict';

  // Redondeo "half up" (igual que Math.round para positivos y que el Sheet).
  const R = x => Math.floor(x + 0.5 + 1e-9);
  const PLANES = CFG.planes;
  const rank = p => PLANES.indexOf(p);

  function bracket(e) {
    for (const b of CFG.brackets) if (e >= b.min && e <= b.max) return b;
    return CFG.brackets[CFG.brackets.length - 1];
  }

  function fracStack(e) {
    const m1 = bracket(e).m1;
    return Object.values(CFG.fracStack)
      .reduce((s, f) => s + Math.max(CFG.fracStackMinimo, R(m1 * f)), 0);
  }

  // Precio por empleado del plan en el bracket de e (pesos enteros).
  function nucleo(plan, e, modulos) {
    const b = bracket(e);
    const base = modulos >= 2 ? b.m2 : b.m1;
    return R((base - fracStack(e)) * CFG.factorPlan[plan]);
  }

  // Candado de monotonía: el total nunca baja al agregar empleados.
  // Evalúa el total "como si" e estuviera en el techo de cada bracket
  // anterior y toma el máximo.
  function conCandado(fnTotal, e, brackets) {
    let v = fnTotal(e), candado = false;
    for (const b of (brackets || CFG.brackets)) {
      if (b.min > e) break;
      const x = Math.min(e, b.max);
      const t = fnTotal(x);
      if (t > v) { v = t; candado = true; }
    }
    return { total: v, candado };
  }

  function complementoPorEmp(clave, e) {
    const c = CFG.complementos[clave];
    if (c.incluido) return 0;   // incluido sin costo (Ausencias desde 14-oct-2026)
    return Math.max(c.minimo, R(bracket(e).m1 * c.pctM1));
  }

  // Reloj checador: tabla propia por tramo, con candado. Con módulo: igual en los planes.
  // Solo reloj: PRO usa soloPro y con ≤99 empleados aplica el piso del plan (Diego 28-oct-2026).
  function relojPorEmp(e, conModulo, plan = 'estandar') {
    const bs = CFG.relojChecador.brackets;
    let b = bs[bs.length - 1];
    for (const x of bs) if (e >= x.min && e <= x.max) { b = x; break; }
    if (conModulo) return b.conModulo;
    return plan === 'pro' ? b.soloPro : b.solo;
  }
  function relojMensual(e, conModulo, plan = 'estandar') {
    const r = conCandado(x => x * relojPorEmp(x, conModulo, plan), e, CFG.relojChecador.brackets);
    let total = r.total, piso = false;
    if (!conModulo && e <= CFG.piso.hastaEmpleados && CFG.piso[plan] > total) { total = CFG.piso[plan]; piso = true; }
    return { total, candado: r.candado, porEmp: relojPorEmp(e, conModulo, plan), piso };
  }

  function planMensual(plan, e, modulos) {
    if (!modulos) return { total: 0, candado: false, piso: false };   // solo reloj checador: sin módulo, sin piso
    const r = conCandado(x => x * nucleo(plan, x, modulos), e);
    let total = r.total, piso = false;
    if (e <= CFG.piso.hastaEmpleados) {
      // El piso cubre UN módulo. El 2º módulo se cobra encima a su precio normal (Diego 16-oct-2026).
      const r1 = modulos >= 2 ? conCandado(x => x * nucleo(plan, x, 1), e).total : r.total;
      if (CFG.piso[plan] > r1) { total = CFG.piso[plan] + (r.total - r1); piso = true; }
    }
    return { total, candado: r.candado, piso };
  }

  function complementosMensual(claves, e) {
    if (!claves.length) return { total: 0, candado: false, porEmp: 0 };
    const porEmpEn = x => claves.reduce((s, k) => s + complementoPorEmp(k, x), 0);
    const r = conCandado(x => x * porEmpEn(x), e);
    return { total: r.total, candado: r.candado, porEmp: porEmpEn(e) };
  }

  // Plan mínimo que exige la selección + por qué.
  function planMinimo(sel) {
    const razones = [];
    let min = PLANES[0];
    const sube = (p, razon) => { if (p && rank(p) > rank(min)) min = p; if (p && rank(p) > 0) razones.push(razon); };
    for (const k of sel.complementos) sube(CFG.complementos[k].planMinimo, CFG.complementos[k].nombre + ' requiere Estándar o superior');
    if (sel.demandas) sube(CFG.demandas.planMinimo, 'Demandas se incluye desde Estándar');
    if (sel.recibos && !sel.documentos) sube(CFG.recibosSinDocumentos.planMinimo, 'Recibos sin Documentos requiere Estándar o superior');
    return { plan: min, razones };
  }

  function normaliza(input) {
    const e = parseInt(input.empleados, 10);
    if (!(e >= 1)) throw new Error('empleados debe ser un entero >= 1');
    const plan = (input.plan || 'pro').toLowerCase();
    if ((CFG.planesDescontinuados || {})[plan]) throw new Error(CFG.planesDescontinuados[plan]);
    if (rank(plan) < 0) throw new Error('plan inválido: ' + plan + ' (estandar | pro)');
    const documentos = input.documentos !== undefined ? !!input.documentos : true;
    const recibos = !!input.recibos;
    const reloj = !!input.reloj;
    if (!documentos && !recibos && !reloj) throw new Error('Se necesita Documentos, Recibos o Reloj checador');
    const complementos = [];
    for (const k of (input.complementos || [])) {
      const key = String(k).toLowerCase();
      if (CFG.descontinuados.includes(key)) throw new Error('"' + key + '" está descontinuado desde 27-ago-2026');
      if (key === 'demandas') continue; // se maneja con el flag demandas
      if (!CFG.complementos[key]) throw new Error('complemento desconocido: ' + key);
      if (!complementos.includes(key)) complementos.push(key);
    }
    let demandas = !!input.demandas || (input.complementos || []).map(String).map(s => s.toLowerCase()).includes('demandas');
    const avisos = [];
    if (demandas && !documentos) { demandas = false; avisos.push('Demandas requiere Documentos; se ignoró'); }
    const facturacion = (input.facturacion || 'mensual').toLowerCase().startsWith('anu') ? 'anual' : 'mensual';
    const incluidos = complementos.filter(k => CFG.complementos[k].incluido);
    return { empleados: e, plan, documentos, recibos, reloj, complementos: complementos.filter(k => !CFG.complementos[k].incluido), incluidos, demandas, facturacion, avisos };
  }

  function cotiza(input) {
    const s = normaliza(input);
    const e = s.empleados;
    const modulos = (s.documentos ? 1 : 0) + (s.recibos ? 1 : 0);
    const min = planMinimo(s);
    const planAplicado = rank(s.plan) < rank(min.plan) ? min.plan : s.plan;
    const forzado = planAplicado !== s.plan;

    const p = planMensual(planAplicado, e, modulos);
    const c = complementosMensual(s.complementos, e);
    const rl = s.reloj ? relojMensual(e, modulos > 0, planAplicado) : { total: 0, candado: false, porEmp: 0, piso: false };
    const totalMensual = p.total + c.total + rl.total;
    const anualPorMes = R(totalMensual * (1 - CFG.descuentoAnual));

    const porPlan = {};
    for (const pl of PLANES) {
      const disponible = rank(pl) >= rank(min.plan);
      const pm = planMensual(pl, e, modulos);
      const t = pm.total + c.total + (s.reloj ? relojMensual(e, modulos > 0, pl).total : 0);
      porPlan[pl] = { disponible, totalMensual: t, anualPorMes: R(t * (1 - CFG.descuentoAnual)), planMensual: pm.total };
    }

    return {
      empleados: e,
      segmento: e <= CFG.soraGoHasta ? 'Sora Go' : 'Enterprise',
      documentos: s.documentos, recibos: s.recibos, modulos,
      complementos: s.complementos,
      complementosIncluidos: s.incluidos,
      demandasIncluida: s.demandas,
      planSolicitado: s.plan,
      planAplicado,
      planForzado: forzado,
      razonesPlan: forzado ? min.razones : [],
      avisos: s.avisos,
      nucleoPorEmp: modulos ? nucleo(planAplicado, e, modulos) : 0,
      complementosPorEmp: c.porEmp,
      planMensual: p.total,
      complementosMensual: c.total,
      relojChecador: s.reloj,
      relojPorEmp: rl.porEmp,
      relojMensual: rl.total,
      totalMensual,                                   // = MRR
      anualPorMes,                                    // −15% sobre el total, redondeado al final
      anualTotal12: anualPorMes * 12,
      porEmpMensual: totalMensual / e,
      porEmpAnual: (totalMensual * (1 - CFG.descuentoAnual)) / e,
      facturacion: s.facturacion,
      totalSegunFacturacion: s.facturacion === 'anual' ? anualPorMes : totalMensual,
      candadoAplicado: p.candado || c.candado || rl.candado,
      pisoAplicado: p.piso || rl.piso,
      porPlan,
      versionConfig: CFG.version
    };
  }

  return { cotiza, bracket, nucleo, planMensual, complementoPorEmp, complementosMensual, relojPorEmp, relojMensual, planMinimo, R, config: CFG };
});
