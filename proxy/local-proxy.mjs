#!/usr/bin/env node
// ==========================================================================
// Proxy CORS locale (solo per prove sul proprio computer).
// --------------------------------------------------------------------------
// Uso:
//     node proxy/local-proxy.mjs            (porta 8787)
//     PORT=9000 node proxy/local-proxy.mjs
//
// Poi apri la pagina con:
//     http://localhost:8080/?proxy=http%3A%2F%2Flocalhost%3A8787%2F%3Furl%3D%7Burl%7D
//
// Non serve per GitHub Pages: li' si usa il Worker (proxy/cloudflare-worker.js).
// ==========================================================================

import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const ALLOWED_HOSTS = ['wfs.cartografia.agenziaentrate.gov.it'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  const requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  const target = requestUrl.searchParams.get('url');
  if (!target) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('Uso: /?url=<URL da richiedere>');
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end('URL non valido');
  }
  if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
    res.writeHead(403, { ...CORS, 'Content-Type': 'text/plain' });
    return res.end(`Host non consentito: ${targetUrl.hostname}`);
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': 'mappa-campi-agricoli/2.0 (proxy locale)' },
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      ...CORS,
      'Content-Type': upstream.headers.get('content-type') || 'application/xml',
    });
    res.end(body);
  } catch (exc) {
    res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
    res.end(`Errore nell'inoltro: ${exc.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Proxy CORS locale attivo su http://localhost:${PORT}/?url=<URL>`);
  console.log('Interrompi con Ctrl+C.');
});
