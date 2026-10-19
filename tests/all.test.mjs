// ==========================================================================
// Test di verifica della versione web (Node 18+).
// --------------------------------------------------------------------------
// Uso:  node tests/all.test.mjs
//
// Alcuni test richiedono risorse esterne e vengono saltati (SKIP) se assenti:
//   - libreria GeographicLib  -> scaricata dal CDN al primo avvio
//   - DOMParser               -> 'npm install @xmldom/xmldom' oppure
//                                variabile MAPPA_TEST_DEPS=<cartella con node_modules>
//   - proxy CORS              -> variabile MAPPA_PROXY_URL='http://localhost:8787/?url={url}'
// ==========================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

let passed = 0, failed = 0, skipped = 0;

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}
function skip(name, reason) { skipped++; console.log(`  SKIP  ${name} (${reason})`); }
function near(a, b, tolerance) { return Math.abs(a - b) <= tolerance; }

// --------------------------------------------------------------------------
// Caricamento della libreria di geodesia (come nel browser)
// --------------------------------------------------------------------------
async function loadGeodesic() {
  const target = join(tmpdir(), 'geographiclib-geodesic-2.2.0.min.js');
  const url = 'https://cdn.jsdelivr.net/npm/geographiclib-geodesic@2.2.0/'
            + 'geographiclib-geodesic.min.js';
  try {
    globalThis.geodesic = createRequire(import.meta.url)(target);
    return true;
  } catch (_) { /* non ancora scaricata */ }
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    globalThis.geodesic = createRequire(import.meta.url)(target);
    return true;
  } catch (_) {
    return false;
  }
}

// --------------------------------------------------------------------------
// DOMParser (presente nei browser, non in Node)
// --------------------------------------------------------------------------
async function loadDomParser() {
  try {
    const mod = await import('@xmldom/xmldom');
    return mod.DOMParser;
  } catch (_) { /* non installato accanto al progetto */ }
  const base = process.env.MAPPA_TEST_DEPS;
  if (base) {
    try {
      const req = createRequire(join(base, 'anchor.cjs'));
      return req('@xmldom/xmldom').DOMParser;
    } catch (_) { /* niente da fare */ }
  }
  return null;
}

// --------------------------------------------------------------------------
console.log('\n== Geometria (area / perimetro / centroide) ==');
const geoOk = await loadGeodesic();
if (!geoOk) {
  skip('geodesia', 'libreria GeographicLib non disponibile (rete assente)');
} else {
  const geo = await import('../web/geo.js');
  const ring = [[45.0, 9.0], [45.002, 9.0], [45.002, 9.002], [45.0, 9.002]];
  const { area, perimeter } = geo.ringAreaPerimeter(ring);
  // Valori di riferimento calcolati con GeographicLib (Python), come l'app desktop.
  ok('area del quadrato di prova', near(area, 35048.952, 0.01), `${area}`);
  ok('perimetro del quadrato di prova', near(perimeter, 759.909, 0.001), `${perimeter}`);

  const centroid = geo.ringCentroid(ring);
  ok('centroide', near(centroid[0], 45.001, 1e-6) && near(centroid[1], 9.001, 1e-6),
     `${centroid}`);

  ok('punto interno', geo.pointInRing(45.001, 9.001, ring) === true);
  ok('punto esterno', geo.pointInRing(45.01, 9.01, ring) === false);

  const bbox = geo.bboxOf(ring);
  ok('bounding box', bbox[0] === 45.0 && bbox[1] === 9.0 && bbox[2] === 45.002 && bbox[3] === 9.002,
     `${bbox}`);

  const { area: areaHole } = geo.geometryMeasure(ring, [[[45.0005, 9.0005], [45.0015, 9.0005], [45.0015, 9.0015], [45.0005, 9.0015]]]);
  ok('area con buco sottratta', areaHole < area, `${areaHole}`);
}

// --------------------------------------------------------------------------
console.log('\n== Parsing GML e identificativi ==');
const DOMParserImpl = await loadDomParser();
const gml = await import('../web/gml.js');

ok('parseInspireId con sezione',
   JSON.stringify(gml.parseInspireId('IT.AGE.PLA.G388E000100.1'))
   === JSON.stringify({ comune: 'G388', sezione: 'E', foglio: '0001', particella: '1' }));
ok('parseInspireId senza sezione',
   JSON.stringify(gml.parseInspireId('IT.AGE.PLA.M011_000200.2'))
   === JSON.stringify({ comune: 'M011', sezione: '', foglio: '0002', particella: '2' }));
ok('parsePosList', gml.parsePosList('45.1 9.1 45.2 9.2').length === 2);

