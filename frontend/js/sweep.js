/**
 * sweep.js — Phosphor green radar sweep animation.
 *
 * Draws two canvas layers:
 *  1. A rotating sweep line (bright leading edge).
 *  2. A decaying phosphor trail behind the sweep line.
 *
 * Runs at requestAnimationFrame (60fps) independently of the 5-second
 * data refresh so the animation is always buttery smooth.
 */

"use strict";

const SweepRenderer = (() => {

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let _canvas = null;
  let _ctx = null;
  let _cx = 0;
  let _cy = 0;
  let _radius = 0;
  let _angle = 0;           // Current sweep angle in radians (0 = top/North)
  let _running = false;
  let _rafId = null;
  let _lastTime = null;

  // Sweep speed — full rotation in this many milliseconds
  const ROTATION_MS = 4000;   // 4-second sweep (classic radar feel)
  const TWO_PI = Math.PI * 2;

  // Phosphor trail — how many "frames" of gradient arc to paint
  // We paint a decaying arc spanning this many radians behind the sweep.
  const TRAIL_SPAN_RAD = (THREE_QUARTERS => THREE_QUARTERS)(TWO_PI * 0.75);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(canvas, cx, cy, radius) {
    _canvas = canvas;
    _ctx = canvas.getContext("2d");
    _cx = cx;
    _cy = cy;
    _radius = radius;
  }

  function resize(cx, cy, radius) {
    _cx = cx;
    _cy = cy;
    _radius = radius;
  }

  function start() {
    if (_running) return;
    _running = true;
    _lastTime = null;
    _rafId = requestAnimationFrame(_tick);
  }

  function stop() {
    _running = false;
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
  }

  function getAngle() {
    return _angle;
  }

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  function _tick(timestamp) {
    if (!_running) return;

    if (_lastTime === null) _lastTime = timestamp;
    const dt = timestamp - _lastTime;
    _lastTime = timestamp;

    // Advance sweep angle
    _angle = (_angle + (TWO_PI * dt) / ROTATION_MS) % TWO_PI;

    _draw();

    _rafId = requestAnimationFrame(_tick);
  }

  function _draw() {
    const ctx = _ctx;
    const cx = _cx, cy = _cy, r = _radius;

    // Clear only the sweep layer (caller handles background + static layers)
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    // --- Phosphor decay trail -------------------------------------------
    // We draw a series of arc-wedge sectors from (angle - TRAIL_SPAN) to angle,
    // each getting progressively less opaque the further from the sweep tip.

    const steps = 60;
    const stepAngle = TRAIL_SPAN_RAD / steps;

    for (let i = 0; i < steps; i++) {
      const alpha = (i / steps) * 0.18;  // fades toward 0 at the back
      const startAngle = _angle - TRAIL_SPAN_RAD + i * stepAngle - Math.PI / 2;
      const endAngle = startAngle + stepAngle;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = `rgba(0, 255, 65, ${alpha})`;
      ctx.fill();
    }

    // --- Sweep leading line ------------------------------------------------
    // Bright radial gradient from centre to edge, rotated to _angle.
    const tipX = cx + r * Math.sin(_angle);
    const tipY = cy - r * Math.cos(_angle);

    const lineGrad = ctx.createLinearGradient(cx, cy, tipX, tipY);
    lineGrad.addColorStop(0,    "rgba(0, 255, 65, 0.0)");
    lineGrad.addColorStop(0.3,  "rgba(0, 255, 65, 0.5)");
    lineGrad.addColorStop(1.0,  "rgba(0, 255, 65, 1.0)");

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.strokeStyle = lineGrad;
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 8;
    ctx.shadowColor = "rgba(0, 255, 100, 0.9)";
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // ---------------------------------------------------------------------------
  return { init, resize, start, stop, getAngle };
})();
