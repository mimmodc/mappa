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
console.log('\n== Scheda catastale dei terreni (visura.js) ==');
{
  const visura = await import('../web/visura.js');
  const { provinceOf, serviceProvinces } = await import('../web/comuni-province.js');
  const provcomXml = readFileSync(join(FIXTURES, 'visura_provcom_pv.xml'), 'utf8');
  const searchHtml = readFileSync(join(FIXTURES, 'visura_search_pavia.html'), 'utf8');
  const detailHtml = readFileSync(join(FIXTURES, 'visura_detail_pavia.html'), 'utf8');

  ok('provincia da codice catastale (Pavia)', provinceOf('G388') === 'PV',
     provinceOf('G388'));
  ok('provincia da codice catastale (Abano Terme)', provinceOf('A001') === 'PD',
     provinceOf('A001'));
  ok('provincia storica FC -> FO', serviceProvinces('FC').includes('FO'));
  ok('provincia storica BT -> BA/FG',
     serviceProvinces('BT').includes('BA') && serviceProvinces('BT').includes('FG'));
  ok('provincia storica SU -> CA/OR/NU/SS',
     ['CA', 'OR', 'NU', 'SS'].every((p) => serviceProvinces('SU').includes(p)));

  const names = visura.parseProvcomXml(provcomXml);
  ok('elenco comuni della provincia', names.length > 100 && names.includes('PAVIA'),
     `${names.length}`);
  ok('abbinamento nome ufficiale (Pavia)',
     visura.matchOfficialComune(names, 'Pavia') === 'PAVIA');
  ok('abbinamento con accento e apostrofo (Bascapè)',
     visura.matchOfficialComune(names, 'Bascapè') === "BASCAPE'",
     visura.matchOfficialComune(names, 'Bascapè'));

  const search = visura.parseSearchResults(searchHtml);
  ok('ricerca: un risultato', search.total === 1 && search.rows.length === 1,
     `${search.total}/${search.rows.length}`);
  const row = search.rows[0];
  ok('ricerca: identificativi della particella',
     row.idimmobile === '353329681' && row.idcomune === 'G388'
     && row.idsezione === 'B');
  ok('ricerca: foglio e particella', row.foglio === '9' && row.numero === '37');

  ok('ricerca senza risultati riconosciuta',
     visura.parseSearchResults(
       '<div class="nontrovato">Nessuna particella trovata</div>',
     ).notFound === true);

  const detail = visura.parseDetail(detailHtml);
  ok('dettaglio: due porzioni', detail.rows.length === 2, `${detail.rows.length}`);
  ok('dettaglio: qualità della prima porzione',
     detail.rows[0].qualita === 'PRATO IRRIGUO ARBORATO');
  ok('dettaglio: classe della prima porzione', detail.rows[0].classe === '1');
  ok('dettaglio: superficie della prima porzione',
     near(detail.rows[0].superficieHa, 0.0413, 1e-9));
  ok('dettaglio: totale superficie', near(detail.totals.superficieHa, 1.0035, 1e-9),
     `${detail.totals.superficieHa}`);
  ok('dettaglio: totale redditi',
     near(detail.totals.redditoDominicale, 137.34, 0.001)
     && near(detail.totals.redditoAgrario, 58.50, 0.001));
  ok('dettaglio: totale calcolato coerente',
     near(detail.computed.superficieHa, detail.totals.superficieHa, 1e-9));

  ok('numero italiano', visura.parseItalianNumber('1.234,56') === 1234.56);
  ok('formato ettari', visura.formatHa(1.0035) === '1,0035 ha',
     visura.formatHa(1.0035));
  ok('formato euro', visura.formatEuro(58.5) === '58,50 \u20ac',
     visura.formatEuro(58.5));
  ok('identificativi normalizzati',
     visura.identifiersText({
       comuneCode: 'G388', comuneName: 'Pavia', sezione: 'B',
       foglio: '0009', particella: '0037',
     }).includes('Particella: 37'));

  const searchUrl = visura.buildSearchUrl({
    provincia: 'PV', comune: 'PAVIA', sezione: 'B', foglio: '9', numero: '37',
  });
  ok('URL di ricerca', searchUrl.includes('action=search')
     && searchUrl.includes('provincia=PV') && searchUrl.includes('comune=PAVIA'));
  const withoutSection = visura.buildSearchUrl({
    provincia: 'PV', comune: 'PAVIA', sezione: '', foglio: '9', numero: '37',
  });
  ok('URL di ricerca senza sezione', !withoutSection.includes('sezione='));

  const response = (body, contentType = 'text/html; charset=UTF-8') => ({
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  });

  const pages = [provcomXml, searchHtml, detailHtml];
  const calls = [];
  const client = new visura.VisuraClient({
    fetchImpl: async (url) => {
      calls.push(String(url));
      const body = pages.shift();
      return response(body, String(url).includes('provcom.php')
        ? 'text/xml; charset=UTF-8' : 'text/html; charset=UTF-8');
    },
    // Data locale: il riepilogo mostra l'ora del browser, non UTC.
    now: () => new Date(2026, 9, 20, 10, 53, 40),
  });
  const parcel = {
    comuneCode: 'G388', comuneName: 'Pavia', sezione: 'B',
    foglio: '0009', particella: '0037',
  };
  const result = await client.lookup(parcel);
  ok('client: scheda trovata', result.found === true);
  ok('client: tre richieste (comuni, ricerca, dettaglio)', calls.length === 3,
     `${calls.length}`);
  ok('client: totale della scheda', near(result.detail.totals.superficieHa, 1.0035, 1e-9));
  ok('client: data di consultazione',
     visura.formatDateTimeIt(result.fetchedAt) === '20/10/2026 10:53',
     visura.formatDateTimeIt(result.fetchedAt));

  const cached = await client.lookup(parcel);
  ok('client: risultato in cache senza nuove richieste',
     cached === result && calls.length === 3, `${calls.length}`);

  const notFoundClient = new visura.VisuraClient({
    fetchImpl: async (url) => response(String(url).includes('provcom.php')
      ? provcomXml
      : '<div class="nontrovato">Nessuna particella trovata</div>'),
  });
  const notFound = await notFoundClient.lookup({
    comuneCode: 'G388', comuneName: 'Pavia', sezione: 'A',
    foglio: '3', particella: '218',
  });
  ok('client: particella assente dall\'archivio',
     notFound.found === false && notFound.reason === 'not-found',
     `${notFound.found}/${notFound.reason}`);

  const btCalls = [];
  const btClient = new visura.VisuraClient({
    fetchImpl: async (url) => {
      btCalls.push(String(url));
      if (String(url).includes('prov=BA')) {
        return response('<root><dizione>ANDRIA</dizione></root>',
          'text/xml; charset=UTF-8');
      }
      if (String(url).includes('prov=FG')) {
        return response('<root><dizione>MARGHERITA DI SAVOIA</dizione></root>',
          'text/xml; charset=UTF-8');
      }
      return response('<div class="nontrovato">Nessuna particella trovata</div>');
    },
  });
  const bt = await btClient.lookup({
    comuneCode: 'E946', comuneName: 'Margherita di Savoia',
    sezione: '', foglio: '1', particella: '1',
  });
  ok('province storiche: prova BA e poi FG',
     btCalls.some((url) => url.includes('prov=BA'))
     && btCalls.some((url) => url.includes('prov=FG')));
  ok('province storiche: esito registrato', bt.found === false
     && bt.tried.includes('BA') && bt.tried.includes('FG'));
}

