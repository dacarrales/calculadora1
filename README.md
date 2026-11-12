# Sora Go · calculadora1 — Contratar y pagar con Stripe

Esta es una versión aparte del diagnóstico + calculadora de Sora Go (b7). El cliente configura su Sora, elige pago mensual o anual, ve el total con IVA desglosado y paga en Stripe Checkout. Queda una suscripción que se renueva sola.

La calculadora actual **no se tocó**. Todo vive en esta carpeta y está listo para **modo de prueba**: no se hacen cobros reales.

---

## Cómo funciona

```
calculadora1.html ──(selección, sin montos)──▶ /api/checkout ──▶ Stripe Checkout (checkout.stripe.com)
     ▲                                             │                    │
     │ ?retomar=1                                  │ recalcula con       ├─ paga ──▶ exito.html ──▶ /api/session
cancelado.html ◀───────────── cancela ─────────────┘ el motor de pricing │
                                                                         └─ eventos ──▶ /api/webhook ──▶ (reenvío a Sora)
```

1. **La página nunca decide el monto.** Manda la selección (colaboradores, plan, soluciones, mensual/anual), junto con el total que mostró y la versión de pricing.
2. **`/api/checkout` recalcula el importe** con el mismo motor de pricing (`lib/pricing-engine.js` + `lib/pricing-config.json`). Si el total o la versión no coinciden con lo que vio el cliente, no cobra y le pide recargar la página.
3. **Stripe cobra con desglose por módulo.** Cada solución contratada va como renglón propio con su IVA 16% (Expedientes, Recibos, Reloj, Vacaciones), y lo incluido sin costo aparece en $0 (Ausencias, Demandas, IA, Integraciones si es PRO). Stripe le pide RFC y dirección al cliente y crea la suscripción:
   - **Mensual:** suscripción que cobra cada mes el total del mes.
   - **Anual:** se cobra hoy la anualidad (12 meses con −15%) y se renueva cada año. El −15% se reparte por módulo en pesos enteros; el residuo de redondeo va al renglón más grande para que la suma sea exacta.

   El mismo desglose sale en el recibo de Stripe, en cada factura de renovación y en `exito.html`.
4. **`/api/webhook`** verifica la firma de Stripe, registra cada evento y, si configuras `SORA_WEBHOOK_FORWARD_URL`, lo reenvía en un JSON simple.
5. **`exito.html`** muestra lo contratado y lo pagado. **`cancelado.html`** regresa al cliente a la calculadora con su misma configuración.

| Lo que ve el cliente | Dónde |
|---|---|
| Subtotal, IVA 16% y total a cobrar hoy, más la nota de renovación | Panel "Tu inversión" y modal |
| Botón **Contratar y pagar** → modal → **Ir a pagar $X** | Calculadora |
| Tarjeta, RFC y dirección de facturación | Página de Stripe |
| Resumen, total pagado y fecha del próximo cobro | `exito.html` |

Las empresas de 100 o más colaboradores siguen igual que antes: no ven precio ni pago y pasan con Linda.

---

## Probar en tu computadora (≈15 min)

