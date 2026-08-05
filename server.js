const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { google } = require('googleapis');
const Stripe = require('stripe');
const rateLimit = require('express-rate-limit');

const app = express();

// ── CONFIGURACIÓN ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// Tu email = acceso gratis e ilimitado, siempre. Se compara en minúsculas.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase().trim();
const GOOGLE_KEY_FILE = '/etc/secrets/google-service-account.json';
const SHEET_RANGE = 'Sheet1!A:D'; // email | creditos | plan_json | actualizado

if (!ANTHROPIC_KEY) {
  console.error('❌ ANTHROPIC_API_KEY no está configurada en Render.');
  process.exit(1);
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ── GOOGLE SHEETS: helpers ──
let sheetsClientPromise = null;
function getSheetsClient() {
  if (!sheetsClientPromise) {
    sheetsClientPromise = (async () => {
      const auth = new google.auth.GoogleAuth({
        keyFile: GOOGLE_KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const client = await auth.getClient();
      return google.sheets({ version: 'v4', auth: client });
    })();
  }
  return sheetsClientPromise;
}

// Busca la fila de un email. Devuelve null si no existe todavía.
async function findUserRow(email) {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: SHEET_RANGE,
  });
  const rows = resp.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = (rows[i][0] || '').toLowerCase().trim();
    if (rowEmail === email) {
      return {
        rowNumber: i + 1,
        email: rows[i][0],
        creditos: parseInt(rows[i][1] || '0', 10) || 0,
        planJson: rows[i][2] || '',
        actualizado: rows[i][3] || '',
      };
    }
  }
  return null;
}

