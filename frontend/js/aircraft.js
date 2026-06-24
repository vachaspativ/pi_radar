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

  const BLIP_RADIUS = 5;
  const SELECTED_RADIUS = 8;
  const LABEL_OFFSET = 12;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let _canvas = null;
  let _ctx = null;
  let _aircraft = [];        // Latest aircraft array from server
  let _selectedIcao = null;  // ICAO of clicked aircraft
  let _config = null;        // { cx, cy, radius, maxRangeNm, homeLat, homeLon }
  let _onSelect = null;      // Callback: function(aircraft | null)

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

  function draw() {
    if (!_canvas || !_config) return;
    const ctx = _ctx;
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    for (const ac of _aircraft) {
      const pos = _toCanvas(ac);
      if (!pos || !pos.inRange) continue;
      _drawTrail(ctx, ac, pos);
    }
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

  function _drawBlip(ctx, ac, pos) {
    const r = ac.icao === _selectedIcao ? SELECTED_RADIUS : BLIP_RADIUS;
    const colour = _blipColour(ac);

    ctx.save();
    ctx.shadowBlur = 12;
    ctx.shadowColor = colour;

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = colour.replace(")", ", 0.3)").replace("rgb", "rgba");
    ctx.lineWidth = 1;
    ctx.stroke();

    // Main blip
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();

    // Heading arrow
    if (ac.heading_deg != null && !ac.on_ground) {
      _drawHeadingArrow(ctx, pos.x, pos.y, ac.heading_deg, colour, r);
    }

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function _drawHeadingArrow(ctx, x, y, headingDeg, colour, blipR) {
    const arrowLen = blipR + 14;
    const rad = Utils.toRad(headingDeg);
    const tipX = x + arrowLen * Math.sin(rad);
    const tipY = y - arrowLen * Math.cos(rad);

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead
    const headLen = 5;
    const headAngle = 0.4;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - headLen * Math.sin(rad - headAngle),
      tipY + headLen * Math.cos(rad - headAngle)
    );
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - headLen * Math.sin(rad + headAngle),
      tipY + headLen * Math.cos(rad + headAngle)
    );
    ctx.stroke();
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
  return { init, resize, update, draw, getSelected, clearSelection };
})();
