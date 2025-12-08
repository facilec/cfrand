import http from 'node:http';
import { generateEntropyResponse } from '../src/entropy.js';

const PORT = Number(process.env.PORT || 8787);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== '/api/random') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  try {
    const { status, body } = await generateEntropyResponse(process.env, { logger: console });
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  } catch (error) {
    console.error('local-server-error', error);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal Server Error' }));
  }
});

server.listen(PORT, () => {
  console.log(`Local entropy server listening on http://localhost:${PORT}`);
});
