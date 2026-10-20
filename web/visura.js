// ==========================================================================
// Scheda catastale dei terreni tramite "Variazioni colturali on line".
// --------------------------------------------------------------------------
// Il servizio pubblico dell'Agenzia delle Entrate espone, senza login, la
// qualità di coltura, la classe, la superficie e i redditi delle particelle
// del catasto terreni. Non è una visura ufficiale e non copre tutte le
// particelle: è un riepilogo informativo che l'app mostra accanto al campo.
//
// Flusso (tre richieste, tutte GET pubbliche con CORS aperto):
//   1. provcom.php?prov=<sigla>          elenco dei comuni della provincia
//   2. motore.php?action=search&...      ricerca foglio/particella
//   3. motore.php?id=&idimmobile=...     dettaglio (qualità, classe, redditi)
//
// I risultati sono tenuti in memoria per la durata della pagina; nessun dato
// viene inviato altrove o conservato su disco.
// ==========================================================================

import { CONFIG } from './config.js';
import { provinceOf, serviceProvinces } from './comuni-province.js';

const VISURA = CONFIG.visura || {};
const BASE = VISURA.baseUrl
  || 'https://www1.agenziaentrate.gov.it/servizi/VariazioniColturali/';

export const VISURA_BASE = BASE;
export const OFFICIAL_VISURA_URL = VISURA.officialVisuraUrl
  || 'https://www.agenziaentrate.gov.it/portale/schede/fabbricatiterreni/visura-catastale/visura-catastale-online';
export const OFFICIAL_RENDITE_URL = VISURA.officialRenditeUrl
  || 'https://www.agenziaentrate.gov.it/portale/schede/fabbricatiterreni/visura-catastale/consultazione-rendite-catastali';
export const OFFICIAL_VISURA_LOGIN_URL = VISURA.officialLoginUrl
  || 'https://iampe.agenziaentrate.gov.it/sam/UI/Login?realm=/agenziaentrate';

export class VisuraError extends Error {
  constructor(message, { code = 'visura', cause = null } = {}) {
    super(message);
    this.name = 'VisuraError';
    this.code = code;
    this.cause = cause;
  }
}

// --------------------------------------------------------------------------
// Decodifica dell'HTML/XML restituito dal servizio
// --------------------------------------------------------------------------

// Entità presenti nelle pagine dell'Agenzia (che usa spesso &agrave; ecc.).
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  agrave: '\u00e0', Agrave: '\u00c0',
  egrave: '\u00e8', Egrave: '\u00c8',
  igrave: '\u00ec', Igrave: '\u00cc',
  ograve: '\u00f2', Ograve: '\u00d2',
  ugrave: '\u00f9', Ugrave: '\u00d9',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026',
  laquo: '\u00ab', raquo: '\u00bb', deg: '\u00b0', euro: '\u20ac',
  times: '\u00d7',
};

/** Decodifica le entità HTML/XML (numeriche e nominali). */
export function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]+);/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name.toLowerCase())
          ? NAMED_ENTITIES[name.toLowerCase()]
          : match)
    ));
}

