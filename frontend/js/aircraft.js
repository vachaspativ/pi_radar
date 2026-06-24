/**
 * aircraft.js — Aircraft blips, trails, labels, and click detection.
 *
 * Maintains a local copy of aircraft state and renders onto the
 * main composite canvas each frame.
 */

"use strict";

const AircraftRenderer = (() => {

  // ---------------------------------------------------------------------------
  // Colour palette by altitude band
  // ---------------------------------------------------------------------------
  const COLOUR = {
    high:    "#00ff41",   // Cruise altitude  (>25,000 ft)  — bright green
    mid:     "#88ff44",   // Mid altitude     (10k–25k ft)  — yellow-green
    low:     "#ffff00",   // Low altitude     (<10,000 ft)  — yellow
    ground:  "#ff8800",   // On ground                      — amber
    unknown: "#00cc88",   // No altitude data               — teal
    trail:   "rgba(0, 255, 65, ",  // Trail colour base (alpha appended)
    label:   "#00ff41",
    labelDim: "#559955",
    selected: "#ffffff",
  };

  const BLIP_RADIUS     = 5;
  const SELECTED_RADIUS = 8;
  const LABEL_OFFSET    = 14;
  const AIRPORT_COLOUR  = "#ffaa00";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let _canvas      = null;
  let _ctx         = null;
  let _aircraft    = [];        // Latest aircraft array from server
  let _airports    = [];        // Airport data from /api/airports
  let _selectedIcao = null;     // ICAO of clicked aircraft
  let _config      = null;      // { cx, cy, radius, maxRangeNm, homeLat, homeLon }
  let _onSelect    = null;      // Callback: function(aircraft | null)

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(canvas, config, onSelectCallback) {
    _canvas = canvas;
    _ctx = canvas.getContext("2d");
    _config = config;
    _onSelect = onSelectCallback;

    canvas.addEventListener("click", _handleClick);
    canvas.addEventListener("touchend", _handleTouch, { passive: true });
  }

  function resize(config) {
    _config = config;
  }

  function update(aircraftArray) {
    _aircraft = aircraftArray || [];
  }

  function updateAirports(airportArray) {
    _airports = airportArray || [];
  }

  function draw() {
    if (!_canvas || !_config) return;
    const ctx = _ctx;
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    // Pass 1: Airports (drawn first so aircraft appear on top)
    _drawAirports(ctx);

    // Pass 2: Aircraft trails
    for (const ac of _aircraft) {
      const pos = _toCanvas(ac);
      if (!pos || !pos.inRange) continue;
      _drawTrail(ctx, ac, pos);
    }

    // Pass 3: Aircraft blips (plane icons) + labels
    for (const ac of _aircraft) {
      const pos = _toCanvas(ac);
      if (!pos || !pos.inRange) continue;
      _drawBlip(ctx, ac, pos);
      _drawLabel(ctx, ac, pos);
    }
  }

  function getSelected() {
    return _aircraft.find(a => a.icao === _selectedIcao) || null;
  }

  function clearSelection() {
    _selectedIcao = null;
    if (_onSelect) _onSelect(null);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function _toCanvas(ac) {
    if (ac.lat == null || ac.lon == null) return null;
    return Utils.latLonToCanvas(
      ac.lat, ac.lon,
      _config.homeLat, _config.homeLon,
      _config.cx, _config.cy,
      _config.radius, _config.maxRangeNm
    );
  }

  function _blipColour(ac) {
    if (ac.icao === _selectedIcao) return COLOUR.selected;
    if (ac.on_ground) return COLOUR.ground;
    const band = Utils.altBand(ac.altitude_ft);
    return COLOUR[band] || COLOUR.unknown;
  }

  // ---------------------------------------------------------------------------
  // Rendering — Airports
  // ---------------------------------------------------------------------------

  function _drawAirports(ctx) {
    if (!_airports.length) return;
    const size = Math.max(6, _config.radius * 0.018);

    for (const ap of _airports) {
      if (ap.lat == null || ap.lon == null) continue;
      const pos = Utils.latLonToCanvas(
        ap.lat, ap.lon,
        _config.homeLat, _config.homeLon,
        _config.cx, _config.cy,
        _config.radius, _config.maxRangeNm
      );
      if (!pos || !pos.inRange) continue;
      _drawAirportIcon(ctx, pos.x, pos.y, ap, size);
    }
  }

  function _drawAirportIcon(ctx, x, y, ap, size) {
    ctx.save();
    ctx.shadowBlur  = 6;
    ctx.shadowColor = AIRPORT_COLOUR;
    ctx.strokeStyle = AIRPORT_COLOUR;
    ctx.fillStyle   = AIRPORT_COLOUR;

    // Outer circle
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.stroke();

    // Runway cross — vertical bar (main runway)
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x, y + size);
    ctx.stroke();

    // Runway cross — horizontal bar (cross-wind)
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - size * 0.65, y);
    ctx.lineTo(x + size * 0.65, y);
    ctx.stroke();

    // Centre dot
    ctx.beginPath();
    ctx.arc(x, y, size * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.restore();

    // ICAO / IATA label
    const label = ap.icao || ap.iata || ap.name.slice(0, 4).toUpperCase();
    if (label) {
      const fontSize = Math.max(8, _config.radius * 0.026);
      ctx.save();
      ctx.font         = `bold ${fontSize}px "Courier New", monospace`;
      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";

      const lx = x + size + 4;
      const ly = y;
      const tw = ctx.measureText(label).width;

      // Background box
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(lx - 2, ly - fontSize * 0.6, tw + 4, fontSize * 1.2);

      ctx.fillStyle = AIRPORT_COLOUR;
      ctx.fillText(label, lx, ly);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering — Aircraft blips (plane icons)
  // ---------------------------------------------------------------------------

  function _drawBlip(ctx, ac, pos) {
    const isSelected = ac.icao === _selectedIcao;
    const colour     = _blipColour(ac);
    const size       = isSelected ? SELECTED_RADIUS : BLIP_RADIUS;

    ctx.save();
    ctx.shadowBlur  = isSelected ? 20 : 12;
    ctx.shadowColor = colour;

    if (ac.heading_deg != null && !ac.on_ground) {
      // Directional plane silhouette
      _drawPlaneIcon(ctx, pos.x, pos.y, ac.heading_deg, colour, size, isSelected);
    } else {
      // No heading data (e.g. on ground, transponder type S) — draw dot
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size + 3, 0, Math.PI * 2);
      ctx.strokeStyle = _toRgba(colour, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw a top-down aircraft silhouette centred on (x, y),
   * rotated so the nose points in the direction of headingDeg.
   *
   * Default orientation: nose at top (negative Y), heading 0° = North.
   */
  function _drawPlaneIcon(ctx, x, y, headingDeg, colour, size, selected) {
    const s   = size * 1.5;                 // scale factor
    const rad = Utils.toRad(headingDeg);    // rotation angle

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);

    // --- Fuselage + wings + tail outline ---
    ctx.beginPath();

    // Nose tip (north / up in local coords)
    ctx.moveTo(0, -s * 2.1);

    // Right wing leading edge
    ctx.lineTo(s * 2.3,  s * 0.3);
    // Right wing trailing edge
    ctx.lineTo(s * 0.9,  s * 0.55);

    // Right tail fin
    ctx.lineTo(s * 0.85, s * 1.75);
    // Tail centreline
    ctx.lineTo(0,        s * 1.25);
    // Left tail fin
    ctx.lineTo(-s * 0.85, s * 1.75);

    // Left wing trailing edge
    ctx.lineTo(-s * 0.9,  s * 0.55);
    // Left wing leading edge
    ctx.lineTo(-s * 2.3,  s * 0.3);

    ctx.closePath();

    ctx.fillStyle = colour;
    ctx.fill();

    if (selected) {
      // Bright outline + glow halo for selected aircraft
      ctx.strokeStyle = colour;
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      ctx.restore();
      ctx.save();
      ctx.shadowBlur  = 20;
      ctx.shadowColor = colour;
      ctx.beginPath();
      ctx.arc(x, y, s * 3, 0, Math.PI * 2);
      ctx.strokeStyle = _toRgba(colour, 0.25);
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Convert '#rrggbb' hex colour to rgba string with given alpha. */
  function _toRgba(colour, alpha) {
    if (colour.startsWith("#") && colour.length === 7) {
      const r = parseInt(colour.slice(1, 3), 16);
      const g = parseInt(colour.slice(3, 5), 16);
      const b = parseInt(colour.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return colour;
  }


  function _drawTrail(ctx, ac, pos) {
    if (!ac.track || ac.track.length < 2) return;

    // Only draw track points that are in range
    const points = ac.track
      .map(p => Utils.latLonToCanvas(
        p.lat, p.lon,
        _config.homeLat, _config.homeLon,
        _config.cx, _config.cy,
        _config.radius, _config.maxRangeNm
      ))
      .filter(p => p && p.inRange);

    if (points.length < 2) return;

    const n = points.length;
    for (let i = 0; i < n - 1; i++) {
      const alpha = 0.05 + 0.25 * (i / n);
      ctx.beginPath();
      ctx.moveTo(points[i].x, points[i].y);
      ctx.lineTo(points[i + 1].x, points[i + 1].y);
      ctx.strokeStyle = COLOUR.trail + alpha + ")";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Dots at each trail point
    for (let i = 0; i < n - 1; i++) {
      const alpha = 0.08 + 0.3 * (i / n);
      ctx.beginPath();
      ctx.arc(points[i].x, points[i].y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = COLOUR.trail + alpha + ")";
      ctx.fill();
    }
  }

  function _drawLabel(ctx, ac, pos) {
    const isSelected = ac.icao === _selectedIcao;
    const callsign = ac.callsign || ac.icao.toUpperCase();
    const alt = Utils.formatAlt(ac.altitude_ft);

    const fontSize = Math.max(9, _config.radius * 0.03);
    ctx.font = `${isSelected ? "bold " : ""}${fontSize}px "Courier New", monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    const lx = pos.x + LABEL_OFFSET;
    const ly = pos.y - fontSize;

    // Semi-transparent background for readability
    const w = ctx.measureText(callsign).width;
    ctx.fillStyle = "rgba(0,8,0,0.6)";
    ctx.fillRect(lx - 2, ly - 1, w + 4, fontSize * 2.2 + 2);

    // Callsign
    ctx.fillStyle = isSelected ? COLOUR.selected : COLOUR.label;
    ctx.fillText(callsign, lx, ly);

    // Altitude on next line
    ctx.font = `${fontSize * 0.85}px "Courier New", monospace`;
    ctx.fillStyle = COLOUR.labelDim;
    ctx.fillText(alt, lx, ly + fontSize * 1.1);
  }

  // ---------------------------------------------------------------------------
  // Click / Touch handling
  // ---------------------------------------------------------------------------

  function _handleClick(evt) {
    const rect = _canvas.getBoundingClientRect();
    const scaleX = _canvas.width / rect.width;
    const scaleY = _canvas.height / rect.height;
    const mx = (evt.clientX - rect.left) * scaleX;
    const my = (evt.clientY - rect.top) * scaleY;
    _selectAt(mx, my);
  }

  function _handleTouch(evt) {
    if (!evt.changedTouches.length) return;
    const touch = evt.changedTouches[0];
    const rect = _canvas.getBoundingClientRect();
    const scaleX = _canvas.width / rect.width;
    const scaleY = _canvas.height / rect.height;
    const mx = (touch.clientX - rect.left) * scaleX;
    const my = (touch.clientY - rect.top) * scaleY;
    _selectAt(mx, my);
  }

  function _selectAt(mx, my) {
    const HIT_RADIUS = 20;  // Generous touch target
    let nearest = null;
    let nearestDist = HIT_RADIUS;

    for (const ac of _aircraft) {
      const pos = _toCanvas(ac);
      if (!pos || !pos.inRange) continue;
      const d = Math.hypot(pos.x - mx, pos.y - my);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = ac;
      }
    }

    _selectedIcao = nearest ? nearest.icao : null;
    if (_onSelect) _onSelect(nearest);
  }

  // ---------------------------------------------------------------------------
  return { init, resize, update, updateAirports, draw, getSelected, clearSelection };
})();