Requisitos: Node 18 o superior y la [Stripe CLI](https://docs.stripe.com/stripe-cli).

1. **Instala dependencias.**
   ```bash
   npm install
   ```
2. **Clave de prueba.** En el dashboard de Stripe activa *Test mode*, entra a Developers → API keys y copia la *Secret key* (`sk_test_...`). Copia `.env.example` a `.env` y pégala en `STRIPE_SECRET_KEY`.
3. **Crea en Stripe los productos y el IVA.** El script es seguro de repetir:
   ```bash
   npm run setup:stripe
   ```
   Crea 12 productos (cada módulo por plan, más los incluidos) y el IVA. Pega en `.env` el `STRIPE_TAX_RATE_IVA` que imprime; los productos se encuentran solos por `metadata.sora_key`.
4. **Webhooks locales.** En otra terminal:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/api/webhook
   ```
   Copia el `whsec_...` que imprime a `STRIPE_WEBHOOK_SECRET`.
5. **Levanta el sitio.**
   ```bash
   npm run dev
   ```
   Abre http://localhost:3000/calculadora1.html
6. **Compra de prueba.** Haz el diagnóstico (menos de 100 colaboradores), luego Contratar y pagar → Ir a pagar. En Stripe usa:

   | Caso | Tarjeta |
   |---|---|
   | Pago aprobado | `4242 4242 4242 4242` |
   | Requiere autenticación 3D Secure | `4000 0025 0000 3155` |
   | Rechazada | `4000 0000 0000 0002` |

   Pon cualquier fecha futura, cualquier CVC y un RFC de prueba como `XAXX010101000`.
7. **Revisa el resultado:**
   - `exito.html` con el total pagado.
   - En la terminal de `stripe listen`, los eventos `checkout.session.completed` e `invoice.paid` con respuesta 200.
   - En el dashboard, en Payments y en Subscriptions, el pago con su IVA.

**Para simular renovaciones** usa *Test clocks* en Billing → Subscriptions: adelantas el reloj un mes o un año y ves el cobro de renovación y su `invoice.paid`.

### Pruebas automáticas (sin conectarse a Stripe)
```bash
npm test
```
Son 35 pruebas. Cubren:
- que el motor y los precios del HTML sean idénticos a los del backend;
- el cálculo del servidor: mínimos, descuento anual e IVA, y que el desglose por módulo sume exacto en las 5,544 combinaciones posibles (1–99 colaboradores × planes × módulos × mensual/anual);
- el rechazo de totales manipulados;
- la firma de webhooks;
- el recorrido completo de la página hasta la redirección a Stripe;
- la recuperación de la configuración tras cancelar.

---

## Publicar en Vercel (modo de prueba)

1. Sube esta carpeta a un repo e impórtala en Vercel. No necesita *build*: `vercel.json` ya apunta a `public/`.
2. En Settings → Environment Variables agrega las variables de `.env.example` con los valores de prueba, y `PUBLIC_BASE_URL=https://tu-dominio`.
3. Registra el webhook con tu URL pública. Imprime el `STRIPE_WEBHOOK_SECRET`; agrégalo en Vercel y vuelve a desplegar.
   ```bash
   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js https://tu-dominio
   ```
4. Revisa que el webhook funcione con `stripe trigger checkout.session.completed`. En Stripe → Webhooks → tu endpoint debe salir 200.

La página queda en `https://tu-dominio/calculadora1.html`.

---

## Variables de entorno

| Variable | Qué es | De dónde sale |
|---|---|---|
| `STRIPE_SECRET_KEY` | Clave secreta. Define **a qué cuenta de Stripe entra el dinero** | Stripe → Developers → API keys |
| `STRIPE_TAX_RATE_IVA` | Tax Rate IVA 16% no incluido | `npm run setup:stripe` |
| `STRIPE_WEBHOOK_SECRET` | Firma de los webhooks | `stripe listen` o el setup con URL |
| `PUBLIC_BASE_URL` | Dominio para las URLs de éxito y cancelación | Tú |
| `SORA_WEBHOOK_FORWARD_URL` / `_SECRET` | Opcional: a dónde reenviar los eventos de pago | Dapta, Zapier o el endpoint de producto |
| `STRIPE_PERMITIR_LIVE` | Candado: sin `true`, el backend rechaza claves live | Solo en producción |

Ninguna clave vive en el HTML. Hay una prueba que verifica que no haya claves en `public/`.

---

## Pendiente para producción

### Credenciales y cuenta (bloqueante)
- [ ] **Cuenta de Stripe a nombre de Sora (persona moral), activada.** Requiere razón social, RFC, representante legal y **CLABE de Sora** en Settings → Payouts. Ahí cae el dinero.
- [ ] **Clave live en Vercel:** `STRIPE_SECRET_KEY=sk_live_...` y `STRIPE_PERMITIR_LIVE=true`.
- [ ] **Recursos en live:** correr `node scripts/setup-stripe.js https://dominio-final --live` para crear productos, IVA y webhook en live, y cargar los nuevos IDs y el `whsec_` live.
- [ ] **Flags en `public/calculadora1.html`:** `MODO_PRUEBA = false` (quita el aviso de tarjeta de prueba) y `ENVIAR_HUBSPOT = true` (crea el contacto en HubSpot al contratar).

### Configuración en el dashboard de Stripe
- [ ] **Branding:** logo, colores y nombre "Sora" en Settings → Branding. Es lo que ve el cliente al pagar.
- [ ] **Customer portal** (Settings → Billing → Customer portal), para que el cliente cambie su tarjeta, descargue recibos o cancele sin escribirle a nadie. Falta poner el enlace en `exito.html` y en los correos.
- [ ] **Cobros fallidos:** activar Smart Retries y los correos de tarjeta rechazada o por vencer (Settings → Billing → Subscriptions and emails), y definir qué pasa al agotar reintentos: cancelar o dejar impaga.
- [ ] **Términos y aviso de privacidad:** cargar las URLs en Settings → Public details. Después se puede exigir aceptación en Checkout (`consent_collection`).

### Operación (lo que el código deja listo, pero alguien tiene que conectar)
- [ ] **CFDI.** Stripe **no timbra** en México; el recibo de Stripe no es factura. El evento `invoice.paid` (acción `timbrar_cfdi`) trae RFC, subtotal, IVA y total de cada cobro, alta y renovaciones. Hay que decidir quién timbra (Facturapi u otro proveedor, o el proceso actual de cxc) y apuntar `SORA_WEBHOOK_FORWARD_URL` ahí.
- [ ] **Alta de la cuenta.** `checkout.session.completed` (acción `alta_cuenta`) trae correo, plan, soluciones, colaboradores y prioridad. Hoy `exito.html` manda al cliente a `app.sora.mx/account/crear`. Producto tiene que ligar la cuenta con la suscripción, por correo o por el ID de cliente de Stripe; si no, se empatan a mano.
- [ ] **Baja o suspensión.** Con `customer.subscription.deleted` o `updated` en estado `past_due`/`unpaid` hay que suspender la cuenta en Sora.
- [ ] **Cambio de colaboradores o de plan** después de contratar. No está implementado: requiere recalcular con el motor y actualizar el precio de la suscripción, con prorrateo.
- [ ] **Política de cancelación y reembolso** definida por Sora y publicada.

### Mantenimiento
- [ ] **Sincronizar precios.** Esta página es copia de b7, con el motor embebido. Cuando cambien los precios en el Sheet hay que regenerar **las dos cosas**: el HTML y `lib/` (lo ideal es que `build.js` genere también `calculadora1`). `npm test` falla si el HTML y el backend tienen precios distintos, y el backend rechaza cobros si la versión de pricing no coincide.
- [ ] **Reloj checador:** está a la venta en la calculadora desde hoy, pero su disponibilidad es el 15-nov-2026. Confirmar que se pueda cobrar antes de esa fecha.

---

## Archivos

```
public/calculadora1.html   Diagnóstico + calculadora con "Contratar y pagar" (copia de b7 modificada)
public/exito.html          Confirmación de pago
public/cancelado.html      Pago no completado → regresa con la configuración guardada
public/estilo-pago.css     Estilos de éxito y cancelado
api/checkout.js            Valida, recalcula y crea la Checkout Session (suscripción + IVA)
api/webhook.js             Verifica firma, resume y reenvía eventos de pago
api/session.js             Datos de la contratación para exito.html
lib/cotizar.js             Validación de la selección y cálculo de subtotal/IVA/total en centavos
lib/pricing-engine.js      Motor de pricing (idéntico al del HTML)
lib/pricing-config.json    Precios v2026-10-28b (idénticos al HTML)
lib/productos.js           Catálogo de productos por módulo (los busca en Stripe por metadata.sora_key)
lib/stripe.js              Cliente de Stripe con candado anti-live
lib/http.js                Utilidades HTTP (Vercel y servidor local)
scripts/setup-stripe.js    Crea los 12 productos, el IVA y el webhook en Stripe
scripts/dev-server.js      Servidor local
scripts/test.js            35 pruebas sin Stripe real
```

### Cambios en la página respecto a b7
- "Comenzar mi prueba gratis" pasa a **"Contratar y pagar"**, sin prueba de 30 días: el cobro es inmediato.
- Nuevo bloque **Total a cobrar hoy**: subtotal, IVA 16% y total, con la nota de renovación. El modal muestra el desglose por módulo tal como lo va a cobrar Stripe (anual: importes del año con −15%).
- El modal pide los mismos datos y lleva a Stripe en lugar de WhatsApp. Si el backend falla, el error se ve en el modal.
- Aviso de **modo de prueba** con la tarjeta 4242.
- El envío a HubSpot está apagado (`ENVIAR_HUBSPOT = false`) para no ensuciar el CRM con compras simuladas.
- Al cancelar, `?retomar=1` restaura la configuración guardada en el navegador.
