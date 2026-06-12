const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('.'));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.error('❌ ANTHROPIC_API_KEY no configurada.');
  process.exit(1);
}

app.post('/api/claude', async (req, res) => {
  try {
    const { model, max_tokens, messages } = req.body;
    if (!model || !max_tokens || !messages) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model,
      max_tokens,
      messages
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    res.json(response.data);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✓ Server en puerto ${PORT}`));
