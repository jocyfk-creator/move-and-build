const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APIKEY = process.env.ANTHROPIC_API_KEY;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/claude') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!APIKEY) {
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: 'API key no configurada' }));
        return;
      }
      
      // Parsear para ver max_tokens
      try {
        const parsed = JSON.parse(body);
        console.log(`Petición: model=${parsed.model}, max_tokens=${parsed.max_tokens}`);
      } catch(e) {}
      
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': APIKEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => data += chunk);
        apiRes.on('end', () => {
          console.log(`Respuesta Anthropic: status=${apiRes.statusCode}, bytes=${data.length}`);
          // Log del stop_reason si existe
          try {
            const parsed = JSON.parse(data);
            console.log(`stop_reason=${parsed.stop_reason}, usage=${JSON.stringify(parsed.usage)}`);
          } catch(e) {
            console.log(`Error parseando respuesta: ${data.substring(0,200)}`);
          }
          res.writeHead(apiRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(data);
        });
      });
      apiReq.on('error', (err) => {
        console.error(`Error API: ${err.message}`);
        res.writeHead(500, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({ error: err.message }));
      });
      apiReq.write(body);
      apiReq.end();
    });
  } else if (req.method === 'GET') {
    const filePath = path.join(__dirname, 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(data);
    });
  } else {
    res.writeHead(405);
    res.end('Method Not Allowed');
  }
});

server.timeout = 60000;
server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
