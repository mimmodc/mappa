// ==========================================================================
// Mappa Campi Agricoli v2.1 - versione web
// --------------------------------------------------------------------------
// Logica applicativa: modalita' mappa, ricerca catastale, selezione del campo,
// overlay delle particelle (gruppi "campo" e "vista"), dettagli, esportazione,
// scheda colturale dei terreni (Variazioni colturali on line).
// ==========================================================================

import { CONFIG, COLORS, loadProxy, proxyFromQuery } from './config.js';
import { geometryMeasure, ringCentroid, bboxOf, fmtNum } from './geo.js';
import { WfsClient } from './wfs.js';
import { CatastoService } from './catasto.js';
import {
  VisuraClient, VisuraError, OFFICIAL_VISURA_URL, OFFICIAL_RENDITE_URL,
  identifiersText, visuraSummaryText, formatHa, formatEuro, formatDateTimeIt,
} from './visura.js';

const $ = (id) => document.getElementById(id);

// Larghezza del pannello laterale (px). Viene ricordata fra le visite.
const PANEL_W_KEY = 'mappa_campo_agricolo.panelWidth';
const PANEL_W_DEFAULT = 390;
const PANEL_W_MIN = 260;
const PANEL_W_MAX = 720;

const state = {
  mode: 'move',
  showParcels: true,
  field: null,            // { ring, interiors, parcel }
  draft: [],              // vertici in corso di disegno
  fieldIds: new Set(),    // particelle del gruppo "campo"
  catasto: null,
  catastoReady: false,
  visuraResult: null,     // ultima scheda colturale caricata
};

let map = null;
let fieldLayer = null;
let viewLayer = null;
let draftLayer = null;
let draftLine = null;
let basemapLayer = null;
let viewTimer = null;
let viewToken = 0;
let fieldToken = 0;
let viewController = null;
let fieldController = null;
let wfs = null;
let visuraClient = null;
let visuraToken = 0;

// --------------------------------------------------------------------------
// Utilità di interfaccia
// --------------------------------------------------------------------------
function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('err', Boolean(isError));
}

function busy(on) {
  document.body.style.cursor = on ? 'progress' : '';
}

// --------------------------------------------------------------------------
// Avvio
// --------------------------------------------------------------------------
function init() {
  proxyFromQuery();                 // ?proxy=... ha la precedenza (comodo per le prove)
  wfs = new WfsClient(() => loadProxy());
  visuraClient = new VisuraClient();

  initMap();
  initBasemaps();
  initControls();
  initPanelResizer();
  updateVisuraState();
  setStatus('Pronto. Caricamento dell\'indice dei comuni...');
  initCatasto();
}

// --------------------------------------------------------------------------
// Pannello laterale ridimensionabile
// --------------------------------------------------------------------------
function initPanelResizer() {
  const panel = document.querySelector('.panel');
  const resizer = $('panel-resizer');
  if (!panel || !resizer) return;

  const maxWidth = () => Math.max(PANEL_W_MIN,
    Math.min(PANEL_W_MAX, Math.round(window.innerWidth * 0.7)));
  let width = PANEL_W_DEFAULT;

  /** Applica una larghezza (limitata ai minimi/massimi) e, se richiesto, la salva. */
  function apply(value, persist = false) {
    width = Math.max(PANEL_W_MIN, Math.min(maxWidth(), Math.round(value)));
    document.documentElement.style.setProperty('--panel-w', `${width}px`);
    resizer.setAttribute('aria-valuenow', String(width));
    resizer.setAttribute('aria-valuemin', String(PANEL_W_MIN));
    resizer.setAttribute('aria-valuemax', String(maxWidth()));
    if (persist) {
      try { localStorage.setItem(PANEL_W_KEY, String(width)); } catch (_) { /* ignora */ }
    }
  }

  let salvata = NaN;
  try { salvata = Number(localStorage.getItem(PANEL_W_KEY)); } catch (_) { /* ignora */ }
  apply(Number.isFinite(salvata) && salvata > 0 ? salvata : PANEL_W_DEFAULT);

  // Durante il trascinamento arrivano molti eventi: la mappa viene ridisegnata
  // al massimo una volta per fotogramma.
  let pending = false;
  function refreshMap() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (map) map.invalidateSize();
    });
  }

  let dragging = false;
  resizer.addEventListener('pointerdown', (event) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    try { resizer.setPointerCapture(event.pointerId); } catch (_) { /* ignora */ }
    event.preventDefault();
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    apply(event.clientX - panel.getBoundingClientRect().left);
    refreshMap();
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    try { resizer.releasePointerCapture(event.pointerId); } catch (_) { /* ignora */ }
    apply(width, true);
    refreshMap();
  };
  resizer.addEventListener('pointerup', stop);
  resizer.addEventListener('pointercancel', stop);

  // Doppio clic: torna alla larghezza predefinita.
  resizer.addEventListener('dblclick', () => {
    apply(PANEL_W_DEFAULT, true);
    refreshMap();
  });

  // Tastiera (accessibilità): frecce per ridimensionare, Home per il default.
  resizer.addEventListener('keydown', (event) => {
    const passo = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft') apply(width - passo, true);
    else if (event.key === 'ArrowRight') apply(width + passo, true);
    else if (event.key === 'Home') apply(PANEL_W_DEFAULT, true);
    else return;
    event.preventDefault();
    refreshMap();
  });

  // Se la finestra si restringe, riporta la larghezza entro i limiti.
  window.addEventListener('resize', () => {
    apply(width);
    refreshMap();
  });
}

