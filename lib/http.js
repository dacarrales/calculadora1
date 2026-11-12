// Utilidades HTTP portables: funcionan igual en Vercel (Node) y en scripts/dev-server.js.
'use strict';

function leerCrudo(req, limite = 1_000_000) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tam = 0;
    req.on('data', c => {
      tam += c.length;
      if (tam > limite) { reject(Object.assign(new Error('Cuerpo demasiado grande'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function leerJson(req) {
  // Vercel puede haber parseado ya el cuerpo; si no, lo leemos del stream.
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const crudo = await leerCrudo(req);
  if (!crudo.length) return {};
  try { return JSON.parse(crudo.toString('utf8')); }
  catch (e) { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

function enviar(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

// URL pública del sitio: PUBLIC_BASE_URL manda; si no, se arma con el host de la petición.
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

module.exports = { leerCrudo, leerJson, enviar, baseUrl };
