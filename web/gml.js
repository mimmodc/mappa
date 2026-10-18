// ==========================================================================
// Parsing degli identificativi catastali e delle risposte GML del WFS.
// Port fedele delle funzioni omonime dell'app desktop.
// ==========================================================================

const NS = {
  wfs: 'http://www.opengis.net/wfs/2.0',
  gml: 'http://www.opengis.net/gml/3.2',
  cp: 'http://mapserver.gis.umn.edu/mapserver',
  ows: 'http://www.opengis.net/ows/1.1',
};

/**
 * Scompone un INSPIREID catastale.
 *   IT.AGE.PLA.M011_000200.2   -> comune M011, foglio 0002, part. 2
 *   IT.AGE.PLA.G388E000100.1   -> comune G388, sezione E, foglio 0001, part. 1
 */
export function parseInspireId(localId) {
  const out = { comune: '', sezione: '', foglio: '', particella: '' };
  if (!localId) return out;
  const body = localId.includes('PLA.') ? localId.split('PLA.', 2)[1] : localId;
  const dot = body.indexOf('.');
  const head = dot >= 0 ? body.slice(0, dot) : body;
  out.particella = dot >= 0 ? body.slice(dot + 1) : '';
  let rest;
  if (head.includes('_')) {
    const idx = head.indexOf('_');
    out.comune = head.slice(0, idx);
    rest = head.slice(idx + 1);
  } else {
    out.comune = head.slice(0, 4);
    out.sezione = head.slice(4, 5);
    rest = head.slice(5);
  }
  out.foglio = rest.slice(0, 4);
  return out;
}

/** Converte il testo di un <gml:posList> (gradi, ordine lat lon) in [[lat, lon], ...]. */
export function parsePosList(text) {
  const values = String(text).trim().split(/\s+/);
  const coords = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const lat = parseFloat(values[i]);
    const lon = parseFloat(values[i + 1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) coords.push([lat, lon]);
  }
  return coords;
}

function posListOf(parent) {
  const nodes = parent.getElementsByTagNameNS(NS.gml, 'posList');
  return nodes.length ? nodes[0].textContent : null;
}

/** True se il documento XML contiene un errore di parsing. */
export function xmlError(doc) {
  const err = doc.getElementsByTagName('parsererror');
  if (err.length) return err[0].textContent || 'XML non valido';
  const exc = doc.getElementsByTagNameNS(NS.ows, 'ExceptionText');
  if (exc.length) return exc[0].textContent || 'Eccezione WFS';
  return null;
}

/**
 * Estrae le particelle da una risposta GML del WFS.
 * Restituisce [{ localId, comune, sezione, foglio, particella,
 *                exterior, interiors }].
 */
export function parseWfsResponse(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const error = xmlError(doc);
  if (error) throw new Error(`Risposta WFS non valida: ${error.trim()}`);

  const result = [];
  const members = doc.getElementsByTagNameNS(NS.wfs, 'member');
  for (const member of members) {
    const nodes = member.getElementsByTagNameNS(NS.cp, 'CadastralParcel');
    if (!nodes.length) continue;
    const node = nodes[0];

    const gmlId = (node.getAttributeNS(NS.gml, 'id') || '')
      .replace('CadastralParcel.', '');
    let localId = '';
    const localNodes = node.getElementsByTagNameNS(NS.cp, 'INSPIREID_LOCALID');
    if (localNodes.length) localId = (localNodes[0].textContent || '').trim();
    if (!localId) localId = gmlId;

    const rings = [];
    const holes = [];
    for (const polygon of node.getElementsByTagNameNS(NS.gml, 'Polygon')) {
      for (const [tag, target] of [['exterior', rings], ['interior', holes]]) {
        for (const ringNode of polygon.getElementsByTagNameNS(NS.gml, tag)) {
          const text = posListOf(ringNode);
          if (!text) continue;
          const parsed = parsePosList(text);
          if (parsed.length >= 3) target.push(parsed);
        }
      }
    }
    if (!rings.length) continue;

    const meta = parseInspireId(localId);
    result.push({
      localId,
      comune: meta.comune,
      sezione: meta.sezione,
      foglio: meta.foglio,
      particella: meta.particella,
      exterior: rings[0],
      interiors: holes,
    });
  }
  return result;
}