function initMap() {
  // I controlli zoom vanno in alto a destra: in alto a sinistra c'e' il
  // pulsante del pannello e i due si coprirebbero a vicenda (Leaflet usa uno
  // z-index piu' alto del pulsante).
  map = L.map('map', { zoomControl: false, attributionControl: true })
    .setView(CONFIG.italyCenter, CONFIG.italyZoom);
  L.control.zoom({ position: 'topright' }).addTo(map);

  fieldLayer = L.layerGroup().addTo(map);   // campo + particelle confinanti
  viewLayer = L.layerGroup().addTo(map);    // particelle della vista (zoom >= 16)
  draftLayer = L.layerGroup().addTo(map);   // disegno in corso

  map.on('click', onMapClick);
  map.on('moveend zoomend', onMapMoved);
  map.on('zoomend', () => { $('zoom').textContent = `zoom ${map.getZoom()}`; });
  $('zoom').textContent = `zoom ${map.getZoom()}`;
}

function initBasemaps() {
  const select = $('sel-basemap');
  const names = Object.keys(CONFIG.basemaps);
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  }
  select.value = names[0];
  basemapLayer = L.tileLayer(CONFIG.basemaps[names[0]].url, {
    maxZoom: CONFIG.basemaps[names[0]].maxZoom,
    attribution: CONFIG.attribution,
  }).addTo(map);
  select.addEventListener('change', () => {
    if (basemapLayer) map.removeLayer(basemapLayer);
    const cfg = CONFIG.basemaps[select.value];
    basemapLayer = L.tileLayer(cfg.url, {
      maxZoom: cfg.maxZoom, attribution: CONFIG.attribution,
    }).addTo(map);
    basemapLayer.bringToBack();
  });
}

function initControls() {
  document.querySelectorAll('input[name=mode]').forEach((radio) => {
    radio.addEventListener('change', () => setMode(radio.value));
  });

  $('btn-cerca').addEventListener('click', onSearch);
  $('in-particella').addEventListener('keydown', (e) => { if (e.key === 'Enter') onSearch(); });
  $('list-risultati').addEventListener('change', onResultSelected);

  $('btn-chiudi').addEventListener('click', closeDraft);
  $('btn-annulla-punto').addEventListener('click', undoDraftPoint);
  $('btn-zoom-campo').addEventListener('click', zoomToField);
  $('btn-cancella').addEventListener('click', () => clearField(true));
  $('btn-italia').addEventListener('click', () => {
    map.setView(CONFIG.italyCenter, CONFIG.italyZoom);
  });

  $('chk-particelle').addEventListener('change', (e) => {
    state.showParcels = e.target.checked;
    if (!state.showParcels) {
      viewLayer.clearLayers();
      fieldLayer.clearLayers();
      state.fieldIds.clear();
      setStatus('Visualizzazione dei confini catastali disattivata.');
    } else {
      setStatus('Visualizzazione dei confini catastali attiva.');
      if (state.field) scheduleFieldParcels();
    }
  });

  $('btn-geojson').addEventListener('click', exportGeoJson);
  $('btn-dettagli').addEventListener('click', copyDetails);

  $('btn-visura').addEventListener('click', () => onVisura());
  $('btn-copia-ident').addEventListener('click', copyIdentifiers);
  $('out-visura').addEventListener('click', onVisuraAction);
  $('link-visura-ufficiale').href = OFFICIAL_VISURA_URL;
  $('link-rendite').href = OFFICIAL_RENDITE_URL;
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-visura');
  });

  $('btn-help').addEventListener('click', () => { $('modal').hidden = false; });
  $('modal-close').addEventListener('click', () => { $('modal').hidden = true; });
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) $('modal').hidden = true;
  });

  $('btn-toggle-panel').addEventListener('click', () => {
    document.querySelector('.panel').classList.toggle('hidden');
    setTimeout(() => map.invalidateSize(), 250);
  });
}

async function initCatasto() {
  state.catasto = new CatastoService();
  try {
    await state.catasto.init((msg) => setStatus(msg));
    state.catastoReady = true;
    fillComuniDatalist(state.catasto.comuni);
    updateVisuraState();
    if (loadProxy()) {
      setStatus(`Pronto. ${state.catasto.comuni.length} comuni disponibili.`);
    } else {
      // Senza proxy l'app puo' cercare le particelle ma non leggerne i
      // confini: meglio dirlo subito, invece di attendere la richiesta al WFS
      // (che fallisce dopo alcuni secondi).
      setStatus(`Pronto. ${state.catasto.comuni.length} comuni disponibili, ma il `
        + 'servizio dei confini catastali non è configurato: le particelle '
        + 'non potranno essere visualizzate.', true);
    }
  } catch (exc) {
    setStatus(`Ricerca per attributi non disponibile: ${exc.message || exc}`, true);
  }
}