if (!DOMParserImpl) {
  skip('parsing della risposta WFS', 'DOMParser non disponibile in Node');
} else {
  globalThis.DOMParser = DOMParserImpl;
  const xml = readFileSync(join(FIXTURES, 'wfs_pavia_g388.xml'), 'utf8');
  const parcels = gml.parseWfsResponse(xml);
  ok('due particelle estratte', parcels.length === 2, `${parcels.length}`);
  const first = parcels[0];
  ok('identificativo INSPIRE', first.localId.startsWith('IT.AGE.PLA.G388'),
     first.localId);
  ok('comune dedotto', first.comune === 'G388', first.comune);
  ok('anello esterno chiuso con almeno 3 vertici', first.exterior.length >= 3,
     `${first.exterior.length}`);
  ok('prima coordinata nella zona di Pavia',
     near(first.exterior[0][0], 45.18, 0.05) && near(first.exterior[0][1], 9.16, 0.05),
     `${first.exterior[0]}`);
  const withHoles = parcels.filter((p) => p.interiors.length > 0);
  ok('buchi (interiors) riconosciuti', withHoles.length >= 1,
     `${withHoles.map((p) => p.interiors.length).join('/')}`);
}

// --------------------------------------------------------------------------
console.log('\n== Validazione del nome file regionale (catasto.js) ==');
{
  const { sanitizeRegionFile } = await import('../web/catasto.js');
  const lancia = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ok('nome file regionale valido accettato',
     sanitizeRegionFile('03_Lombardia.parquet') === '03_Lombardia.parquet');
  ok('sottocartella rifiutata (path traversal)',
     lancia(() => sanitizeRegionFile('../etc/passwd.parquet')));
  ok('tentativo di SQL injection rifiutato',
     lancia(() => sanitizeRegionFile("x.parquet' OR 1=1--")));
  ok('estensione diversa da .parquet rifiutata',
     lancia(() => sanitizeRegionFile('dati.csv')));
  ok('stringa vuota rifiutata',
     lancia(() => sanitizeRegionFile('')));
}

