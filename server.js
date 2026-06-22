const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('.'));
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('❌ ANTHROPIC_API_KEY no está configurada en Render.');
  process.exit(1);
}
// ── ENDPOINT SEGURO: /api/claude ──
app.post('/api/claude', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Falta parámetro "prompt"' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error });
    }
    const data = await response.json();
    const message = data.content?.map(b => b.text || '').join('') || '';
    res.json({ message });
  } catch (err) {
    console.error('Error en /api/claude:', err);
    res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Server running on port ${PORT}`));
