// ==========================================================================
// Geometria: area, perimetro, centroide, punto interno, bounding box.
// --------------------------------------------------------------------------
// Area e perimetro usano la libreria GeographicLib (algoritmo geodetico di
// Karney, WGS84) come l'app desktop, quindi i valori coincidono.
// La libreria arriva dal tag <script> e si presenta come window.geodesic con
// la struttura: geodesic.Geodesic.Geodesic (classe) e
// geodesic.PolygonArea.PolygonArea (classe).
// ==========================================================================

function lib() {
  const g = globalThis.geodesic;
  if (!g) throw new Error('Libreria GeographicLib non caricata.');
  return g;
}

/** Ring [(lat, lon), ...] -> { area (m2, sempre positivo), perimeter (m) }. */
export function ringAreaPerimeter(ring) {
  if (!ring || ring.length < 3) return { area: 0, perimeter: 0 };
  const g = lib();
  // La libreria espone un namespace per classe: geodesic.Geodesic.Geodesic
  const GeodesicClass = g.Geodesic.Geodesic || g.Geodesic;
  const PolygonAreaClass = g.PolygonArea.PolygonArea || g.PolygonArea;
  const wgs84 = g.Geodesic.WGS84 || GeodesicClass.WGS84;
  const poly = new PolygonAreaClass(wgs84, false);
  for (const [lat, lon] of ring) poly.AddPoint(lat, lon);
  const r = poly.Compute(false, true);
  const area = Number.isFinite(r.area) ? Math.abs(r.area) : 0;
  return { area, perimeter: Number.isFinite(r.perimeter) ? r.perimeter : 0 };
}

/** Centroide planare (lat, lon) di un anello. Port fedele di ring_centroid(). */
export function ringCentroid(ring) {
  if (!ring || !ring.length) return [0, 0];
  const n = ring.length;
  if (n < 3) {
    return [ring.reduce((s, p) => s + p[0], 0) / n,
            ring.reduce((s, p) => s + p[1], 0) / n];
  }

  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const [lat0, lon0] = ring[i];
    const [lat1, lon1] = ring[(i + 1) % n];
    const x0 = lon0, y0 = lat0, x1 = lon1, y1 = lat1;
    const cross = x0 * y1 - x1 * y0;
    twiceArea += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(twiceArea) < 1e-15) {  // anello degenere: media dei vertici
    return [ring.reduce((s, p) => s + p[0], 0) / n,
            ring.reduce((s, p) => s + p[1], 0) / n];
  }
  const area = twiceArea * 0.5;
  return [cy / (6 * area), cx / (6 * area)];
}

/** Ray casting: true se (lat, lon) e' interno all'anello. */
export function pointInRing(lat, lon, ring) {
  let inside = false;
  const n = ring.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [latI, lonI] = ring[i];
    const [latJ, lonJ] = ring[j];
    if (((lonI > lon) !== (lonJ > lon))
        && (lat < (latJ - latI) * (lon - lonI) / (lonJ - lonI) + latI)) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

/** Bounding box [latMin, lonMin, latMax, lonMax] di un anello. */
export function bboxOf(ring) {
  const lats = ring.map((p) => p[0]);
  const lons = ring.map((p) => p[1]);
  return [Math.min(...lats), Math.min(...lons),
          Math.max(...lats), Math.max(...lons)];
}

/** Area e perimetro tenendo conto degli eventuali "buchi" (interiors). */
export function geometryMeasure(ring, interiors = []) {
  let { area, perimeter } = ringAreaPerimeter(ring);
  for (const hole of interiors) {
    area -= ringAreaPerimeter(hole).area;
  }
  return { area: Math.max(area, 0), perimeter };
}

/** Formatta un numero con la virgola decimale italiana. */
export function fmtNum(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n.d.';
  return value.toLocaleString('it-IT', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
