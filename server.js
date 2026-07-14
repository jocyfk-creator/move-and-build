const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');

const app = express();

// ── CORS: solo acepta peticiones desde tu dominio ──
app.use(cors({
  origin: [
    'https://move-and-build.onrender.com',
    'http://localhost:3000' // para pruebas locales
  ]
}));

// ── Claves de entorno ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

if (!ANTHROPIC_KEY) {
  console.error('❌ ANTHROPIC_API_KEY no está configurada en Render.');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('❌ STRIPE_WEBHOOK_SECRET no está configurada en Render.');
  process.exit(1);
}

// ── Créditos en memoria: email → número de planes restantes ──
// Nota: se resetea si el servidor se reinicia. Para producción real,
// se sustituiría por una base de datos. Válido para fase de lanzamiento inicial.
const credits = new Map();

// ── Rate limiting básico: máx 10 peticiones por IP cada 60 segundos ──
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  const data = rateLimitMap.get(ip);
  if (now - data.start > windowMs) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }

  if (data.count >= maxRequests) {
    return res.status(429).json({ error: 'Demasiadas peticiones. Espera un momento.' });
  }

  data.count++;
  next();
}

// ── Verificación manual de firma Stripe (sin librería externa) ──
function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',');
    const tPart = parts.find(p => p.startsWith('t='));
    if (!tPart) return false;
    const timestamp = tPart.slice(2);

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    const v1Parts = parts.filter(p => p.startsWith('v1='));
    return v1Parts.some(part => {
      const received = part.slice(3);
      try {
        return crypto.timingSafeEqual(
          Buffer.from(received, 'hex'),
          Buffer.from(expected, 'hex')
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// ── WEBHOOK DE STRIPE ──
// Necesita raw body, va ANTES de express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).json({ error: 'Falta stripe-signature' });
  }

  const isValid = verifyStripeSignature(req.body.toString(), sig, WEBHOOK_SECRET);
  if (!isValid) {
    console.error('❌ Firma de webhook inválida');
    return res.status(400).json({ error: 'Firma inválida' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = (session.customer_email || session.customer_details?.email || '').toLowerCase().trim();
    const amountTotal = session.amount_total || 0; // en céntimos

    if (email) {
      // 999 céntimos = 9,99€ (acceso inicial) → 5 planes
      // 499 céntimos = 4,99€ (recarga)        → 5 planes
      const newCredits = 5;
      const current = credits.get(email) || 0;
      credits.set(email, current + newCredits);
      console.log(`✓ Pago confirmado: ${email} | importe: ${amountTotal}¢ | créditos ahora: ${current + newCredits}`);
    } else {
      console.warn('⚠️ Webhook recibido sin email de cliente');
    }
  }

  res.json({ received: true });
});

// ── Resto de middleware (DESPUÉS del webhook) ──
app.use(express.json());
app.use(express.static('.'));

// ── ENDPOINT: consultar créditos ──
app.get('/api/credits/:email', (req, res) => {
  const email = req.params.email.toLowerCase().trim();
  const userCredits = credits.get(email) || 0;
  res.json({ email, credits: userCredits });
});

// ── ENDPOINT PRINCIPAL: /api/claude ──
app.post('/api/claude', rateLimit, async (req, res) => {
  try {
    const { model, max_tokens, messages, email } = req.body;

    if (!model || !max_tokens || !messages) {
      return res.status(400).json({ error: 'Faltan parámetros (model, max_tokens, messages)' });
    }

    // Validar email
    if (!email || typeof email !== 'string') {
      return res.status(401).json({ error: 'Se requiere email para generar un plan.' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Verificar créditos en el servidor
    const userCredits = credits.get(normalizedEmail) || 0;
    if (userCredits <= 0) {
      return res.status(402).json({
        error: 'Sin créditos disponibles. Adquiere acceso en Move & Build para continuar.',
        credits: 0
      });
    }

    // Descontar crédito ANTES de llamar a Claude
    credits.set(normalizedEmail, userCredits - 1);
    console.log(`→ Generando plan: ${normalizedEmail} (créditos restantes: ${userCredits - 1})`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, messages })
    });

    if (!response.ok) {
      // Devolver el crédito si Claude falla
      credits.set(normalizedEmail, userCredits);
      console.error(`❌ Error de Claude API para ${normalizedEmail}, crédito devuelto`);
      const error = await response.json();
      return res.status(response.status).json({ error });
    }

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error('Error en /api/claude:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Move & Build server running on port ${PORT}`));
