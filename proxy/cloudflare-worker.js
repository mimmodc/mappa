// ==========================================================================
// Cloudflare Worker - proxy CORS per il WFS dell'Agenzia delle Entrate.
// --------------------------------------------------------------------------
// Il WFS catastale non invia gli header CORS, quindi il browser non puo'
// interrogarlo direttamente. Questo Worker fa da ponte:
//
//     https://<tuo-worker>.workers.dev/?url=<URL del WFS codificato>
//
// Sicurezza: vengono inoltrate SOLO le richieste verso gli host elencati in
// ALLOWED_HOSTS. Il Worker non conserva nulla.
//
// Come si pubblica: vedi proxy/README.md (5 minuti, piano gratuito).
// ==========================================================================

const ALLOWED_HOSTS = [
  'wfs.cartografia.agenziaentrate.gov.it',
];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonError(405, 'Metodo non consentito: usare GET.');
    }

    const target = requestUrl.searchParams.get('url');
    if (!target) {
      return jsonError(400, 'Parametro mancante: usare ?url=<URL da richiedere>');
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (_) {
      return jsonError(400, 'URL non valido.');
    }
    if (targetUrl.protocol !== 'https:') {
      return jsonError(400, 'Sono ammesse solo URL https.');
    }
    if (!ALLOWED_HOSTS.includes(targetUrl.hostname)) {
      return jsonError(403, `Host non consentito: ${targetUrl.hostname}`);
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: {
          'User-Agent': 'mappa-campi-agricoli/2.0 (+https://github.com/)',
          Accept: 'application/xml,text/xml,*/*',
        },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
    } catch (exc) {
      return jsonError(502, `Il WFS non e' raggiungibile dal Worker: ${exc.message}`);
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': upstream.headers.get('content-type') || 'application/xml',
        'Cache-Control': 'public, max-age=300',
      },
    });
  },
};

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