function fillComuniDatalist(comuni) {
  const datalist = $('dl-comuni');
  const fragment = document.createDocumentFragment();
  for (const c of comuni) {
    const option = document.createElement('option');
    option.value = `${c.name} (${c.code})`;
    fragment.appendChild(option);
  }
  datalist.appendChild(fragment);
}

// --------------------------------------------------------------------------
// Modalità
// --------------------------------------------------------------------------
function setMode(mode) {
  state.mode = mode;
  $('draw-tools').hidden = mode !== 'draw';
  if (mode !== 'draw') clearDraft();
  map.getContainer().style.cursor = mode === 'select' ? 'crosshair'
    : (mode === 'draw' ? 'crosshair' : '');
  if (mode === 'draw') setStatus('Disegna il campo: clicca i vertici sulla mappa.');
  else if (mode === 'select') setStatus('Clicca su un campo per selezionarlo.');
  else setStatus('Modalità spostamento.');
}

function onMapClick(event) {
  const { lat, lng } = event.latlng;
  if (state.mode === 'draw') {
    addDraftPoint(lat, lng);
  } else if (state.mode === 'select') {
    selectAt(lat, lng);
  }
}

// --------------------------------------------------------------------------
// Disegno manuale
// --------------------------------------------------------------------------
function addDraftPoint(lat, lon) {
  state.draft.push([lat, lon]);
  drawDraft();
  setStatus(`Vertici: ${state.draft.length}.`);
}

function undoDraftPoint() {
  state.draft.pop();
  drawDraft();
}

function clearDraft() {
  state.draft = [];
  drawDraft();
}

function drawDraft() {
  draftLayer.clearLayers();
  draftLine = null;
  const points = state.draft;
  if (!points.length) return;
  if (points.length >= 2) {
    draftLine = L.polyline(points, {
      color: COLORS.draftLine, weight: 2, dashArray: '5,4',
    }).addTo(draftLayer);
  }
  for (const [lat, lon] of points) {
    L.circleMarker([lat, lon], {
      radius: 4, color: COLORS.draftLine, fillColor: '#fff', fillOpacity: 1, weight: 2,
    }).addTo(draftLayer);
  }
}

function closeDraft() {
  if (state.draft.length < 3) {
    setStatus('Servono almeno 3 vertici per chiudere il campo.', true);
    return;
  }
  const ring = state.draft.slice();
  clearDraft();
  applyField({ ring, interiors: [], parcel: null }, 'Campo disegnato a mano');
}

// --------------------------------------------------------------------------
// Ricerca catastale
// --------------------------------------------------------------------------
function resolveComune(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // Il valore scelto dall'elenco a comparsa ha la forma "Pavia (G388)".
  const match = raw.match(/^(.*?)\s*\(([A-Za-z]\d{3})\)\s*$/);
  if (match) {
    const code = match[2];
    const byCode = state.catasto.findComuni(code, 5)
      .find((c) => c.code.toLowerCase() === code.toLowerCase());
    if (byCode) return byCode;
    const byName = state.catasto.findComuni(match[1], 3);
    if (byName.length) return byName[0];
  }
  const matches = state.catasto.findComuni(raw, 5);
  return matches.length ? matches[0] : null;
}

