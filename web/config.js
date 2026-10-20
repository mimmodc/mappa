// ==========================================================================
// Configurazione della versione web di "Mappa Campi Agricoli".
// --------------------------------------------------------------------------
// NOTA (proxy WFS): il WFS dell'Agenzia delle Entrate NON invia gli header
// CORS, quindi un browser non puo' interrogarlo direttamente. Qui sotto e' gia'
// indicato il Worker Cloudflare del progetto (gratuito), che aggiunge gli header
// CORS. Si puo' cambiare dall'interfaccia (sezione "Impostazioni") o con
// ?proxy=...; vedi proxy/README.md per pubblicarne uno proprio.
// ==========================================================================

export const CONFIG = {
  version: '2.1-web',

  // --- Servizi dati -------------------------------------------------------
  // Indice comune/foglio/particella -> coordinate (OnData, CC-BY 4.0, CORS ok)
  indexUrl: 'https://raw.githubusercontent.com/ondata/dati_catastali/main/'
          + 'S_0000_ITALIA/anagrafica/index.parquet',
  parcelsUrl: 'https://raw.githubusercontent.com/ondata/dati_catastali/main/'
            + 'S_0000_ITALIA/anagrafica/{file}',

  // WFS Agenzia delle Entrate (geometrie delle particelle)
  wfsUrl: 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php',
  wfsTypeName: 'CP:CadastralParcel',
  wfsSrs: 'urn:ogc:def:crs:EPSG::6706',   // RDN2008, ordine lat lon

  // Proxy CORS. Deve accettare l'URL da chiamare come parametro {url}.
  // Predefinito: Worker Cloudflare del progetto (piano gratuito).
  // Se e' vuoto, le richieste vengono fatte direttamente (utile solo per test).
  wfsProxy: 'https://mappa-proxy.mimmodc.workers.dev/?url={url}',

  // --- Scheda catastale dei terreni ---------------------------------------
  // "Variazioni colturali on line" dell'Agenzia delle Entrate: servizio
  // pubblico, senza login, con CORS aperto. Restituisce qualità di coltura,
  // classe, superficie e redditi delle particelle del catasto terreni.
  // La copertura NON è completa: va presentata come riepilogo informativo,
  // non come visura ufficiale.
  visura: {
    baseUrl: 'https://www1.agenziaentrate.gov.it/servizi/VariazioniColturali/',
    officialVisuraUrl: 'https://www.agenziaentrate.gov.it/portale/schede/'
      + 'fabbricatiterreni/visura-catastale/visura-catastale-online',
    officialRenditeUrl: 'https://www.agenziaentrate.gov.it/portale/schede/'
      + 'fabbricatiterreni/visura-catastale/consultazione-rendite-catastali',
    officialLoginUrl: 'https://iampe.agenziaentrate.gov.it/sam/UI/Login'
      + '?realm=/agenziaentrate',
    timeoutMs: 15000,
  },

  // --- Overlay delle particelle ------------------------------------------
  parcelViewMinZoom: 16,       // zoom minimo per aggiornare il gruppo "vista"
  parcelViewMaxFeatures: 200,  // COUNT massimo per richiesta WFS
  wfsTileSpan: 0.012,          // lato max (gradi) della bbox richiedibile
  fieldMarginMin: 0.0012,      // margine minimo (~130 m) attorno al campo
  fieldMarginFactor: 0.7,      // margine proporzionale alla dimensione del campo

  // --- Mappa --------------------------------------------------------------
  italyCenter: [42.50, 12.50],
  italyZoom: 6,

  basemaps: {
    'OpenStreetMap': {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      maxZoom: 19,
    },
    'Satellite (Esri)': {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/'
         + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19,
    },
    'Topografica (OpenTopoMap)': {
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      maxZoom: 17,
    },
    'Umanitaria (OSM HOT)': {
      url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      maxZoom: 19,
    },
  },

  attribution:
    'Mappa \u00a9 OpenStreetMap \u00b7 Catasto \u00a9 Agenzia delle Entrate '
    + '(CC-BY 4.0) \u00b7 Indice \u00a9 OnData',
};

// Colori (come nell'app desktop)
export const COLORS = {
  fieldFill: '#8bc34a',
  fieldLine: '#1b5e20',
  parcelLine: '#c0392b',
  draftLine: '#ff5722',
};

const PROXY_KEY = 'mappa_campo_agricolo.wfsProxy';

/** Proxy salvato dall'utente (localStorage) o quello di config. */
export function loadProxy() {
  try {
    const saved = localStorage.getItem(PROXY_KEY);
    if (saved !== null) return saved;
  } catch (_) { /* localStorage non disponibile */ }
  return CONFIG.wfsProxy;
}

export function saveProxy(value) {
  try {
    localStorage.setItem(PROXY_KEY, value || '');
  } catch (_) { /* ignora */ }
}

/** Applica il proxy indicato con ?proxy=... (comodo per le prove). */
export function proxyFromQuery() {
  const value = new URLSearchParams(location.search).get('proxy');
  if (value) {
    saveProxy(value);
    return value;
  }
  return null;
}
