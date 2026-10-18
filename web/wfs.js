// ==========================================================================
// Client WFS (Agenzia delle Entrate) con supporto proxy CORS.
// Port di CatastoService.fetch_parcels / fetch_area / fetch_parcel_by_local_id
// / identify_at.
// ==========================================================================

import { CONFIG } from './config.js';
import { parseWfsResponse } from './gml.js';
import { pointInRing } from './geo.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Distanza minima fra due richieste consecutive al WFS. Il servizio
// dell'Agenzia delle Entrate tende a restituire collezioni vuote quando viene
// sollecitato con piu' richieste ravvicinate: le richieste vengono quindi
// serializzate e distanziate.
const WFS_REQUEST_GAP_MS = 120;

/** Restituisce true se una risposta e' una feature collection valida. */
function looksLikeXml(text) {
  const head = text.slice(0, 400).toLowerCase();
  return head.includes('<') && (head.includes('featurecollection')
    || head.includes('?xml') || head.includes('exceptionreport'));
}

export class WfsError extends Error {}

export class WfsClient {
  /** @param {() => string} proxyGetter funzione che restituisce il proxy attuale */
  constructor(proxyGetter = () => CONFIG.wfsProxy) {
    this.getProxy = proxyGetter;
    this._chain = Promise.resolve();
  }

  /** Serializza e distanzia le richieste verso il WFS. */
  _gate() {
    const next = this._chain.then(() => sleep(WFS_REQUEST_GAP_MS));
    this._chain = next.catch(() => {});
    return next;
  }

  /** Inserisce l'URL del WFS nel modello di proxy configurato. */
  proxied(url) {
    const template = (this.getProxy() || '').trim();
    if (!template) return url;              // nessun proxy: richiesta diretta
    const encoded = encodeURIComponent(url);
    if (template.includes('{url}')) return template.replace('{url}', encoded);
    // Nessun segnaposto: si aggiunge in coda (es. 'https://proxy.example/?url=')
    return template + encoded;
  }

  /** Costruisce la URL GetFeature per una bbox. */
  buildUrl(latMin, lonMin, latMax, lonMax, count) {
    const params = new URLSearchParams({
      language: 'ita',
      SERVICE: 'WFS',
      VERSION: '2.0.0',
      TYPENAMES: CONFIG.wfsTypeName,
      SRSNAME: CONFIG.wfsSrs,
      BBOX: `${latMin},${lonMin},${latMax},${lonMax}`,
      REQUEST: 'GetFeature',
      COUNT: String(count),
    });
    return `${CONFIG.wfsUrl}?${params.toString()}`;
  }

