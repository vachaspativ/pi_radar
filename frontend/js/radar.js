/**
 * radar.js — Static radar background renderer.
 *
 * Renders the fixed elements of the radar display:
 *   • Dark phosphor-green background with subtle vignette
 *   • Range rings with nautical mile labels
 *   • Compass rose (N/S/E/W + degree tick marks)
 *   • Centre home marker
 *   • Crosshair grid lines
 *
 * This layer is drawn to an offscreen canvas and composited,
 * so it only needs to be redrawn on resize (not every frame).
 */

"use strict";

const RadarRenderer = (() => {

  // ---------------------------------------------------------------------------
  // Colours (CSS custom props are available but we define JS consts here
  // to keep the canvas code self-contained)
  // ---------------------------------------------------------------------------
  const C = {
    bg:           "#000d00",
    bgEdge:       "#000500",
    ring:         "rgba(0, 150, 0, 0.12)",   // very light translucent green
    ringBright:   "rgba(0, 200, 0, 0.20)",   // light translucent green
    ringLabel:    "rgba(0, 200, 0, 0.35)",   // dim green label
    grid:         "rgba(0, 100, 0, 0.06)",   // extremely faint grid lines
    compass:      "rgba(0, 150, 0, 0.18)",   // light compass lines
    compassLabel: "rgba(0, 255, 100, 0.45)",  // cardinal labels
    homeMarker:   "#00ff65",
    centreDot:    "#00ff65",
  };

  const RANGE_RINGS = {
    5: [1, 2, 3, 4, 5],
    10: [2, 4, 6, 8, 10],
    25: [5, 10, 15, 20, 25],
    50: [10, 20, 30, 40, 50],
    100: [25, 50, 75, 100],
    150: [25, 50, 75, 100, 125, 150],
    200: [50, 100, 150, 200]
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let _canvas = null;
  let _ctx = null;
  let _cx = 0;
  let _cy = 0;
  let _radius = 0;
  let _rangeRingsNm = [25, 50, 100, 200];
  let _maxRangeNm = 100;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(canvas, rangeRingsNm, maxRangeNm) {
    _canvas = canvas;
    _ctx = canvas.getContext("2d");
    _recalc();
    setRange(maxRangeNm);
  }

  function resize() {
    _recalc();
    draw();
  }

  function setRange(rangeNm) {
    _maxRangeNm = rangeNm;
    _rangeRingsNm = RANGE_RINGS[rangeNm] || [rangeNm / 4, rangeNm / 2, rangeNm * 3 / 4, rangeNm];
    draw();
  }

  function draw() {
    if (!_canvas) return;
    const ctx = _ctx;
    const w = _canvas.width, h = _canvas.height;

    ctx.clearRect(0, 0, w, h);
    _drawBackground(ctx, w, h);
    _drawGridLines(ctx);
    _drawRangeRings(ctx);
    _drawCompassRose(ctx);
    _drawHomeMarker(ctx);
    _clipToCircle(ctx);
  }

  function getCentre() { return { cx: _cx, cy: _cy, radius: _radius }; }
  function getMaxRange() { return _maxRangeNm; }

  // ---------------------------------------------------------------------------
  // Private draw helpers
  // ---------------------------------------------------------------------------

  function _recalc() {
    const w = _canvas.width, h = _canvas.height;
    const MARGIN = 48;
    _cx = w / 2;
    _cy = h / 2;
    _radius = Math.min(w, h) / 2 - MARGIN;
  }

  function _drawBackground(ctx, w, h) {
    // No solid fill — the map canvas layer below shows through.
    // We only draw the vignette overlay and the outer border.

    // Circular vignette — darkens the edges over the map for readability
    const vignette = ctx.createRadialGradient(
      _cx, _cy, _radius * 0.45,
      _cx, _cy, _radius
    );
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(0.7, "rgba(0,0,0,0.12)");
    vignette.addColorStop(1, "rgba(0,0,0,0.52)");

    ctx.save();
    ctx.beginPath();
    ctx.arc(_cx, _cy, _radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Outer ring border
    ctx.beginPath();
    ctx.arc(_cx, _cy, _radius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 204, 85, 0.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function _drawGridLines(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(_cx, _cy, _radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 0.5;
    ctx.setLineDash([4, 8]);

    // N-S line
    ctx.beginPath();
    ctx.moveTo(_cx, _cy - _radius);
    ctx.lineTo(_cx, _cy + _radius);
    ctx.stroke();

    // E-W line
    ctx.beginPath();
    ctx.moveTo(_cx - _radius, _cy);
    ctx.lineTo(_cx + _radius, _cy);
    ctx.stroke();

    // 45-degree diagonals
    for (let angle of [45, 135]) {
      const rad = Utils.toRad(angle);
      ctx.beginPath();
      ctx.moveTo(_cx - _radius * Math.cos(rad), _cy - _radius * Math.sin(rad));
      ctx.lineTo(_cx + _radius * Math.cos(rad), _cy + _radius * Math.sin(rad));
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  function _drawRangeRings(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(_cx, _cy, _radius, 0, Math.PI * 2);
    ctx.clip();

    const fontSize = Math.max(10, _radius * 0.035);
    ctx.font = `${fontSize}px "Courier New", monospace`;
    ctx.textAlign = "left";

    for (const nm of _rangeRingsNm) {
      if (nm > _maxRangeNm) continue;
      const r = (_radius * nm) / _maxRangeNm;
      const isMajor = nm === _maxRangeNm || nm % 50 === 0;

      ctx.beginPath();
      ctx.arc(_cx, _cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = isMajor ? C.ringBright : C.ring;
      ctx.lineWidth = isMajor ? 1 : 0.75;
      ctx.setLineDash(isMajor ? [] : [3, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label at the East position (3 o'clock)
      const labelX = _cx + r + 4;
      const labelY = _cy - 4;
      ctx.fillStyle = C.ringLabel;
      ctx.fillText(`${nm}nm`, labelX, labelY);
    }

    ctx.restore();
  }

  function _drawCompassRose(ctx) {
    const r = _radius;
    const cx = _cx, cy = _cy;
    const tickOuter = r + 12;
    const tickInner = r + 4;
    const majorInner = r + 2;

    const cardinals = ["N", "E", "S", "W"];
    const cardAngles = [0, 90, 180, 270];

    ctx.font = `bold ${Math.max(12, r * 0.055)}px "Courier New", monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let deg = 0; deg < 360; deg += 10) {
      const rad = Utils.toRad(deg - 90); // -90 because 0° is top
      const isMajor = deg % 90 === 0;
      const isMed   = deg % 30 === 0 && !isMajor;

      const inner = isMajor ? majorInner - 4 : isMed ? tickInner : tickInner + 3;
      const outer = tickOuter;

      ctx.beginPath();
      ctx.moveTo(cx + inner * Math.cos(rad), cy + inner * Math.sin(rad));
      ctx.lineTo(cx + outer * Math.cos(rad), cy + outer * Math.sin(rad));
      ctx.strokeStyle = isMajor ? "#00cc55" : C.compass;
      ctx.lineWidth = isMajor ? 2 : 0.75;
      ctx.stroke();
    }

    // Cardinal labels
    for (let i = 0; i < 4; i++) {
      const deg = cardAngles[i];
      const rad = Utils.toRad(deg - 90);
      const labelR = tickOuter + Math.max(14, r * 0.045);
      const lx = cx + labelR * Math.cos(rad);
      const ly = cy + labelR * Math.sin(rad);
      ctx.fillStyle = "#00ff65";
      ctx.fillText(cardinals[i], lx, ly);
    }
  }

  function _drawHomeMarker(ctx) {
    const cx = _cx, cy = _cy;
    const size = Math.max(6, _radius * 0.025);

    // Pulsing cross / diamond
    ctx.save();
    ctx.strokeStyle = C.homeMarker;
    ctx.fillStyle = "rgba(0, 255, 100, 0.15)";
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#00ff65";

    // Diamond
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx + size * 0.6, cy);
    ctx.lineTo(cx, cy + size);
    ctx.lineTo(cx - size * 0.6, cy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fillStyle = C.homeMarker;
    ctx.fill();

    ctx.restore();
  }

  function _clipToCircle(ctx) {
    // Apply circular clip to ensure nothing bleeds outside the radar circle.
    // Called last — all subsequent draws on this canvas will be clipped.
    ctx.save();
    ctx.globalCompositeOperation = "destination-in";
    ctx.beginPath();
    ctx.arc(_cx, _cy, _radius, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  return { init, resize, draw, setRange, getCentre, getMaxRange };
})();