// --------------------------------------------------------------------------
// Il WFS dell'Agenzia delle Entrate restituisce a volte una collezione vuota
// e — cosa peggiore — una cache davanti al servizio la ripete identica per lo
// stesso URL. Qui si riproduce il comportamento con una fetch finta: la prima
// risposta e' vuota, la seconda (con URL variata) contiene le particelle.
// --------------------------------------------------------------------------
console.log('\n== Risposte vuote memorizzate (fetch simulata) ==');
if (!DOMParserImpl) {
  skip('ritentativo su collezione vuota', 'DOMParser non disponibile in Node');
} else {
  globalThis.DOMParser = DOMParserImpl;
  const { WfsClient } = await import('../web/wfs.js');
  const realFetch = globalThis.fetch;
  const vuota = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" '
    + 'numberMatched="0" numberReturned="0"></wfs:FeatureCollection>';
  const piena = readFileSync(join(FIXTURES, 'wfs_pavia_g388.xml'), 'utf8');

  const client = new WfsClient(() => '');   // nessun proxy: URL diretta al WFS
  const chiamate = [];
  globalThis.fetch = async (u) => {
    chiamate.push(String(u));
    const vuoto = chiamate.length === 1;
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => (vuoto ? vuota : piena),
    };
  };
  try {
    const parcels = await client.fetchParcels(45.1855, 9.16, 0.0027, 200, 1, undefined, 1);
    ok('collezione vuota ritentata fino ai dati', parcels.length === 2, `${parcels.length}`);
    ok('due richieste effettuate', chiamate.length === 2, `${chiamate.length}`);
    ok('il ritentativo varia la URL (scarto della cache)',
       chiamate.length === 2 && chiamate[0] !== chiamate[1]
       && chiamate[1].includes('&_='), chiamate[1] ? chiamate[1].slice(-24) : '');

    // Senza tentativi extra una collezione vuota e' una risposta valida.
    chiamate.length = 0;
    globalThis.fetch = async (u) => {
      chiamate.push(String(u));
      return { ok: true, status: 200, statusText: 'OK', text: async () => vuota };
    };
    const nessuna = await client.fetchParcels(45.1855, 9.16, 0.0027, 200, 1, undefined, 0);
    ok('senza tentativi extra la collezione vuota viene accettata',
       nessuna.length === 0 && chiamate.length === 1, `${chiamate.length} richieste`);
  } catch (exc) {
    ok('ritentativo su collezione vuota', false, exc.message);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --------------------------------------------------------------------------
console.log('\n== Client WFS (richiede un proxy CORS) ==');
const proxyUrl = process.env.MAPPA_PROXY_URL;
if (!proxyUrl) {
  skip('richiesta al WFS', 'variabile MAPPA_PROXY_URL non impostata');
} else {
  const { WfsClient } = await import('../web/wfs.js');
  const client = new WfsClient(() => proxyUrl);
  const url = client.buildUrl(45.18, 9.15, 45.19, 9.16, 5);
  ok('URL GetFeature ben formato', url.includes('REQUEST=GetFeature')
     && url.includes('TYPENAMES=CP%3ACadastralParcel')
     && url.includes('SRSNAME=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A6706'));
  try {
    const parcels = await client.fetchParcels(45.1855, 9.16, 0.0008, 5, 1);
    ok('particelle ricevute dal WFS', parcels.length > 0, `${parcels.length}`);
    const identified = await client.identifyAt(45.1851, 9.1598);
    ok('identificazione della particella nel punto', Boolean(identified?.localId),
       identified ? identified.localId : 'null');
  } catch (exc) {
    ok('richiesta al WFS', false, exc.message);
  }
}

// --------------------------------------------------------------------------
console.log('\n== Interfaccia: pannello ridimensionabile e controlli mappa ==');
{
  const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
  const css = readFileSync(join(HERE, '..', 'web', 'app.css'), 'utf8');
  const js = readFileSync(join(HERE, '..', 'web', 'app.js'), 'utf8');

  ok('maniglia del pannello con ruolo accessibile',
     /id="panel-resizer"[\s\S]{0,200}?role="separator"/.test(html)
     && /aria-orientation="vertical"/.test(html));
  ok('pulsante del pannello con etichetta accessibile',
     /id="btn-toggle-panel"[\s\S]{0,200}?aria-label=/.test(html));

  ok('larghezza del pannello basata su variabile CSS',
     /--panel-w:\s*\d+px/.test(css) && /width:\s*var\(--panel-w\)/.test(css));
  ok('la maniglia si nasconde quando il pannello e\' chiuso',
     /\.panel\.hidden\s*\+\s*\.panel-resizer\s*\{\s*display:\s*none/.test(css));
  ok('maniglia nascosta su schermo stretto',
     /@media \(max-width: 820px\)[\s\S]*\.panel-resizer\s*\{\s*display:\s*none/.test(css));

  // Lo zoom è spostato in alto a destra: in alto a sinistra c'è il pulsante
  // del pannello e i due si coprirebbero (Leaflet ha uno z-index più alto).
  ok('lo zoom di Leaflet è spostato in alto a destra',
     /zoomControl:\s*false/.test(js)
     && /L\.control\.zoom\(\{\s*position:\s*'topright'\s*\}\)/.test(js));
  ok('nessuno scostamento residuo dei controlli in alto a sinistra',
     !/\.leaflet-top\.leaflet-left\s*\{/.test(css));

  ok('ridimensionamento inizializzato all\'avvio', /initPanelResizer\(\);/.test(js));
  ok('larghezza ricordata fra le visite',
     /PANEL_W_KEY/.test(js) && /localStorage\.setItem\(PANEL_W_KEY/.test(js));
  ok('ridimensionamento accessibile da tastiera',
     /'ArrowLeft'/.test(js) && /'ArrowRight'/.test(js));
  ok('ridisegno della mappa durante il trascinamento',
     /invalidateSize/.test(js));
}

// --------------------------------------------------------------------------
console.log('\n== Worker proxy: limite di velocita\' e controllo origine ==');
try {
  const store = new Map();
  const realCaches = globalThis.caches;
  const realNow = Date.now;
  globalThis.caches = {
    default: {
      async match(req) { return store.get(req.url); },
      async put(req, res) {
        store.set(req.url, new Response(null,
          { headers: { 'x-conteggio': res.headers.get('x-conteggio') } }));
      },
    },
  };

  const worker = (await import('../proxy/cloudflare-worker.js')).default;
  const TARGET = 'http://example.com/';       // non https: 400 immediato
  const ATTESO = 400;
  const call = (origin, referer, ip = '10.0.0.1') => worker.fetch(new Request(
    `https://mappa-proxy.test/?url=${encodeURIComponent(TARGET)}`,
    { headers: { Origin: origin, Referer: referer, 'CF-Connecting-IP': ip } }));

  const GO = 'https://mimmodc.github.io';
  const r1 = await call(GO, `${GO}/mappa/`);
  ok('richiesta autorizzata non bloccata', r1.status === ATTESO, `HTTP ${r1.status}`);

  const rBad = await call('https://evil.example', 'https://evil.example/');
  ok('origine non autorizzata rifiutata', rBad.status === 403, `HTTP ${rBad.status}`);

  let r120 = r1;
  for (let i = 1; i < 120; i++) r120 = await call(GO, `${GO}/mappa/`);
  ok('la 120a richiesta dello stesso visitatore e\' accettata',
     r120.status === ATTESO, `HTTP ${r120.status}`);

  const r121 = await call(GO, `${GO}/mappa/`);
  ok('la 121a richiesta viene limitata (429)',
     r121.status === 429, `HTTP ${r121.status}`);
  ok('la risposta 429 indica Retry-After', r121.headers.get('retry-after') === '60');

  const rAltro = await call(GO, `${GO}/mappa/`, '10.0.0.2');
  ok('un altro visitatore (IP diverso) non e\' bloccato',
     rAltro.status === ATTESO, `HTTP ${rAltro.status}`);

  Date.now = () => realNow() + 61_000;
  const rDopo = await call(GO, `${GO}/mappa/`);
  ok('dopo un minuto il contatore si azzera', rDopo.status === ATTESO, `HTTP ${rDopo.status}`);

  Date.now = realNow;
  globalThis.caches = realCaches;
} catch (exc) {
  ok('limite di velocita\' del Worker', false, exc.message);
}

// --------------------------------------------------------------------------
console.log(`\nRiepilogo: ${passed} superati, ${failed} falliti, ${skipped} saltati.\n`);
process.exit(failed ? 1 : 0);