  /**
   * Scarica le particelle in un piccolo intorno (bbox) del punto.
   *
   * Il WFS dell'Agenzia delle Entrate e' soggetto a due tipi di errore
   * transitorio: errori di rete (ritentati `retries` volte) e **collezioni
   * vuote** per bbox che contengono invece particelle (ritentate
   * `emptyRetries` volte). Senza il secondo tipo di ripetizione i confini
   * attorno al campo resterebbero a volte assenti.
   *
   * La collezione vuota viene inoltre **memorizzata** da una cache davanti al
   * servizio e ripetuta identica per lo stesso URL: i ritentativi aggiungono
   * quindi un parametro di scarto, altrimenti ripeterebbero la risposta vuota.
   */
  async fetchParcels(lat, lon, delta = 0.00015,
                     count = CONFIG.parcelViewMaxFeatures, retries = 2,
                     signal = undefined, emptyRetries = 1) {
    const url = this.buildUrl(lat - delta, lon - delta, lat + delta, lon + delta, count);
    let lastError = null;
    let empties = Math.max(0, emptyRetries);
    let bust = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        await this._gate();
        // La prima richiesta usa la URL "pulita" (resta in cache); i
        // ritentativi la variano, per non ricevere di nuovo una risposta
        // vuota eventualmente memorizzata per quell'URL.
        const requestUrl = bust === 0 ? url : `${url}&_=${Date.now()}-${bust}`;
        const response = await fetch(this.proxied(requestUrl), { signal });
        if (!response.ok) {
          throw new WfsError(`HTTP ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (!looksLikeXml(text)) {
          throw new WfsError(
            'la risposta non sembra XML: il proxy CORS non e\' configurato '
            + 'o non funziona (vedi Impostazioni)');
        }
        const parcels = parseWfsResponse(text);
        if (parcels.length > 0 || empties === 0) return parcels;
        empties -= 1;                  // probabile risposta transitoria vuota
        bust += 1;
      } catch (exc) {
        if (exc && exc.name === 'AbortError') throw exc;
        lastError = exc instanceof WfsError ? exc
          : new WfsError(`richiesta WFS non riuscita: ${exc.message}`);
        if (attempt >= retries) break;
      }
      await sleep(400 * (attempt + 1));
    }
    throw lastError || new WfsError('errore WFS sconosciuto');
  }

  /**
   * Scarica le particelle comprese in un'area qualsiasi.
   * Il WFS non restituisce nulla se la bbox e' troppo grande: l'area viene
   * suddivisa in riquadri di lato <= WFS_TILE_SPAN, poi i risultati si uniscono.
   */
  async fetchArea(latMin, lonMin, latMax, lonMax,
                  count = CONFIG.parcelViewMaxFeatures,
                  onProgress = null, signal = undefined, emptyRetries = 1) {
    const spanLat = Math.max(0, latMax - latMin);
    const spanLon = Math.max(0, lonMax - lonMin);
    const nLat = Math.max(1, Math.ceil(spanLat / CONFIG.wfsTileSpan));
    const nLon = Math.max(1, Math.ceil(spanLon / CONFIG.wfsTileSpan));
    const dLat = spanLat / nLat;
    const dLon = spanLon / nLon;

    const found = new Map();
    let errors = 0;
    let done = 0;
    const total = nLat * nLon;

    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) {
        if (signal && signal.aborted) throw new DOMException('annullato', 'AbortError');
        const la0 = latMin + i * dLat;
        const lo0 = lonMin + j * dLon;
        const latC = la0 + dLat / 2;
        const lonC = lo0 + dLon / 2;
        const delta = Math.max(dLat, dLon) / 2;
        try {
          const parcels = await this.fetchParcels(
            latC, lonC, delta, count, 1, signal, emptyRetries);
          for (const parcel of parcels) {
            if (!found.has(parcel.localId)) found.set(parcel.localId, parcel);
          }
        } catch (exc) {
          if (exc && exc.name === 'AbortError') throw exc;
          errors += 1;
        }
        done += 1;
        if (onProgress) onProgress(done, total);
      }
    }
    if (found.size === 0 && errors > 0) {
      throw new WfsError('WFS non raggiungibile (controlla il proxy CORS).');
    }
    return [...found.values()];
  }

  /** Recupera una particella nota, dato un punto al suo interno. */
  async fetchParcelByLocalId(localId, lat, lon, delta = 0.00015, signal = undefined) {
    const parcels = await this.fetchParcels(lat, lon, delta, 50, 2, signal);
    const exact = parcels.find((p) => p.localId === localId);
    if (exact) return exact;
    const containing = parcels.find((p) => pointInRing(lat, lon, p.exterior));
    if (containing) return containing;
    return parcels.length ? parcels[0] : null;
  }

  /** Individua la particella che contiene il punto indicato. */
  async identifyAt(lat, lon, signal = undefined) {
    for (const delta of [0.00008, 0.00025, 0.001]) {
      const parcels = await this.fetchParcels(lat, lon, delta, 50, 2, signal);
      const containing = parcels.find((p) => pointInRing(lat, lon, p.exterior));
      if (containing) return containing;
      if (parcels.length) {
        let best = parcels[0];
        let bestDist = Infinity;
        for (const p of parcels) {
          const c = centroidOf(p.exterior);
          const d = (c[0] - lat) ** 2 + (c[1] - lon) ** 2;
          if (d < bestDist) { bestDist = d; best = p; }
        }
        return best;
      }
    }
    return null;
  }
}

/** Centroide semplice (media dei vertici) usato solo per scegliere il piu' vicino. */
function centroidOf(ring) {
  let lat = 0, lon = 0;
  for (const p of ring) { lat += p[0]; lon += p[1]; }
  return [lat / ring.length, lon / ring.length];
}
