// ==========================================================================
// Cloudflare Worker - proxy CORS per il WFS dell'Agenzia delle Entrate.
// --------------------------------------------------------------------------
// Il WFS catastale non invia gli header CORS, quindi il browser non puo'
// interrogarlo direttamente. Questo Worker fa da ponte:
//
//     https://<tuo-worker>.workers.dev/?url=<URL del WFS codificato>
//
// Sicurezza:
//   * vengono inoltrate SOLO le richieste verso gli host elencati in
//     ALLOWED_HOSTS;
//   * vengono accettate SOLO le richieste provenienti dalle origini elencate in
//     ALLOWED_ORIGINS (le pagine dell'app): senza questo controllo chiunque
//     potrebbe usare il Worker come proxy aperto verso il WFS;
//   * ogni visitatore e' limitato a RATE_LIMIT_MAX richieste al minuto.
//
// Il Worker non conserva nulla: il contatore del limite di velocita' e' un
// valore temporaneo che vive solo nella cache del data center Cloudflare.
//
// Nota: il controllo sull'origine (Origin/Referer) e' un filtro lato browser e
// scoraggia l'uso improprio, ma puo' essere aggirato da client che falsificano
// gli header; per questo il limite di velocita' agisce comunque per indirizzo IP.
//
// Come si pubblica: vedi proxy/README.md (5 minuti, piano gratuito).
// ==========================================================================

const ALLOWED_HOSTS = [
  'wfs.cartografia.agenziaentrate.gov.it',
];

// Origini autorizzate a usare il proxy (le pagine dell'app). Aggiungere qui
// altri domini se l'app viene pubblicata altrove.
const ALLOWED_ORIGINS = [
  /^https:\/\/mimmodc\.github\.io$/,
  /^http:\/\/localhost(:\d+)?$/,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/,
  /^http:\/\/\[::1\](:\d+)?$/,
];

/** True se la richiesta proviene da un'origine autorizzata (Origin o Referer). */
function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (origin !== null) {
    return ALLOWED_ORIGINS.some((re) => re.test(origin));
  }
  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return ALLOWED_ORIGINS.some((re) => re.test(new URL(referer).origin));
    } catch (_) {
      return false;
    }
  }
  return false;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

// Limite di velocita': massimo RATE_LIMIT_MAX richieste per finestra
// (RATE_LIMIT_WINDOW_MS) per visitatore. L'app, per caricare una vista, puo'
// fare ~12 richieste (fino a ~36 coi ritentativi): il limite e' quindi alto
// abbastanza da non disturbare l'uso normale, ma ferma gli abusi (uno script
// non puo' piu' usare il Worker come relay illimitato verso il WFS).
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/**
 * True se il visitatore ha superato il limite di richieste.
 *
 * Il conteggio usa la Cache API (nessun servizio aggiuntivo, piano gratuito):
 * e' una stima per data center, sufficiente a scoraggiare gli abusi. In caso
 * di errore non blocca mai il servizio.
 */
async function isRateLimited(request) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'sconosciuto';
    const finestra = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
    const chiave = new Request(
      `https://rate-limit.mappa.invalid/${encodeURIComponent(ip)}/${finestra}`);
    const cache = caches.default;
    const precedente = await cache.match(chiave);
    const conteggio = (precedente
      ? Number(precedente.headers.get('x-conteggio')) || 0 : 0) + 1;
    await cache.put(chiave, new Response(null, {
      headers: { 'x-conteggio': String(conteggio), 'Cache-Control': 'max-age=60' },
    }));
    return conteggio > RATE_LIMIT_MAX;
  } catch (_) {
    return false;
  }
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (!originAllowed(request)) {
        return jsonError(403, 'Origine non autorizzata.');
      }
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonError(405, 'Metodo non consentito: usare GET.');
    }
    if (!originAllowed(request)) {
      return jsonError(403, 'Origine non autorizzata: il proxy è riservato '
        + "alle pagine dell'app.");
    }
    if (await isRateLimited(request)) {
      return jsonError(429,
        `Troppe richieste: massimo ${RATE_LIMIT_MAX} al minuto per visitatore. `
        + 'Riprovare tra poco.',
        { 'Retry-After': '60' });
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
          'User-Agent': 'mappa-campi-agricoli/2.1 (+https://github.com/)',
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

function jsonError(status, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
