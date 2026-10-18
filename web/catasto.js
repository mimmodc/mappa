// ==========================================================================
// Ricerca catastale tramite DuckDB-WASM.
// --------------------------------------------------------------------------
// Legge i parquet di OnData (CORS abilitato) direttamente dal browser:
//  - index.parquet (86 KB)  -> elenco dei comuni
//  - <regione>.parquet (10-70 MB) -> punto interno di ogni particella
// I file regionali sono ordinati per comune e hanno statistiche per row-group:
// DuckDB scarica solo i blocchi necessari (richieste HTTP range).
// ==========================================================================

import { CONFIG } from './config.js';
import { parseInspireId } from './gml.js';

const DUCKDB_VERSION = '1.29.0';
const DUCKDB_URL = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_VERSION}/+esm`;

export class CatastoError extends Error {}let duckdbPromise = null;
async function duckdbModule() {
  if (!duckdbPromise) duckdbPromise = import(DUCKDB_URL);
  return duckdbPromise;
}

export class CatastoService {
  constructor() {
    this.db = null;
    this.conn = null;
    this.comuni = null;
    this._ready = null;
  }

  /** Inizializza DuckDB-WASM (una sola volta). */
  async init(onStatus = null) {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      onStatus?.('Caricamento DuckDB (motore di interrogazione)...');
      const duckdb = await duckdbModule();
      const bundles = duckdb.getJsDelivrBundles();
      const bundle = await duckdb.selectBundle(bundles);
      const workerUrl = URL.createObjectURL(new Blob(
        [`importScripts("${bundle.mainWorker}");`],
        { type: 'text/javascript' },
      ));
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger(duckdb.LogLevel?.WARNING);
      this.db = new duckdb.AsyncDuckDB(logger, worker);
      await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      this.conn = await this.db.connect();
      onStatus?.('Caricamento elenco comuni...');
      await this.ensureRemoteSupport();
      await this.loadComuni();
      onStatus?.(`Elenco comuni pronto (${this.comuni.length}).`);
      return this;
    })();
    try {
      return await this._ready;
    } catch (exc) {
      this._ready = null;
      throw exc instanceof CatastoError ? exc : new CatastoError(String(exc.message || exc));
    }
  }

  /** Carica l'estensione httpfs (per leggere parquet via HTTP). */
  async ensureRemoteSupport() {
    try {
      await this.conn.query('LOAD httpfs');
    } catch (_) {
      try {
        await this.conn.query('INSTALL httpfs; LOAD httpfs');
      } catch (_) {
        // Alcune build di DuckDB-WASM includono httpfs senza doverlo caricare.
      }
    }
  }

  /** Elenco comuni: [{ code, name, regionFile }] ordinato per nome. */
  async loadComuni() {
    if (this.comuni) return this.comuni;
    let rows;
    try {
      rows = await this._queryIndex(CONFIG.indexUrl);
    } catch (exc) {
      // Ripiego: scarica i 86 KB dell'indice e leggili dal filesystem virtuale.
      const response = await fetch(CONFIG.indexUrl);
      if (!response.ok) throw new CatastoError(`indice comuni non scaricabile (${response.status})`);
      const buffer = new Uint8Array(await response.arrayBuffer());
      await this.db.registerFileBuffer('index_comuni.parquet', buffer);
      rows = await this._queryIndex('index_comuni.parquet');
    }
    this.comuni = rows.map((r) => ({
      code: String(r[0] ?? ''),
      name: String(r[1] ?? ''),
      regionFile: String(r[2] ?? ''),
    }));
    return this.comuni;
  }

  async _queryIndex(source) {
    const result = await this.conn.query(
      `SELECT comune, DENOMINAZIONE_IT, file FROM '${source}'`
      + ' ORDER BY DENOMINAZIONE_IT',
    );
    return result.toArray().map((row) => [
      row.comune, row.DENOMINAZIONE_IT, row.file,
    ]);
  }

  /** Cerca un comune per codice o nome (ricerca tollerante). */
  findComuni(query, limit = 30) {
    const list = this.comuni || [];
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const nq = norm(q);
    const starts = [];
    const contains = [];
    for (const c of list) {
      const code = c.code.toLowerCase();
      const name = norm(c.name);
      if (code === q || name === nq) return [c];
      if (code.startsWith(q) || name.startsWith(nq)) starts.push(c);
      else if (name.includes(nq) || code.includes(q)) contains.push(c);
      if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit);
  }

  /** Punto interno (lat, lon) della particella, dal parquet regionale. */
  async findParcels(comuneCode, regionFile, foglio, particella) {
    if (!regionFile) {
      throw new CatastoError("Comune non valido: indicare codice o nome.");
    }
    const foglioNorm = String(foglio ?? '').trim();
    const particellaNorm = String(particella ?? '').trim();
    if (!foglioNorm || !particellaNorm) {
      throw new CatastoError('Specificare sia il foglio sia la particella.');
    }
    const url = CONFIG.parcelsUrl.replace('{file}', regionFile);
    const sql = `SELECT INSPIREID_LOCALID, comune, foglio, particella, x, y
                 FROM '${url}'
                 WHERE comune = ?
                   AND TRY_CAST(TRIM(foglio) AS BIGINT) = TRY_CAST(? AS BIGINT)
                   AND (TRIM(particella) = TRIM(?)
                        OR (TRY_CAST(TRIM(particella) AS BIGINT) IS NOT NULL
                            AND TRY_CAST(TRIM(particella) AS BIGINT) = TRY_CAST(? AS BIGINT)))
                 LIMIT 200`;
    let result;
    try {
      const stmt = await this.conn.prepare(sql);
      result = await stmt.query(comuneCode, foglioNorm, particellaNorm, particellaNorm);
      await stmt.close();
    } catch (exc) {
      throw new CatastoError(`Errore nella ricerca catastale: ${exc.message || exc}`);
    }
    return result.toArray().map((row) => {
      const localId = String(row.INSPIREID_LOCALID ?? '');
      const meta = parseInspireId(localId);
      return {
        localId,
        comuneCode: String(row.comune ?? ''),
        foglio: String(row.foglio ?? meta.foglio).replace(/^0+/, '') || '0',
        particella: String(row.particella ?? meta.particella),
        sezione: meta.sezione,
        lon: Number(row.x) / 1e6,
        lat: Number(row.y) / 1e6,
        label: (() => {
          const sez = meta.sezione ? ` sez.${meta.sezione}` : '';
          return `Foglio ${String(row.foglio ?? meta.foglio).replace(/^0+/, '') || '0'}`
            + ` \u00b7 Particella ${row.particella ?? meta.particella}${sez}`;
        })(),
      };
    });
  }
}