// --------------------------------------------------------------------------
console.log('\n== Interfaccia: scheda catastale dei terreni ==');
{
  const html = readFileSync(join(HERE, '..', 'index.html'), 'utf8');
  const css = readFileSync(join(HERE, '..', 'web', 'app.css'), 'utf8');
  const js = readFileSync(join(HERE, '..', 'web', 'app.js'), 'utf8');

  ok('scheda presente nella pagina',
     /id="card-visura"/.test(html) && /id="btn-visura"/.test(html));
  ok('pulsante disabilitato finché non c\'è una particella',
     /id="btn-visura"[^>]*disabled/.test(html));
  ok('contenitore del risultato presente', /id="out-visura"/.test(html));
  ok('stato accessibile con aria-live',
     /id="visura-status"[^>]*role="status"[^>]*aria-live="polite"/.test(html));
  ok('link alla visura ufficiale', /visura-catastale-online/.test(html));
  ok('link alla consultazione rendite',
     /consultazione-rendite-catastali/.test(html));
  ok('avvertenza sulla copertura parziale',
     /copertura &egrave; <b>parziale<\/b>/.test(html));
  ok('l\'app istanzia il client della scheda', /new VisuraClient\(\)/.test(js));
  ok('l\'app aggiorna la scheda quando cambia il campo',
     /updateVisuraState\(\{ reset: true \}\)/.test(js));
  ok('tabella della scheda stilizzata', /\.visura-table/.test(css));
  ok('stampa dedicata della sola scheda',
     /@media print/.test(css) && /printing-visura/.test(css));
  ok('la scheda si nasconde quando non c\'è una particella',
     /resetVisura\(\)/.test(js));
}

// --------------------------------------------------------------------------
console.log(`\nRiepilogo: ${passed} superati, ${failed} falliti, ${skipped} saltati.\n`);
process.exit(failed ? 1 : 0);