// Crea o actualiza la fila de un email.
async function saveUserRow(rowNumber, { email, creditos, planJson, actualizado }) {
  const sheets = await getSheetsClient();
  const values = [[email, creditos, planJson, actualizado]];
  if (rowNumber) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `Sheet1!A${rowNumber}:D${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });
  }
}

// ── WEBHOOK DE STRIPE ──
// OJO: tiene que declararse ANTES de app.use(express.json()), porque Stripe
// necesita el cuerpo de la petición en bruto (sin parsear) para comprobar la firma.
// Guarda los IDs de eventos de Stripe ya procesados, para no sumar créditos dos
// veces si Stripe reenvía el mismo aviso de pago (esto pasa si el servidor tarda
// en responder, por ejemplo al "despertar" tras estar dormido en Render).
const eventosStripeProcesados = new Set();
const LIMITE_EVENTOS_GUARDADOS = 2000; // evita que la lista crezca sin límite

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error('❌ Stripe no está configurado (falta STRIPE_SECRET_KEY o STRIPE_WEBHOOK_SECRET).');
    return res.status(500).send('Stripe no configurado');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Firma de webhook de Stripe inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (eventosStripeProcesados.has(event.id)) {
    console.log(`↩️ Evento de Stripe repetido, ignorado (ya se procesó): ${event.id}`);
    return res.json({ received: true, duplicado: true });
  }
  eventosStripeProcesados.add(event.id);
  if (eventosStripeProcesados.size > LIMITE_EVENTOS_GUARDADOS) {
    // Quita el más antiguo (el primero que se añadió) para no crecer sin límite
    eventosStripeProcesados.delete(eventosStripeProcesados.values().next().value);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = (session.customer_details?.email || session.customer_email || '')
      .toLowerCase().trim();

    if (!email) {
      console.error('⚠️ Pago completado sin email asociado, no se pueden asignar créditos.');
      return res.json({ received: true });
    }

    // Créditos según qué precio se compró exactamente (no según el importe,
    // porque puede haber dos productos al mismo precio con distintos créditos).
    const CREDITOS_POR_PRECIO = {
      'price_1TdSXVCsjCisiQFirtRX9QRt': 5, // 9,99€ — Acceso
      'price_1TdSk6CsjCisiQFiz8CLaJj6': 5, // 4,99€ — Recarga
      'price_1TvHEgCsjCisiQFioZ91ZOpP': 3, // 5,00€ — Alumnas
    };

    let creditosAAnadir = 0;
    try {
      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      for (const item of lineItems.data) {
        const priceId = item.price?.id;
        const creditosPorUnidad = CREDITOS_POR_PRECIO[priceId];
        if (creditosPorUnidad === undefined) {
          console.error(`⚠️ Precio desconocido en un pago (${priceId}): no se han asignado créditos automáticamente. Revisar a mano.`);
          continue;
        }
        creditosAAnadir += creditosPorUnidad * (item.quantity || 1);
      }
    } catch (err) {
      console.error('❌ No se pudieron leer los productos comprados en la sesión de Stripe:', err);
      return res.json({ received: true });
    }

    if (creditosAAnadir <= 0) {
      console.error(`⚠️ Pago de ${email} recibido pero no se identificaron créditos a asignar. Revisar a mano.`);
      return res.json({ received: true });
    }

    try {
      const existente = await findUserRow(email);
      const ahora = new Date().toISOString();
      if (existente) {
        await saveUserRow(existente.rowNumber, {
          email,
          creditos: existente.creditos + creditosAAnadir,
          planJson: existente.planJson,
          actualizado: ahora,
        });
      } else {
        await saveUserRow(null, {
          email,
          creditos: creditosAAnadir,
          planJson: '',
          actualizado: ahora,
        });
      }
      console.log(`✓ Créditos añadidos: ${email} +${creditosAAnadir}`);
    } catch (err) {
      console.error('❌ Error al añadir créditos tras el pago:', err);
      // No devolvemos error 500 a Stripe para evitar reintentos duplicados;
      // esto queda registrado en los logs de Render para revisarlo a mano.
    }
  }

  res.json({ received: true });
});

// ── Middlewares normales (para el resto de rutas) ──
const ORIGENES_PERMITIDOS = [
  'https://move-and-build.onrender.com',
  // Cuando conectes tu dominio propio (ej. app.jocyfk.com), añádelo aquí también.
];
app.use(cors({
  origin: function (origin, callback) {
    // Sin "origin" = petición directa (curl, apps móviles, Postman) — se permite.
    // Con "origin" = viene de un navegador desde una web concreta — solo la tuya.
    if (!origin || ORIGENES_PERMITIDOS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false); // rechazo limpio, sin tirar la petición como error 500
    }
  }
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static('.'));

// Límite de peticiones a /api/claude (la que gasta tokens de Anthropic): máximo
// 10 planes por IP cada hora. Corta en seco a un script o bot que intente
// generar muchos planes seguidos a tu costa.
const limitadorGeneracion = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones desde esta conexión. Inténtalo de nuevo más tarde.' },
});

// ── GENERAR PLAN ──
app.post('/api/claude', limitadorGeneracion, async (req, res) => {
  try {
    const { prompt, email } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Falta parámetro "prompt"' });
    if (!email) return res.status(400).json({ error: 'Falta parámetro "email"' });

    const emailNorm = email.toLowerCase().trim();
    const esPropietaria = OWNER_EMAIL && emailNorm === OWNER_EMAIL;
    console.log(`→ POST /api/claude | email=${emailNorm} | propietaria=${esPropietaria}`);

    let userRow = null;
    if (!esPropietaria) {
      userRow = await findUserRow(emailNorm);
      const creditosDisponibles = userRow ? userRow.creditos : 0;
      console.log(`  créditos disponibles para ${emailNorm}: ${creditosDisponibles}`);
      if (creditosDisponibles < 1) {
        console.log(`  ✗ Rechazado por falta de créditos: ${emailNorm}`);
        return res.status(402).json({
          error: 'No te quedan créditos disponibles. Compra un plan para poder generar uno nuevo.',
        });
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 32000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error });
    }

    const data = await response.json();
    const message = data.content?.[0]?.text || '';

    // Guarda el plan y descuenta el crédito (si no es la propietaria)
    const ahora = new Date().toISOString();
    try {
      if (esPropietaria) {
        const ownerRow = await findUserRow(emailNorm);
        await saveUserRow(ownerRow ? ownerRow.rowNumber : null, {
          email: emailNorm,
          creditos: ownerRow ? ownerRow.creditos : 0, // no se usa para la propietaria, pero se guarda por si acaso
          planJson: message,
          actualizado: ahora,
        });
      } else {
        await saveUserRow(userRow.rowNumber, {
          email: emailNorm,
          creditos: userRow.creditos - 1,
          planJson: message,
          actualizado: ahora,
        });
      }
      console.log(`  ✓ Plan guardado en Sheets para ${emailNorm} (${ahora})`);
    } catch (err) {
      // Si falla el guardado en Sheets, el plan ya se generó: se lo damos igual
      // a la usuaria y solo avisamos en los logs, para no hacerle perder el plan que pagó.
      console.error(`  ✗ El plan de ${emailNorm} se generó pero NO se pudo guardar en Sheets:`, err.message);
    }

    res.json({ message });
  } catch (err) {
    console.error('Error en /api/claude:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── RECUPERAR PLAN Y CRÉDITOS (para abrir desde otro dispositivo) ──
// ── GUARDAR CAMBIOS EN EL PLAN (ej. sustituir un ejercicio) ──
// No llama a Anthropic ni descuenta créditos: solo persiste un plan ya existente
// que la persona ha editado en el navegador (ej. cambiar un ejercicio por otro).
app.post('/api/guardar-plan', async (req, res) => {
  try {
    const { email, plan } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta parámetro "email"' });
    if (!plan) return res.status(400).json({ error: 'Falta parámetro "plan"' });

    const emailNorm = email.toLowerCase().trim();
    const row = await findUserRow(emailNorm);
    const ahora = new Date().toISOString();

    if (row) {
      await saveUserRow(row.rowNumber, {
        email: emailNorm,
        creditos: row.creditos,
        planJson: plan,
        actualizado: ahora,
      });
    } else {
      // No debería ocurrir normalmente (implicaría editar un plan sin haberlo
      // generado antes), pero se guarda igualmente por seguridad.
      await saveUserRow(null, { email: emailNorm, creditos: 0, planJson: plan, actualizado: ahora });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error en /api/guardar-plan:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/plan', async (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Falta parámetro "email"' });

    console.log(`→ GET /api/plan | email=${email}`);

    const esPropietaria = OWNER_EMAIL && email === OWNER_EMAIL;
    const row = await findUserRow(email);

    if (!row) {
      console.log(`  sin fila para ${email} (usuaria nueva o email distinto al guardado)`);
      return res.json({ plan: null, creditos: esPropietaria ? null : 0 });
    }

    console.log(`  ✓ fila encontrada para ${email} | tiene plan: ${!!row.planJson} | créditos: ${row.creditos}`);

    res.json({
      plan: row.planJson || null,
      creditos: esPropietaria ? null : row.creditos,
      actualizado: row.actualizado || null,
    });
  } catch (err) {
    console.error(`✗ Error en /api/plan para email consultado:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