async function onSearch() {
  if (!state.catastoReady) {
    setStatus('Elenco comuni non ancora pronto: attendi qualche istante.', true);
    return;
  }
  const comuneText = $('in-comune').value.trim();
  const foglio = $('in-foglio').value.trim();
  const particella = $('in-particella').value.trim();
  const comune = resolveComune(comuneText);
  if (!comune) {
    setStatus(`Comune non trovato: "${comuneText}".`, true);
    return;
  }
  try {
    busy(true);
    setStatus(`Ricerca ${comune.name} foglio ${foglio} particella ${particella}...`);
    const rows = await state.catasto.findParcels(
      comune.code, comune.regionFile, foglio, particella,
    );
    const select = $('list-risultati');
    select.innerHTML = '';
    if (!rows.length) {
      $('out-risultati').hidden = true;
      setStatus(`Nessuna particella ${particella} nel foglio ${foglio} di ${comune.name}.`, true);
      return;
    }
    rows.forEach((row, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${comune.name} \u00b7 ${row.label}`;
      select.appendChild(option);
    });
    select.dataset.rows = JSON.stringify(rows.map((r, i) => ({
      i, localId: r.localId, lat: r.lat, lon: r.lon, label: r.label,
    })));
    $('out-risultati').hidden = false;
    setStatus(`${rows.length} risultato/i. Scegline uno dall'elenco.`);
  } catch (exc) {
    setStatus(exc.message || String(exc), true);
  } finally {
    busy(false);
  }
}

async function onResultSelected(event) {
  const select = event.target;
  const rows = JSON.parse(select.dataset.rows || '[]');
  const row = rows[Number(select.value)];
  if (!row) return;
  map.setView([row.lat, row.lon], Math.max(map.getZoom(), 17));
  await loadParcelGeometry(row.localId, row.lat, row.lon);
}

async function selectAt(lat, lon) {
  try {
    busy(true);
    setStatus('Ricerca della particella catastale nel punto indicato...');
    const parcel = await wfs.identifyAt(lat, lon);
    if (!parcel) {
      setStatus('Nessuna particella catastale trovata in questo punto.', true);
      return;
    }
    applyField({
      ring: parcel.exterior,
      interiors: parcel.interiors,
      parcel,
    }, 'Particella dal catasto');
  } catch (exc) {
    setStatus(explainWfsError(exc), true);
  } finally {
    busy(false);
  }
}

async function loadParcelGeometry(localId, lat, lon) {
  try {
    busy(true);
    setStatus('Recupero del confine della particella dal WFS catastale...');
    const parcel = await wfs.fetchParcelByLocalId(localId, lat, lon, 0.0002);
    if (!parcel) {
      setStatus('Confine non disponibile dal WFS.', true);
      return;
    }
    applyField({
      ring: parcel.exterior,
      interiors: parcel.interiors,
      parcel,
    }, 'Particella dal catasto');
  } catch (exc) {
    setStatus(explainWfsError(exc), true);
  } finally {
    busy(false);
  }
}

function explainWfsError(exc) {
  const message = exc && exc.message ? exc.message : String(exc);
  if (!loadProxy()) {
    return `Servizio dei confini catastali non configurato. `
      + `Dettaglio: ${message}`;
  }
  return `Il servizio dei confini catastali è momentaneamente non raggiungibile: `
    + `riprova tra qualche istante. Dettaglio: ${message}`;
}

// --------------------------------------------------------------------------
// Campo selezionato
// --------------------------------------------------------------------------
function applyField(field, reason) {
  state.field = field;
  // L'area tiene conto degli eventuali "buchi" (gml:interior), come nell'app
  // desktop: sottrae l'area degli anelli interni invece di usare il solo
  // anello esterno (che sovrastimerebbe la particella).
  const { area, perimeter } = geometryMeasure(field.ring, field.interiors || []);
  const centroid = ringCentroid(field.ring);
  field.area = area;
  field.perimeter = perimeter;
  field.centroid = centroid;

  drawFieldPolygon();
  updateDetails(reason);
  $('btn-geojson').disabled = false;
  $('btn-dettagli').disabled = false;
  updateVisuraState({ reset: true });
  scheduleFieldParcels();
  // Il gruppo "vista" esclude le particelle del campo: cambiando campo va
  // ridisegnato, altrimenti resterebbe potato secondo il campo precedente.
  scheduleViewportParcels();
}

function drawFieldPolygon() {
  fieldLayer.clearLayers();
  state.fieldIds.clear();
  const field = state.field;
  const latlngs = [field.ring, ...(field.interiors || [])];
  L.polygon(latlngs, {
    color: COLORS.fieldLine, weight: 3, fillColor: COLORS.fieldFill,
    fillOpacity: 0.28, interactive: false,
  }).addTo(fieldLayer);
}

function updateDetails(reason) {
  const field = state.field;
  const { area, perimeter, centroid } = field;
  const hectares = area / 10000;
  const label = hectares >= 0.1
    ? `${fmtNum(hectares)} ha`
    : `${fmtNum(area)} m&sup2;`;
  $('d-area').innerHTML = `${label} <span class="hint">(${fmtNum(area)} m&sup2;)</span>`;
  $('d-perimetro').textContent = `${fmtNum(perimeter)} m`;
  $('d-centroide').textContent =
    `${centroid[0].toFixed(6)}, ${centroid[1].toFixed(6)}`;
  $('d-stato').textContent = reason || 'Campo disponibile.';
  if (field.parcel) {
    const sez = field.parcel.sezione ? ` sez.${field.parcel.sezione}` : '';
    $('d-particella').textContent =
      `comune ${field.parcel.comune} \u00b7 foglio `
      + `${field.parcel.foglio} \u00b7 part. ${field.parcel.particella}${sez}`;
  } else {
    $('d-particella').textContent = 'non catastale (disegnato a mano)';
  }
  setStatus(`Campo: ${label} \u00b7 perimetro ${fmtNum(perimeter)} m.`);
}

function zoomToField() {
  if (!state.field) { setStatus('Nessun campo selezionato.', true); return; }
  const [latMin, lonMin, latMax, lonMax] = bboxOf(state.field.ring);
  map.fitBounds(L.latLngBounds([latMin, lonMin], [latMax, lonMax]).pad(0.25));
}

function clearField(announce = false) {
  state.field = null;
  fieldLayer.clearLayers();
  viewLayer.clearLayers();
  state.fieldIds.clear();
  $('btn-geojson').disabled = true;
  $('btn-dettagli').disabled = true;
  $('d-area').textContent = '\u2013';
  $('d-perimetro').textContent = '\u2013';
  $('d-centroide').textContent = '\u2013';
  $('d-particella').textContent = '\u2013';
  $('d-stato').textContent = 'Nessun campo selezionato.';
  resetVisura();
  $('visura-ident').textContent =
    'Seleziona una particella catastale dalla mappa o dalla ricerca.';
  if (announce) setStatus('Campo cancellato.');
}

// --------------------------------------------------------------------------
// Gruppo "campo": campo + particelle confinanti (sempre visibile)
// --------------------------------------------------------------------------
function scheduleFieldParcels() {
  if (fieldController) fieldController.abort();
  const token = ++fieldToken;
  setTimeout(() => loadFieldParcels(token), 300);
}

async function loadFieldParcels(token) {
  if (!state.showParcels || !state.field) return;
  const [latMin, lonMin, latMax, lonMax] = bboxOf(state.field.ring);
  const half = Math.max(latMax - latMin, lonMax - lonMin) / 2;
  const margin = Math.max(half * CONFIG.fieldMarginFactor, CONFIG.fieldMarginMin);
  fieldController = new AbortController();
  try {
    const parcels = await wfs.fetchArea(
      latMin - margin, lonMin - margin, latMax + margin, lonMax + margin,
      CONFIG.parcelViewMaxFeatures, null, fieldController.signal,
      2,   // gruppo "campo": i confini attorno al campo non devono mancare
    );
    if (token !== fieldToken || !state.showParcels) return;
    fieldLayer.clearLayers();
    state.fieldIds.clear();
    drawFieldPolygon();
    for (const parcel of parcels) {
      addParcelOutline(fieldLayer, parcel, true);
      state.fieldIds.add(parcel.localId);
    }
    pruneViewDuplicates();
    if (parcels.length) {
      setStatus(`Campo e zone confinanti: ${parcels.length} particelle catastali.`);
    }
  } catch (exc) {
    if (exc && exc.name === 'AbortError') return;
    // Silenzioso come l'app desktop: il gruppo "campo" non si svuota.
  }
}

/**
 * Toglie dal gruppo "vista" le particelle che appartengono anche al gruppo
 * "campo". I due gruppi si caricano in parallelo: se la "vista" termina prima,
 * l'elenco del campo non e' ancora completo e la stessa particella verrebbe
 * disegnata due volte (confine piu' marcato del dovuto).
 */
function pruneViewDuplicates() {
  for (const layer of viewLayer.getLayers()) {
    const id = layer.options && layer.options.localId;
    if (id && state.fieldIds.has(id)) viewLayer.removeLayer(layer);
  }
}

function addParcelOutline(layer, parcel, withTooltip) {
  const latlngs = [parcel.exterior, ...(parcel.interiors || [])];
  const polygon = L.polygon(latlngs, {
    color: COLORS.parcelLine, weight: 1, opacity: 0.9,
    fill: false, interactive: Boolean(withTooltip),
    localId: parcel.localId,      // utile per diagnostica e controlli
  });
  if (withTooltip) {
    const sez = parcel.sezione ? ` sez.${parcel.sezione}` : '';
    const foglio = String(parcel.foglio).replace(/^0+/, '') || '0';
    polygon.bindTooltip(
      `Foglio ${foglio} \u00b7 Particella ${parcel.particella}${sez}`,
      { className: 'parcel-tip', sticky: true },
    );
  }
  polygon.addTo(layer);
  return polygon;
}

// --------------------------------------------------------------------------
// Gruppo "vista": particelle della visuale (solo a zoom >= 16)
// --------------------------------------------------------------------------
function onMapMoved() {
  if (!state.showParcels) return;
  scheduleViewportParcels();
}

/** Riprogramma il caricamento del gruppo "vista" (700 ms di quiete). */
function scheduleViewportParcels() {
  if (viewTimer) clearTimeout(viewTimer);
  viewTimer = setTimeout(loadViewportParcels, 700);
}

async function loadViewportParcels() {
  viewTimer = null;
  if (!state.showParcels) return;
  if (map.getZoom() < CONFIG.parcelViewMinZoom) {
    // A questa scala il WFS non fornisce dati: si svuota il gruppo "vista" per
    // non lasciare in mappa confini di altre zone. Il gruppo "campo" resta.
    viewLayer.clearLayers();
    return;
  }
  const bounds = map.getBounds();
  const latMin = bounds.getSouth();
  const lonMin = bounds.getWest();
  const latMax = bounds.getNorth();
  const lonMax = bounds.getEast();
  if (latMax <= latMin || lonMax <= lonMin) return;

  if (viewController) viewController.abort();
  viewController = new AbortController();
  const token = ++viewToken;
  try {
    const parcels = await wfs.fetchArea(
      latMin, lonMin, latMax, lonMax, CONFIG.parcelViewMaxFeatures,
      null, viewController.signal,
    );
    if (token !== viewToken || !state.showParcels) return;
    viewLayer.clearLayers();
    let drawn = 0;
    for (const parcel of parcels) {
      if (state.fieldIds.has(parcel.localId)) continue;
      addParcelOutline(viewLayer, parcel, false);
      drawn += 1;
    }
    if (drawn) setStatus(`${drawn} particelle catastali nella vista.`);
    else if (!state.fieldIds.size) setStatus('Nessuna particella catastale in questa vista.');
  } catch (exc) {
    if (exc && exc.name === 'AbortError') return;
    if (token !== viewToken) return;
    viewLayer.clearLayers();
    setStatus(explainWfsError(exc), true);
  }
}

// --------------------------------------------------------------------------
// Esportazione e dettagli
// --------------------------------------------------------------------------
function fieldFeature() {
  const field = state.field;
  const ring = field.ring.map(([lat, lon]) => [lon, lat]);
  ring.push(ring[0]);
  const coordinates = [ring];
  for (const hole of field.interiors || []) {
    const h = hole.map(([lat, lon]) => [lon, lat]);
    h.push(h[0]);
    coordinates.push(h);
  }
  return {
    type: 'Feature',
    properties: {
      area_m2: Number(field.area.toFixed(2)),
      area_ha: Number((field.area / 10000).toFixed(4)),
      perimetro_m: Number(field.perimeter.toFixed(2)),
      centroide_lat: Number(field.centroid[0].toFixed(6)),
      centroide_lon: Number(field.centroid[1].toFixed(6)),
      comune: field.parcel?.comune || null,
      sezione: field.parcel?.sezione || null,
      foglio: field.parcel?.foglio || null,
      particella: field.parcel?.particella || null,
      inspire_id: field.parcel?.localId || null,
      fonte: field.parcel ? 'Catasto (Agenzia delle Entrate)' : 'disegnato a mano',
      generato_da: 'Mappa Campi Agricoli v2.1 web',
    },
    geometry: { type: 'Polygon', coordinates },
  };
}

function exportGeoJson() {
  if (!state.field) return;
  const data = {
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: [fieldFeature()],
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `campo_${stamp}.geojson`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  setStatus('GeoJSON esportato.');
}

function copyDetails() {
  if (!state.field) return;
  const f = fieldFeature().properties;
  const text = [
    `Area: ${fmtNum(f.area_m2)} m2 (${fmtNum(f.area_ha)} ha)`,
    `Perimetro: ${fmtNum(f.perimetro_m)} m`,
    `Centroide: ${f.centroide_lat}, ${f.centroide_lon}`,
    f.inspire_id
      ? `Catasto: comune ${f.comune}, foglio ${f.foglio}, particella ${f.particella}`
      : 'Campo disegnato a mano',
  ].join('\n');
  navigator.clipboard?.writeText(text)
    .then(() => setStatus('Dettagli copiati negli appunti.'))
    .catch(() => setStatus('Impossibile copiare: selezione manuale.', true));
}

// --------------------------------------------------------------------------
// Scheda catastale dei terreni (Variazioni colturali on line)
// --------------------------------------------------------------------------
function parcelForVisura() {
  const parcel = state.field && state.field.parcel;
  if (!parcel) return null;
  let comuneName = '';
  if (state.catasto && state.catasto.comuni) {
    const found = state.catasto.findComuni(parcel.comune, 5)
      .find((c) => c.code.toUpperCase() === String(parcel.comune).toUpperCase());
    if (found) comuneName = found.name;
  }
  return {
    comuneCode: parcel.comune,
    comuneName,
    sezione: parcel.sezione || '',
    foglio: parcel.foglio,
    particella: parcel.particella,
  };
}

function updateVisuraState({ reset = false } = {}) {
  if (reset) resetVisura();
  const parcel = parcelForVisura();
  const hasParcel = Boolean(parcel);
  $('btn-visura').disabled = !hasParcel;
  $('btn-copia-ident').disabled = !hasParcel;
  $('visura-ident').textContent = hasParcel
    ? identifiersText(parcel)
    : 'Seleziona una particella catastale dalla mappa o dalla ricerca.';
}

function resetVisura() {
  visuraToken += 1;
  state.visuraResult = null;
  const out = $('out-visura');
  if (out) {
    out.hidden = true;
    out.replaceChildren();
  }
  const status = $('visura-status');
  if (status) {
    status.textContent = '';
    status.classList.remove('err');
  }
  const hasParcel = Boolean(state.field && state.field.parcel);
  $('btn-visura').disabled = !hasParcel;
  $('btn-copia-ident').disabled = !hasParcel;
}

function setVisuraStatus(text, isError = false) {
  const element = $('visura-status');
  element.textContent = text;
  element.classList.toggle('err', Boolean(isError));
}

async function onVisura(refresh = false) {
  const token = ++visuraToken;
  let parcel = parcelForVisura();
  if (!parcel) {
    setVisuraStatus('Seleziona prima una particella catastale.', true);
    return;
  }

  // Il nome ufficiale del comune serve al servizio: se l'indice non è ancora
  // pronto (può capitare selezionando subito una particella dal WFS), attende.
  if (!parcel.comuneName && state.catasto) {
    setVisuraStatus('Caricamento dell\'elenco dei comuni...');
    try {
      await state.catasto.init();
    } catch (_) { /* si prova comunque con il codice */ }
    if (token !== visuraToken) return;
    parcel = parcelForVisura();
  }
  if (!parcel.comuneName) {
    setVisuraStatus('Elenco dei comuni non disponibile: attendi qualche '
      + 'istante e riprova.', true);
    return;
  }

  state.visuraResult = null;
  const out = $('out-visura');
  out.hidden = true;
  out.replaceChildren();
  $('btn-visura').disabled = true;
  setVisuraStatus('Consultazione del servizio Variazioni colturali...');

  try {
    const result = await visuraClient.lookup(parcel, { refresh });
    if (token !== visuraToken) return;
    state.visuraResult = result;

    if (!result.found) {
      renderVisuraNotFound(result);
      setVisuraStatus(result.reason === 'ambiguous'
        ? 'La ricerca ha restituito più particelle: usa i servizi ufficiali.'
        : 'Particella non presente nell\'archivio Variazioni colturali '
          + '(copertura parziale).');
      return;
    }

    renderVisura(result);
    setVisuraStatus(result.detail.rows.length > 1
      ? `Scheda trovata: ${result.detail.rows.length} porzioni catastali.`
      : 'Scheda trovata.');
  } catch (exc) {
    if (token !== visuraToken) return;
    const message = exc instanceof VisuraError
      ? exc.message
      : (exc && exc.message ? exc.message : String(exc));
    setVisuraStatus(`${message} Puoi usare i link ai servizi ufficiali qui sotto.`, true);
    renderVisuraError(message);
  } finally {
    if (token === visuraToken) $('btn-visura').disabled = false;
  }
}

function onVisuraAction(event) {
  const button = event.target.closest('button[data-visura-action]');
  if (!button) return;
  const action = button.dataset.visuraAction;
  if (action === 'copy') copyVisura();
  else if (action === 'print') printVisura();
  else if (action === 'refresh') onVisura(true);
}

function copyIdentifiers() {
  const parcel = parcelForVisura();
  if (!parcel) return;
  const text = identifiersText(parcel);
  let write = null;
  try {
    write = navigator.clipboard && navigator.clipboard.writeText(text);
  } catch (_) { /* clipboard non disponibile */ }
  if (!write) {
    setVisuraStatus('Copia non disponibile in questo browser: seleziona il '
      + 'testo manualmente.', true);
    return;
  }
  write
    .then(() => setVisuraStatus('Identificativi copiati: puoi incollarli nei '
      + 'servizi dell\'Agenzia.'))
    .catch(() => setVisuraStatus('Impossibile copiare: seleziona il testo '
      + 'manualmente.', true));
}

function copyVisura() {
  if (!state.visuraResult || !state.visuraResult.found) return;
  const text = visuraSummaryText(state.visuraResult);
  let write = null;
  try {
    write = navigator.clipboard && navigator.clipboard.writeText(text);
  } catch (_) { /* clipboard non disponibile */ }
  if (!write) {
    setVisuraStatus('Copia non disponibile in questo browser: seleziona il '
      + 'testo manualmente.', true);
    return;
  }
  write
    .then(() => setVisuraStatus('Scheda copiata negli appunti.'))
    .catch(() => setVisuraStatus('Impossibile copiare: seleziona il testo '
      + 'manualmente.', true));
}

function printVisura() {
  if (!state.visuraResult || !state.visuraResult.found) return;
  document.body.classList.add('printing-visura');
  requestAnimationFrame(() => window.print());
}

/** Crea un elemento con attributi e testo (niente innerHTML su dati esterni). */
function make(tag, attrs = {}, text = null) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else element.setAttribute(key, String(value));
  }
  if (text !== null && text !== undefined) element.textContent = String(text);
  return element;
}

function renderVisura(result) {
  const out = $('out-visura');
  out.replaceChildren();

  const first = result.detail.rows[0] || {};
  const sezione = result.comune.sezione ? ` \u00b7 sezione ${result.comune.sezione}` : '';
  const head = make('div', { class: 'visura-head' });
  head.append(
    make('strong', {},
      `Comune di ${result.comune.officialName || result.comune.name} `
      + `(${result.comune.currentProvince || result.comune.province})`),
    make('span', {},
      `Codice catastale ${result.comune.code}${sezione} \u00b7 `
      + 'fonte: Variazioni colturali on line'),
  );
  out.append(head);

  const wrap = make('div', { class: 'visura-table-wrap' });
  const table = make('table', { class: 'visura-table' });
  table.append(make('caption', {},
    `Foglio ${first.foglio || ''} \u00b7 particella ${first.numero || ''}`
    + (first.denominatore ? `/${first.denominatore}` : '')
    + ` \u00b7 ${result.detail.rows.length} porzione/i`));

  const headRow = make('tr');
  for (const [label, numeric] of [
    ['Porzione', false], ['Qualit\u00e0', false], ['Classe', false],
    ['Superficie', true], ['Reddito dominicale', true],
    ['Reddito agrario', true],
  ]) {
    headRow.append(make('th', {
      scope: 'col', class: numeric ? 'num' : null,
    }, label));
  }
  const thead = make('thead');
  thead.append(headRow);
  table.append(thead);

  const tbody = make('tbody');
  for (const row of result.detail.rows) {
    const tr = make('tr');
    tr.append(
      make('td', {}, row.porzione || '\u2013'),
      make('td', {}, row.qualita || '\u2013'),
      make('td', {}, row.classe || '\u2013'),
      make('td', { class: 'num' }, formatHa(row.superficieHa)),
      make('td', { class: 'num' }, formatEuro(row.redditoDominicale)),
      make('td', { class: 'num' }, formatEuro(row.redditoAgrario)),
    );
    tbody.append(tr);
  }
  table.append(tbody);

  const totalRow = make('tr');
  totalRow.append(
    make('th', { scope: 'row', colspan: '3' }, 'Totale'),
    make('td', { class: 'num' }, formatHa(result.detail.totals.superficieHa)),
    make('td', { class: 'num' }, formatEuro(result.detail.totals.redditoDominicale)),
    make('td', { class: 'num' }, formatEuro(result.detail.totals.redditoAgrario)),
  );
  const tfoot = make('tfoot');
  tfoot.append(totalRow);
  table.append(tfoot);
  wrap.append(table);
  out.append(wrap);

  const actions = make('div', { class: 'visura-actions' });
  actions.append(
    make('button', { type: 'button', 'data-visura-action': 'copy' }, 'Copia scheda'),
    make('button', { type: 'button', 'data-visura-action': 'print' }, 'Stampa'),
    make('button', { type: 'button', 'data-visura-action': 'refresh' }, 'Aggiorna'),
    make('a', {
      href: result.sourceUrl, target: '_blank', rel: 'noopener',
    }, 'Apri la pagina originale'),
  );
  out.append(actions);

  out.append(make('p', { class: 'visura-note' },
    `Consultato il ${formatDateTimeIt(result.fetchedAt)}. Dati pubblici `
    + 'dell\'Agenzia delle Entrate. Riepilogo informativo: non sostituisce '
    + 'la visura catastale ufficiale.'));

  out.hidden = false;
}

function renderVisuraNotFound(result) {
  const out = $('out-visura');
  out.replaceChildren();
  const parcel = parcelForVisura();
  const sez = parcel && parcel.sezione ? ` sezione ${parcel.sezione}` : '';
  const identificativo = parcel
    ? `foglio ${parcel.foglio} \u00b7 particella ${parcel.particella}${sez}`
    : 'selezionata';
  const message = result.reason === 'ambiguous'
    ? `La ricerca per la particella (${identificativo}) ha restituito più `
      + 'risultati. Apri la ricerca originale per scegliere quello giusto.'
    : `La particella (${identificativo}) non risulta nell'archivio `
      + 'Variazioni colturali. La copertura del servizio è parziale: molte '
      + 'particelle non sono presenti. Per i dati ufficiali usa la visura '
      + 'gratuita (SPID/CIE/CNS) o la consultazione rendite (con CAPTCHA).';

  out.append(make('p', { class: 'visura-empty' }, message));

  const actions = make('div', { class: 'visura-actions' });
  actions.append(
    make('a', {
      href: result.sourceUrl, target: '_blank', rel: 'noopener',
    }, 'Apri la ricerca originale'),
    make('button', {
      type: 'button', 'data-visura-action': 'refresh',
    }, 'Riprova'),
  );
  out.append(actions);
  out.hidden = false;
}

function renderVisuraError(message) {
  const out = $('out-visura');
  out.replaceChildren();
  out.append(make('p', { class: 'visura-empty' }, message));
  const actions = make('div', { class: 'visura-actions' });
  actions.append(make('button', {
    type: 'button', 'data-visura-action': 'refresh',
  }, 'Riprova'));
  out.append(actions);
  out.hidden = false;
}

// --------------------------------------------------------------------------
// Aggancio di diagnostica: consente di ispezionare lo stato dalla console del
// browser e di pilotare l'app da script (usato anche dai test automatici).
//     mappaApp.map.getZoom(), mappaApp.state.field, mappaApp.layers.view
// --------------------------------------------------------------------------
window.mappaApp = {
  get map() { return map; },
  get state() { return state; },
  get layers() { return { field: fieldLayer, view: viewLayer }; },
  get wfs() { return wfs; },
  get visura() { return visuraClient; },
  CONFIG,
};

document.addEventListener('DOMContentLoaded', init);