/** Toglie i tag e normalizza gli spazi, lasciando il testo leggibile. */
export function stripTags(html) {
  return decodeHtml(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalizza un testo per confronti (minuscole, senza accenti). */
function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizza il nome di un comune per confrontarlo con l'elenco ufficiale:
 * maiuscole, senza accenti, apostrofi, punti o trattini.
 *   "Bascapè"     -> "BASCAPE"
 *   "BASCAPE'"    -> "BASCAPE"
 *   "Forlì"       -> "FORLI"
 *   "FORLI'"      -> "FORLI"
 */
export function normalizeComuneName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[\u2019'`\u00b4]/g, '')
    .replace(/[.\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --------------------------------------------------------------------------
// Piccolo parser di tabelle HTML (le pagine del servizio hanno una struttura
// fissa; non serve un parser DOM completo e questo codice funziona anche in
// Node, dove DOMParser non è disponibile).
// --------------------------------------------------------------------------

/** Estrae il contenuto di tutte le righe <tr> di un frammento HTML. */
export function extractRows(html) {
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = re.exec(String(html ?? '')))) rows.push(match[1]);
  return rows;
}

/** Estrae le celle (td/th) di una riga. */
export function extractCells(rowHtml) {
  const cells = [];
  const re = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(String(rowHtml ?? '')))) {
    cells.push({
      tag: match[1].toLowerCase(),
      attrs: match[2] || '',
      html: match[3],
      text: stripTags(match[3]),
    });
  }
  return cells;
}

/** Trova la prima tabella che contiene la didascalia indicata. */
export function tableByCaption(html, captionText) {
  const wanted = normalizeText(captionText);
  const re = /<table\b[^>]*>[\s\S]*?<\/table>/gi;
  let match;
  while ((match = re.exec(String(html ?? '')))) {
    const table = match[0];
    const caption = table.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i);
    if (caption && normalizeText(stripTags(caption[1])).includes(wanted)) {
      return table;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Numeri e nomi
// --------------------------------------------------------------------------

/** Converte un numero in formato italiano ("1.234,56") in Number. */
export function parseItalianNumber(value) {
  let text = String(value ?? '').trim();
  if (!text || text === '-' || text === '\u2013' || text === '\u2014') return null;
  text = text
    .replace(/\s/g, '')
    .replace(/\u20ac/g, '')
    .replace(/[^\d,.\-]/g, '');
  if (!text) return null;
  if (text.includes(',')) {
    text = text.replace(/\./g, '').replace(',', '.');
  } else if ((text.match(/\./g) || []).length > 1) {
    text = text.replace(/\./g, '');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizeFoglio(value) {
  return String(value ?? '').trim().replace(/^0+(?=\d)/, '');
}

function normalizeNumero(value) {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text;
}

function splitParticella(value) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d+)\s*[/\-]\s*(\d+)$/);
  if (match) {
    return {
      numero: normalizeNumero(match[1]),
      denominatore: normalizeNumero(match[2]),
    };
  }
  return { numero: normalizeNumero(text), denominatore: '' };
}

/** Elenco dei comuni restituito da provcom.php. */
export function parseProvcomXml(xml) {
  const names = [];
  const re = /<dizione\b[^>]*>([\s\S]*?)<\/dizione>/gi;
  let match;
  while ((match = re.exec(String(xml ?? '')))) {
    const name = stripTags(match[1]);
    if (name) names.push(name);
  }
  return names;
}

/**
 * Sceglie il nome ufficiale del comune nell'elenco della provincia.
 * Restituisce la grafia esatta del servizio (es. "BASCAPE'") o null.
 */
export function matchOfficialComune(names, wanted) {
  const target = normalizeComuneName(wanted);
  if (!target) return null;

  const normalized = names.map((name) => ({ name, key: normalizeComuneName(name) }));
  const exact = normalized.find((item) => item.key === target);
  if (exact) return exact.name;

  // Nomi con parole aggiuntive ("CORNALE E BASTIDA" rispetto a "CORNALE").
  const prefix = normalized.find((item) => (
    item.key.startsWith(`${target} `) || target.startsWith(`${item.key} `)
  ));
  if (prefix) return prefix.name;

  // Tutte le parole del nome cercato compaiono nel nome ufficiale.
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  const byTokens = normalized.find((item) => {
    const tokens = item.key.split(' ').filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => targetTokens.has(token));
  });
  return byTokens ? byTokens.name : null;
}

// --------------------------------------------------------------------------
// URL del servizio
// --------------------------------------------------------------------------

export function buildProvcomUrl(provincia) {
  const params = new URLSearchParams({
    prov: String(provincia || '').trim().toUpperCase(),
    catasto: 'true',
  });
  return `${VISURA_BASE}funzioni/provcom.php?${params.toString()}`;
}

export function buildSearchUrl({
  provincia, comune, sezione = '', foglio = '', numero = '', denominatore = '',
}) {
  const params = new URLSearchParams({
    action: 'search',
    provincia: String(provincia || '').trim().toUpperCase(),
    comune: String(comune || '').trim().toUpperCase(),
  });
  if (sezione) params.set('sezione', String(sezione).trim().toUpperCase());
  if (foglio) params.set('foglio', String(foglio).trim());
  if (numero) params.set('numero', String(numero).trim());
  if (denominatore) params.set('denominatore', String(denominatore).trim());
  return `${VISURA_BASE}motore.php?${params.toString()}`;
}

export function buildDetailUrl({ idimmobile, idcomune, idsezione = '' }) {
  const params = new URLSearchParams({
    id: '',
    idimmobile: String(idimmobile || '').trim(),
    idcomune: String(idcomune || '').trim().toUpperCase(),
    idsezione: String(idsezione || '').trim().toUpperCase(),
  });
  return `${VISURA_BASE}motore.php?${params.toString()}`;
}

// --------------------------------------------------------------------------
// Ricerca e dettaglio
// --------------------------------------------------------------------------

/** Interpreta la pagina dei risultati di ricerca. */
export function parseSearchResults(html) {
  const source = String(html ?? '');
  const table = tableByCaption(source, 'Risultato della ricerca');
  const rows = [];

  if (table) {
    for (const rowHtml of extractRows(table)) {
      const cells = extractCells(rowHtml);
      if (cells.length < 4) continue;
      if (cells[0].tag === 'th') continue;       // intestazione
      const link = rowHtml.match(/href\s*=\s*"([^"]*motore\.php[^"]*)"/i);
      if (!link) continue;

      const href = decodeHtml(link[1]);
      let query;
      try {
        query = new URL(href, VISURA_BASE).searchParams;
      } catch (_) {
        continue;
      }
      rows.push({
        sezione: cells[0].text.toUpperCase(),
        foglio: normalizeFoglio(cells[1].text),
        numero: cells[2].text.trim(),
        denominatore: (cells[3] ? cells[3].text : '').trim(),
        idimmobile: query.get('idimmobile') || '',
        idcomune: (query.get('idcomune') || '').toUpperCase(),
        idsezione: (query.get('idsezione') || '').toUpperCase(),
        url: new URL(href, VISURA_BASE).toString(),
      });
    }
  }

  const totalMatch = source
    .replace(/&nbsp;/gi, ' ')
    .match(/([\d.]+)\s*-\s*([\d.]+)\s+di\s+([\d.]+)\s+trovati/i);
  const total = totalMatch
    ? Number(totalMatch[3].replace(/\./g, ''))
    : rows.length;
  const explicitlyNotFound = /Nessuna particella trovata/i.test(source);
  if (!table && !explicitlyNotFound && !/trovati/i.test(source)) {
    throw new VisuraError(
      'Risposta del servizio non riconosciuta: pagina di ricerca assente.',
      { code: 'parse' },
    );
  }
  const notFound = explicitlyNotFound || (rows.length === 0 && total === 0);

  return { total, rows, notFound };
}

/** Sceglie la riga che corrisponde esattamente alla particella cercata. */
export function pickSearchRow(rows, wanted) {
  const sezione = String(wanted.sezione || '').trim().toUpperCase();
  const foglio = normalizeFoglio(wanted.foglio);
  const numero = normalizeNumero(wanted.numero);
  const denominatore = normalizeNumero(wanted.denominatore);

  return rows.find((row) => (
    (!sezione || String(row.sezione || '').trim().toUpperCase() === sezione)
    && normalizeFoglio(row.foglio) === foglio
    && normalizeNumero(row.numero) === numero
    && (!denominatore || normalizeNumero(row.denominatore) === denominatore)
  )) || null;
}

const HEADER_KEYS = {
  foglio: 'foglio',
  numero: 'numero',
  porzione: 'porzione',
  qualita: 'qualita',
  classe: 'classe',
  ettari: 'ettari',
  are: 'are',
  centiare: 'centiare',
  deduzioni: 'deduzioni',
  'reddito dominicale': 'redditoDominicale',
  'reddito agrario': 'redditoAgrario',
};

function headerKey(text) {
  return normalizeText(text).replace(/[^a-z0-9]+/g, ' ').trim();
}

function cellValue(cells, columns, key) {
  const index = columns[key];
  return index === undefined || !cells[index] ? '' : cells[index].text;
}

function parseRowValues(cells, columns) {
  const ettari = parseItalianNumber(cellValue(cells, columns, 'ettari')) || 0;
  const are = parseItalianNumber(cellValue(cells, columns, 'are')) || 0;
  const centiare = parseItalianNumber(cellValue(cells, columns, 'centiare')) || 0;
  return {
    foglio: normalizeFoglio(cellValue(cells, columns, 'foglio')),
    numero: cellValue(cells, columns, 'numero').trim(),
    porzione: cellValue(cells, columns, 'porzione').trim(),
    qualita: cellValue(cells, columns, 'qualita').trim(),
    classe: cellValue(cells, columns, 'classe').trim(),
    ettari,
    are,
    centiare,
    deduzioni: cellValue(cells, columns, 'deduzioni').trim(),
    redditoDominicale: parseItalianNumber(cellValue(cells, columns, 'redditoDominicale')),
    redditoAgrario: parseItalianNumber(cellValue(cells, columns, 'redditoAgrario')),
    superficieHa: round(ettari + are / 100 + centiare / 10000, 6),
  };
}

/** Somma superfici e redditi delle porzioni. */
export function summarizeRows(rows) {
  return {
    superficieHa: round(rows.reduce((sum, row) => sum + (Number(row.superficieHa) || 0), 0), 6),
    redditoDominicale: round(rows.reduce(
      (sum, row) => sum + (Number(row.redditoDominicale) || 0), 0), 2),
    redditoAgrario: round(rows.reduce(
      (sum, row) => sum + (Number(row.redditoAgrario) || 0), 0), 2),
  };
}

/** Interpreta la tabella "Dettaglio particella". */
export function parseDetail(html) {
  const source = String(html ?? '');
  if (/Nessuna particella trovata/i.test(source)) {
    throw new VisuraError('Particella non trovata nel dettaglio del servizio.', {
      code: 'not-found',
    });
  }
  const table = tableByCaption(source, 'Dettaglio particella');
  if (!table) {
    throw new VisuraError(
      'Risposta del servizio non riconosciuta: tabella di dettaglio assente.',
      { code: 'parse' },
    );
  }

  let columns = null;
  const rows = [];
  let totals = null;

  for (const rowHtml of extractRows(table)) {
    const cells = extractCells(rowHtml);
    if (!cells.length) continue;
    const texts = cells.map((cell) => cell.text);

    if (!columns) {
      const mapped = texts.map(headerKey);
      if (mapped.includes('foglio') && mapped.includes('qualita')) {
        columns = {};
        mapped.forEach((key, index) => {
          const target = HEADER_KEYS[key];
          if (target) columns[target] = index;
        });
        continue;
      }
    }
    if (!columns) continue;

    const first = texts[0] || '';
    const isTotal = /^totale\b/i.test(first)
      || cells.some((cell) => /totali/i.test(cell.attrs));
    if (isTotal) {
      totals = parseRowValues(cells, columns);
      continue;
    }
    if (cells.every((cell) => cell.tag === 'th')) continue;

    const values = parseRowValues(cells, columns);
    if (!values.qualita && !values.classe) continue;
    rows.push(values);
  }

  if (!rows.length) {
    throw new VisuraError('La scheda non contiene porzioni catastali.', {
      code: 'empty',
    });
  }

  const computed = summarizeRows(rows);
  const officialTotals = totals && (
    totals.superficieHa > 0
    || totals.redditoDominicale !== null
    || totals.redditoAgrario !== null
  ) ? totals : null;

  const province = source.match(/Provincia:\s*<strong[^>]*>([\s\S]*?)<\/strong>/i);
  const comune = source.match(/Comune catastale:\s*<strong[^>]*>([\s\S]*?)<\/strong>/i);

  return {
    provincia: province ? stripTags(province[1]) : '',
    comune: comune ? stripTags(comune[1]) : '',
    rows,
    totals: officialTotals || computed,
    computed,
  };
}

// --------------------------------------------------------------------------
// Formattazione per l'interfaccia
// --------------------------------------------------------------------------

/** Numero in formato italiano senza dipendere dal locale del runtime. */
export function formatNumberIt(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '\u2013';
  const fixed = Math.abs(number).toFixed(digits);
  const [integer, decimals] = fixed.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${number < 0 ? '-' : ''}${grouped}${digits ? `,${decimals}` : ''}`;
}

export function formatHa(value) {
  return `${formatNumberIt(value, 4)} ha`;
}

export function formatEuro(value) {
  return Number.isFinite(Number(value)) ? `${formatNumberIt(value, 2)} \u20ac` : '\u2013';
}

export function formatDateTimeIt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Identificativi da copiare e incollare nei servizi dell'Agenzia. */
export function identifiersText({
  comuneCode, comuneName, sezione, foglio, particella,
}) {
  const province = provinceOf(comuneCode);
  const name = comuneName && comuneName !== comuneCode
    ? `${comuneName} (${comuneCode})`
    : comuneCode;
  const parts = splitParticella(particella);
  const particellaLabel = parts.denominatore
    ? `${parts.numero}/${parts.denominatore}`
    : parts.numero;
  return [
    `Comune: ${name}`,
    province ? `Provincia: ${province}` : null,
    sezione ? `Sezione: ${sezione}` : null,
    `Foglio: ${normalizeFoglio(foglio)}`,
    `Particella: ${particellaLabel}`,
  ].filter(Boolean).join('\n');
}

/** Riepilogo testuale della scheda (per gli appunti). */
export function visuraSummaryText(result) {
  if (!result || !result.found) return '';
  const { comune, detail, sourceUrl, fetchedAt } = result;
  const lines = [
    'Scheda catastale terreni (riepilogo informativo, non visura ufficiale)',
    `Comune: ${comune.officialName || comune.name} (${comune.code})`
      + ` \u00b7 provincia ${comune.currentProvince || comune.province}`,
    `Foglio ${detail.rows[0]?.foglio || ''} \u00b7 particella `
      + `${detail.rows[0]?.numero || ''}`,
    '',
  ];
  for (const row of detail.rows) {
    const porzione = row.porzione ? `porzione ${row.porzione} \u00b7 ` : '';
    lines.push(`${porzione}${row.qualita} \u00b7 classe ${row.classe} \u00b7 `
      + `${formatHa(row.superficieHa)} \u00b7 RD ${formatEuro(row.redditoDominicale)} `
      + `\u00b7 RA ${formatEuro(row.redditoAgrario)}`);
  }
  lines.push('');
  lines.push(`Totale: ${formatHa(detail.totals.superficieHa)} \u00b7 `
    + `RD ${formatEuro(detail.totals.redditoDominicale)} \u00b7 `
    + `RA ${formatEuro(detail.totals.redditoAgrario)}`);
  lines.push(`Fonte: ${sourceUrl}`);
  lines.push(`Consultato il ${formatDateTimeIt(fetchedAt)}`);
  return lines.join('\n');
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

function isAbort(exc) {
  return Boolean(exc) && (exc.name === 'AbortError' || exc.code === 'abort');
}

function normalizeParcel(parcel) {
  const comuneCode = String(parcel?.comuneCode || parcel?.comune || '')
    .trim().toUpperCase();
  if (!/^[A-Z]\d{3}$/.test(comuneCode)) {
    throw new VisuraError('Codice catastale del comune mancante o non valido.', {
      code: 'input',
    });
  }
  const foglio = normalizeFoglio(parcel.foglio);
  const { numero, denominatore } = splitParticella(parcel.particella);
  if (!foglio || !numero) {
    throw new VisuraError('Foglio o particella mancanti.', { code: 'input' });
  }
  return {
    comuneCode,
    comuneName: String(parcel.comuneName || '').trim(),
    sezione: String(parcel.sezione || '').trim().toUpperCase().slice(0, 1),
    foglio,
    numero,
    denominatore,
  };
}

function responseCharset(response) {
  let contentType = '';
  try {
    contentType = response?.headers?.get?.('content-type') || '';
  } catch (_) { /* headers non disponibili */ }
  const match = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  return match ? match[1] : 'utf-8';
}

export class VisuraClient {
  /**
   * @param {object} options
   * @param {Function} options.fetchImpl  fetch iniettabile (test)
   * @param {Function} options.now        orologio iniettabile (test)
   */
  constructor({ fetchImpl = (...args) => fetch(...args), now = () => new Date() } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map();
  }

  /** Scarica una pagina rispettando il charset dichiarato. */
  async fetchText(url, { signal } = {}) {
    const timeoutMs = Number(VISURA.timeoutMs) || 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
      } catch (exc) {
        if (controller.signal.aborted) {
          throw new VisuraError(
            'Il servizio Variazioni colturali non ha risposto in tempo.',
            { code: 'timeout', cause: exc },
          );
        }
        throw new VisuraError(
          `Impossibile raggiungere il servizio Variazioni colturali: ${exc.message || exc}`,
          { code: 'network', cause: exc },
        );
      }

      if (!response.ok) {
        throw new VisuraError(
          `Il servizio Variazioni colturali ha risposto HTTP ${response.status}.`,
          { code: 'http' },
        );
      }

      const buffer = await response.arrayBuffer();
      let charset = responseCharset(response);
      try {
        return new TextDecoder(charset).decode(buffer);
      } catch (_) {
        charset = 'utf-8';
        return new TextDecoder(charset).decode(buffer);
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Cerca la particella e ne restituisce la scheda.
   * @param {object} parcel { comuneCode, comuneName, sezione, foglio, particella }
   * @param {object} options { signal, refresh }
   */
  async lookup(parcel, { signal, refresh = false } = {}) {
    const normalized = normalizeParcel(parcel);
    const key = [
      normalized.comuneCode, normalized.sezione, normalized.foglio,
      normalized.numero, normalized.denominatore,
    ].join('|');

    if (!refresh && this.cache.has(key)) return this.cache.get(key);
    if (!refresh && this.inflight.has(key)) return this.inflight.get(key);

    const promise = this._lookup(normalized, { signal });
    this.inflight.set(key, promise);
    try {
      const result = await promise;
      this.cache.set(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }

  async _lookup(parcel, { signal } = {}) {
    const province = provinceOf(parcel.comuneCode);
    if (!province) {
      throw new VisuraError(
        `Provincia non riconosciuta per il comune ${parcel.comuneCode}.`,
        { code: 'province' },
      );
    }

    const candidates = serviceProvinces(province);
    const tried = [];
    let notFound = null;
    let lastError = null;

    for (const candidate of candidates) {
      tried.push(candidate);

      let names;
      try {
        names = parseProvcomXml(await this.fetchText(
          buildProvcomUrl(candidate), { signal },
        ));
      } catch (exc) {
        if (isAbort(exc)) throw exc;
        lastError = exc;
        continue;
      }

      const officialName = matchOfficialComune(
        names, parcel.comuneName || parcel.comuneCode,
      );
      if (!officialName) continue;

      const searchUrl = buildSearchUrl({
        provincia: candidate,
        comune: officialName,
        sezione: parcel.sezione,
        foglio: parcel.foglio,
        numero: parcel.numero,
        denominatore: parcel.denominatore,
      });

      let search;
      try {
        search = parseSearchResults(await this.fetchText(searchUrl, { signal }));
      } catch (exc) {
        if (isAbort(exc)) throw exc;
        lastError = exc;
        continue;
      }

      const comune = {
        code: parcel.comuneCode,
        name: parcel.comuneName || officialName,
        province: candidate,
        currentProvince: province,
        officialName,
        sezione: parcel.sezione,
      };

      if (search.notFound || search.rows.length === 0) {
        notFound = {
          found: false,
          reason: 'not-found',
          comune,
          search: { ...search, url: searchUrl },
          sourceUrl: searchUrl,
          fetchedAt: this.now().toISOString(),
          tried: [...tried],
        };
        // Con più province storiche (BT, SU) si prova anche la successiva:
        // il nome può esistere in un elenco diverso da quello principale.
        continue;
      }

      const row = pickSearchRow(search.rows, parcel);
      if (!row) {
        return {
          found: false,
          reason: 'ambiguous',
          comune,
          search: { ...search, url: searchUrl },
          sourceUrl: searchUrl,
          fetchedAt: this.now().toISOString(),
          tried: [...tried],
        };
      }

      const detailUrl = row.url || buildDetailUrl(row);
      let detail;
      try {
        detail = parseDetail(await this.fetchText(detailUrl, { signal }));
      } catch (exc) {
        if (isAbort(exc)) throw exc;
        lastError = exc;
        continue;
      }

      return {
        found: true,
        comune,
        search: { ...search, url: searchUrl },
        detail,
        sourceUrl: detailUrl,
        fetchedAt: this.now().toISOString(),
        tried: [...tried],
      };
    }

    if (notFound) return notFound;
    throw lastError || new VisuraError(
      `Comune ${parcel.comuneName || parcel.comuneCode} non trovato `
      + `nell'archivio Variazioni colturali (province provate: ${tried.join(', ')}).`,
      { code: 'comune-not-found' },
    );
  }
}
