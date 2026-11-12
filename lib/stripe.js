// Cliente de Stripe con candado de modo: solo acepta claves de prueba salvo que se habilite live a propósito.
'use strict';

const Stripe = require('stripe');

let cliente = null;

function modoStripe() {
  const k = process.env.STRIPE_SECRET_KEY || '';
  if (k.startsWith('sk_test_') || k.startsWith('rk_test_')) return 'test';
  if (k.startsWith('sk_live_') || k.startsWith('rk_live_')) return 'live';
  return null;
}

function getStripe() {
  if (cliente) return cliente;
  const modo = modoStripe();
  if (!modo) throw Object.assign(new Error('Falta STRIPE_SECRET_KEY'), { status: 500, interno: true });
  if (modo === 'live' && process.env.STRIPE_PERMITIR_LIVE !== 'true') {
    throw Object.assign(new Error('Clave live detectada sin STRIPE_PERMITIR_LIVE=true. Esta versión está configurada para modo de prueba.'), { status: 500, interno: true });
  }
  cliente = new Stripe(process.env.STRIPE_SECRET_KEY, { appInfo: { name: 'sora-go-calculadora1', version: '0.1.0' } });
  return cliente;
}

function requerido(nombre) {
  const v = process.env[nombre];
  if (!v) throw Object.assign(new Error(`Falta la variable de entorno ${nombre}`), { status: 500, interno: true });
  return v;
}

// Solo para pruebas automatizadas.
function _setStripeParaPruebas(fake) { cliente = fake; }

module.exports = { getStripe, modoStripe, requerido, _setStripeParaPruebas };
