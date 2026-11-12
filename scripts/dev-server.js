#!/usr/bin/env node
// Servidor local: sirve public/ y enruta /api/* a los mismos handlers que usa Vercel.
//   node scripts/dev-server.js        → http://localhost:3000/calculadora1.html
// Lee variables de .env si existe (sin dependencias).
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const envPath = path.join(raiz, '.env');
if (fs.existsSync(envPath)) {
  for (const linea of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const rutas = {
  '/api/checkout': require('../api/checkout.js'),
  '/api/webhook': require('../api/webhook.js'),
  '/api/session': require('../api/session.js'),
};
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const publico = path.join(raiz, 'public');

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (rutas[pathname]) {
    try { await rutas[pathname](req, res); }
    catch (e) { console.error(e); if (!res.headersSent) { res.statusCode = 500; res.end('error'); } }
    return;
  }
  const rel = pathname === '/' ? '/calculadora1.html' : pathname;
  const archivo = path.normalize(path.join(publico, rel));
  if (!archivo.startsWith(publico) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    res.statusCode = 404; return res.end('No encontrado');
  }
  res.setHeader('Content-Type', tipos[path.extname(archivo)] || 'application/octet-stream');
  fs.createReadStream(archivo).pipe(res);
});

const port = Number(process.env.PORT) || 3000;
if (require.main === module) {
  server.listen(port, () => console.log(`calculadora1 en http://localhost:${port}/calculadora1.html`));
}
module.exports = server;
