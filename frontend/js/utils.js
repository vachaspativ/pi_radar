/**
 * utils.js — Geo-math and formatting utilities for Pi Radar.
 * No dependencies. Loaded first.
 */

"use strict";

const Utils = (() => {

  const R_NM = 3440.065; // Earth radius in nautical miles

  /**
   * Haversine distance in nautical miles between two lat/lon points.
   */
  function haversineNm(lat1, lon1, lat2, lon2) {
    const dlat = toRad(lat2 - lat1);
    const dlon = toRad(lon2 - lon1);
    const a =
      Math.sin(dlat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlon / 2) ** 2;
    return R_NM * 2 * Math.asin(Math.sqrt(a));
  }

  /**
   * Bearing in degrees (0=North, clockwise) from home to target.
   */
  function bearingTo(homeLat, homeLon, lat, lon) {
    const lat1 = toRad(homeLat);
    const lat2 = toRad(lat);
    const dlon = toRad(lon - homeLon);
    const x = Math.sin(dlon) * Math.cos(lat2);
    const y =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dlon);
    return (toDeg(Math.atan2(x, y)) + 360) % 360;
  }

  /**
   * Convert a lat/lon (and home position) to canvas pixel coordinates.
   * bearing: 0=N → top of canvas, 90=E → right, etc.
   *
   * @param {number} lat - Target latitude
   * @param {number} lon - Target longitude
   * @param {number} homeLat - Centre latitude
   * @param {number} homeLon - Centre longitude
   * @param {number} cx - Canvas centre X (pixels)
   * @param {number} cy - Canvas centre Y (pixels)
   * @param {number} radarRadius - Radius of radar circle (pixels)
   * @param {number} maxRangeNm - Current zoom range (nautical miles)
   * @returns {{ x: number, y: number, inRange: boolean }}
   */
  function latLonToCanvas(lat, lon, homeLat, homeLon, cx, cy, radarRadius, maxRangeNm) {
    const dist = haversineNm(homeLat, homeLon, lat, lon);
    const brng = bearingTo(homeLat, homeLon, lat, lon);
    const brngRad = toRad(brng);
    const scale = dist / maxRangeNm;
    const px = cx + radarRadius * scale * Math.sin(brngRad);
    const py = cy - radarRadius * scale * Math.cos(brngRad);
    return { x: px, y: py, inRange: dist <= maxRangeNm, dist, brng };
  }

  /** Format altitude in feet to a clean string, e.g. "35,000 ft" */
  function formatAlt(ft) {
    if (ft == null) return "—";
    if (ft < 100) return "GND";
    return Math.round(ft / 100) * 100 + " ft";
  }

  /** Format speed in knots */
  function formatSpeed(kts) {
    if (kts == null) return "—";
    return Math.round(kts) + " kts";
  }

  /** Format vertical rate: "▲ 1,200 fpm" or "▼ 640 fpm" */
  function formatVrate(fpm) {
    if (fpm == null) return "—";
    const abs = Math.abs(Math.round(fpm));
    if (abs < 64) return "━ level";
    return (fpm > 0 ? "▲ " : "▼ ") + abs.toLocaleString() + " fpm";
  }

  /** Format bearing: "042°" */
  function formatBearing(deg) {
    if (deg == null) return "—";
    return Math.round(deg).toString().padStart(3, "0") + "°";
  }

  /** Format distance: "67.3 nm" */
  function formatDist(nm) {
    if (nm == null) return "—";
    return nm.toFixed(1) + " nm";
  }

  /** Format a Unix timestamp to HH:MM:SS local time */
  function formatTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString();
  }

  /** Altitude band: returns 'low' / 'mid' / 'high' for colour coding */
  function altBand(ft) {
    if (ft == null) return "unknown";
    if (ft < 10000) return "low";
    if (ft < 25000) return "mid";
    return "high";
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  function toRad(deg) { return deg * (Math.PI / 180); }
  function toDeg(rad) { return rad * (180 / Math.PI); }

  // Public API
  return {
    haversineNm,
    bearingTo,
    latLonToCanvas,
    formatAlt,
    formatSpeed,
    formatVrate,
    formatBearing,
    formatDist,
    formatTime,
    altBand,
    toRad,
    toDeg,
  };
})();
