/**
 * map.js — OSM tile map background renderer (CartoDB Dark Matter).
 *
 * Renders map tiles onto a dedicated canvas layer that sits beneath all
 * radar overlays.  Tiles are fetched from CartoDB's free Dark Matter endpoint
 * (no API key required) and centered on the configured home lat/lon.
 *
 * Projection note
 * ---------------
 * Map tiles use Web Mercator (EPSG:3857).
 * Aircraft blips use a polar (bearing + haversine) projection centered on home.
 * At 25–200 nm these projections diverge by only 3–5 % at the edges —
 * acceptable for radar situational-awareness display (not navigation).
 *
 * Tile URL:    https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png
 * Attribution: © OpenStreetMap contributors © CARTO
 */

"use strict";

const MapRenderer = (() => {

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const TILE_SIZE     = 256;          // OSM standard tile size in px
  const TILE_URL      = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png";
  const MIN_ZOOM      = 4;
  const MAX_ZOOM      = 14;
  const TILE_OPACITY  = 0.85;         // Map is on focus (clearer background)
  const EARTH_CIRC_NM = 21639;        // Earth circumference in nautical miles

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let _canvas       = null;
  let _ctx          = null;
  let _cx           = 0;
  let _cy           = 0;
  let _radius       = 0;
  let _homeLat      = 0;
  let _homeLon      = 0;
  let _rangeNm      = 100;
  let _zoom         = 8;

  // Tile cache: key "z/x/y" → HTMLImageElement (may still be loading)
  const _tileCache    = new Map();
  // Keys currently being fetched (prevents duplicate requests)
  const _pending      = new Set();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} cx       - Radar centre X in pixels
   * @param {number} cy       - Radar centre Y in pixels
   * @param {number} radius   - Radar circle radius in pixels
   * @param {number} homeLat  - Home latitude
   * @param {number} homeLon  - Home longitude
   */
  function init(canvas, cx, cy, radius, homeLat, homeLon) {
    _canvas  = canvas;
    _ctx     = canvas.getContext("2d");
    _cx      = cx;
    _cy      = cy;
    _radius  = radius;
    _homeLat = homeLat;
    _homeLon = homeLon;
    _zoom    = _calcZoom(_rangeNm, _radius, _homeLat);
    draw();
  }

  /**
   * Call after the canvas has been resized.
   */
  function resize(cx, cy, radius) {
    _cx     = cx;
    _cy     = cy;
    _radius = radius;
    _zoom   = _calcZoom(_rangeNm, _radius, _homeLat);
    draw();
  }

  /**
   * Call when the user changes the NM range selector.
   * @param {number} rangeNm
   */
  function setRange(rangeNm) {
    _rangeNm = rangeNm;
    _zoom    = _calcZoom(rangeNm, _radius, _homeLat);
    draw();
  }

  /**
   * Re-render all tiles currently in cache onto the canvas.
   * Missing tiles trigger async fetches that call draw() again when loaded.
   */
  function draw() {
    if (!_canvas || _radius <= 0) return;

    const ctx = _ctx;
    const w   = _canvas.width;
    const h   = _canvas.height;

    ctx.clearRect(0, 0, w, h);

    // Clip everything to the radar circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(_cx, _cy, _radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.globalAlpha = TILE_OPACITY;

    // Fractional tile coordinate of home position at current zoom
    const { x: homeTileX, y: homeTileY } = _latLonToTile(_homeLat, _homeLon, _zoom);

    // How many tiles in each direction are needed to cover the radar circle
    const tilesNeeded = Math.ceil(_radius / TILE_SIZE) + 2;
    const startTX = Math.floor(homeTileX) - tilesNeeded;
    const endTX   = Math.floor(homeTileX) + tilesNeeded;
    const startTY = Math.floor(homeTileY) - tilesNeeded;
    const endTY   = Math.floor(homeTileY) + tilesNeeded;
    const maxTile = Math.pow(2, _zoom);

    for (let tx = startTX; tx <= endTX; tx++) {
      for (let ty = startTY; ty <= endTY; ty++) {
        // Skip tiles outside the valid Y range
        if (ty < 0 || ty >= maxTile) continue;

        // Wrap X coordinate for map continuity (antimeridian etc.)
        const wrappedTX = ((tx % maxTile) + maxTile) % maxTile;
        const key = `${_zoom}/${wrappedTX}/${ty}`;

        // Canvas pixel position: home is pinned to (cx, cy)
        const canvasX = Math.round(_cx + (tx - homeTileX) * TILE_SIZE);
        const canvasY = Math.round(_cy + (ty - homeTileY) * TILE_SIZE);

        // Skip tiles entirely outside the canvas bounds
        if (canvasX + TILE_SIZE < 0 || canvasX > w ||
            canvasY + TILE_SIZE < 0 || canvasY > h) continue;

        const img = _tileCache.get(key);
        if (img && img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, canvasX, canvasY, TILE_SIZE, TILE_SIZE);
        } else if (!img) {
          // Not yet requested — fetch it (the onload callback redraws)
          _fetchTile(key, wrappedTX, ty, _zoom);
        }
        // If img exists but not yet complete, onload will redraw
      }
    }

    // Attribution text (required by CartoDB & OSM tile policy)
    ctx.globalAlpha = 0.65;
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#cccccc";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(
      "© OpenStreetMap contributors © CARTO",
      _cx - _radius + 8,
      _cy + _radius - 6
    );

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert lat/lon to fractional tile X/Y at a given OSM zoom level.
   * Uses the standard Web Mercator (Slippy Map) formula.
   */
  function _latLonToTile(lat, lon, zoom) {
    const n      = Math.pow(2, zoom);
    const latRad = lat * Math.PI / 180;
    const x = (lon + 180) / 360 * n;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    return { x, y };
  }

  /**
   * Calculate the OSM zoom level so that rangeNm fits within the radar radius.
   *
   * Derivation:
   *   nmPerTile = EARTH_CIRC_NM * cos(lat) / 2^zoom
   *   tiles to fill radius = radius / TILE_SIZE
   *   rangeNm = nmPerTile * (radius / TILE_SIZE)
   *   → 2^zoom = EARTH_CIRC_NM * cos(lat) * radius / (rangeNm * TILE_SIZE)
   */
  function _calcZoom(rangeNm, radius, lat) {
    if (radius <= 0 || rangeNm <= 0) return 8;
    const cosLat  = Math.cos(lat * Math.PI / 180);
    const rawZoom = Math.log2(cosLat * EARTH_CIRC_NM * radius / (rangeNm * TILE_SIZE));
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(rawZoom)));
  }

  /**
   * Fetch a single tile and add it to the cache.
   * Calls draw() when loaded so the tile appears without waiting for a data update.
   */
  function _fetchTile(key, x, y, zoom) {
    if (_pending.has(key)) return;
    _pending.add(key);

    const url = TILE_URL
      .replace("{z}", zoom)
      .replace("{x}", x)
      .replace("{y}", y);

    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      _pending.delete(key);
      _tileCache.set(key, img);
      draw();   // Repaint now that this tile is ready
    };

    img.onerror = () => {
      _pending.delete(key);
      // Store a failed sentinel object so we don't retry endlessly in the same session
      _tileCache.set(key, { complete: true, naturalWidth: 0 });
    };

    // Put the (incomplete) img in cache immediately so draw() doesn't re-request it
    _tileCache.set(key, img);
    img.src = url;
  }

  // ---------------------------------------------------------------------------
  return { init, resize, setRange, draw };
})();
