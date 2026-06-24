/**
 * app.js — Pi Radar main application.
 *
 * Orchestrates all modules:
 *   • WebSocket connection + reconnection
 *   • Canvas layout + resize handling
 *   • Combining radar/sweep/aircraft renders
 *   • UI event routing
 */

"use strict";

(function PiRadarApp() {

  // ---------------------------------------------------------------------------
  // Canvas setup — FOUR stacked canvases for performance:
  //   0. map-canvas  — OSM tile map background (redrawn on range/resize)
  //   1. bg-canvas   — static radar background (rings, compass) — rarely redrawn
  //   2. sweep-canvas — rotating sweep animation (60fps)
  //   3. blip-canvas  — aircraft icons + airport markers (redrawn on data update)
  // ---------------------------------------------------------------------------
  const mapCanvas   = document.getElementById("map-canvas");
  const bgCanvas    = document.getElementById("bg-canvas");
  const sweepCanvas = document.getElementById("sweep-canvas");
  const blipCanvas  = document.getElementById("blip-canvas");

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------
  let _aircraft    = [];
  let _rangeNm     = 100;
  let _homeLat     = 32.7767;
  let _homeLon     = -96.7970;
  let _homeLabel   = "Home";
  let _ws          = null;
  let _wsReconnectDelay = 1000;
  const WS_MAX_DELAY = 30000;


  // ---------------------------------------------------------------------------
  // Sizing helpers
  // ---------------------------------------------------------------------------
  function _getSize() {
    const container = document.getElementById("radar-container");
    const side = Math.min(container.clientWidth, container.clientHeight) - 4;
    return Math.max(200, side);
  }

  function _resize() {
    const size = _getSize();
    const { cx, cy, radius } = _calcCentre(size);

    for (const canvas of [mapCanvas, bgCanvas, sweepCanvas, blipCanvas]) {
      canvas.width  = size;
      canvas.height = size;
    }

    // Map tiles layer
    MapRenderer.resize(cx, cy, radius);

    // Update sub-renderers
    RadarRenderer.resize();
    RadarRenderer.setRange(_rangeNm);
    RadarRenderer.draw();

    SweepRenderer.resize(cx, cy, radius);

    AircraftRenderer.resize({
      cx, cy, radius,
      maxRangeNm: _rangeNm,
      homeLat: _homeLat,
      homeLon: _homeLon,
    });
    AircraftRenderer.draw();
  }

  function _calcCentre(size) {
    const MARGIN = 48;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - MARGIN;
    return { cx, cy, radius };
  }

  // ---------------------------------------------------------------------------
  // Airport data
  // ---------------------------------------------------------------------------
  async function _fetchAirports(rangeNm) {
    try {
      const resp = await fetch(`/api/airports?range_nm=${rangeNm}`);
      if (!resp.ok) return;
      const airports = await resp.json();
      AircraftRenderer.updateAirports(airports);
      AircraftRenderer.draw();
      console.log(`[App] Loaded ${airports.length} airports for range=${rangeNm}nm`);
    } catch (e) {
      console.warn("[App] Airport fetch failed:", e);
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch initial config from backend
  // ---------------------------------------------------------------------------
  async function _loadConfig() {
    try {
      const resp = await fetch("/api/config");
      const cfg = await resp.json();
      _homeLat   = cfg.radar.home_lat;
      _homeLon   = cfg.radar.home_lon;
      _homeLabel = cfg.radar.home_label;
      _rangeNm   = cfg.radar.default_range_nm;

      // Populate range dropdown from config
      const select = document.getElementById("range-select");
      if (select) {
        select.value = _rangeNm;
      }

      UI.setHomeLabel(_homeLabel);
    } catch (e) {
      console.warn("[App] Could not load config from API — using defaults", e);
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------
  function _connectWS() {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${location.host}/ws`;
    console.log("[WS] Connecting to", url);

    _ws = new WebSocket(url);

    _ws.onopen = () => {
      console.log("[WS] Connected");
      _wsReconnectDelay = 1000;  // reset backoff
    };

    _ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        _handleMessage(msg);
      } catch (e) {
        console.error("[WS] Parse error:", e);
      }
    };

    _ws.onerror = (err) => {
      console.error("[WS] Error:", err);
    };

    _ws.onclose = () => {
      console.log(`[WS] Disconnected — reconnecting in ${_wsReconnectDelay}ms`);
      UI.updateStatus({ source: "DISCONNECTED", source_label: "Reconnecting...", aircraft_count: 0 });
      setTimeout(_connectWS, _wsReconnectDelay);
      _wsReconnectDelay = Math.min(_wsReconnectDelay * 2, WS_MAX_DELAY);
    };
  }

  function _handleMessage(msg) {
    if (msg.type === "aircraft_update") {
      _aircraft = UI.filterAircraft(msg.aircraft || []);
      AircraftRenderer.update(_aircraft);
      AircraftRenderer.draw();
      UI.updateStatus(msg);

      // Refresh selected aircraft info panel if open
      const sel = AircraftRenderer.getSelected();
      if (sel) {
        const updated = _aircraft.find(a => a.icao === sel.icao);
        if (updated) UI.showAircraftInfo(updated);
      }
    } else if (msg.type === "pong") {
      // Heartbeat ack
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat — send ping every 30s to keep WS alive through proxies
  // ---------------------------------------------------------------------------
  function _startHeartbeat() {
    setInterval(() => {
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 30000);
  }

  // ---------------------------------------------------------------------------
  // Range change
  // ---------------------------------------------------------------------------
  function _onRangeChange(nm) {
    _rangeNm = nm;
    MapRenderer.setRange(nm);
    RadarRenderer.setRange(nm);
    RadarRenderer.draw();

    const { cx, cy, radius } = _calcCentre(_getSize());
    AircraftRenderer.resize({
      cx, cy, radius,
      maxRangeNm: _rangeNm,
      homeLat: _homeLat,
      homeLon: _homeLon,
    });
    AircraftRenderer.draw();

    // Re-fetch airports for the new range (bounding box changed)
    _fetchAirports(nm);

    // Notify backend (optional)
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ type: "set_range", range_nm: nm }));
    }
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------
  async function init() {
    // Load config from backend first
    await _loadConfig();

    // Size all canvases
    const size = _getSize();
    const { cx, cy, radius } = _calcCentre(size);
    for (const canvas of [mapCanvas, bgCanvas, sweepCanvas, blipCanvas]) {
      canvas.width  = size;
      canvas.height = size;
    }

    // Init map tile layer (bottom canvas)
    MapRenderer.init(mapCanvas, cx, cy, radius, _homeLat, _homeLon);

    // Init sub-renderers
    RadarRenderer.init(bgCanvas, [25, 50, 100, 200], _rangeNm);
    RadarRenderer.draw();

    SweepRenderer.init(sweepCanvas, cx, cy, radius);
    SweepRenderer.start();

    AircraftRenderer.init(blipCanvas, {
      cx, cy, radius,
      maxRangeNm: _rangeNm,
      homeLat: _homeLat,
      homeLon: _homeLon,
    }, (ac) => {
      if (ac) UI.showAircraftInfo(ac);
      else     UI.hideAircraftInfo();
    });

    // Fetch initial airport data
    _fetchAirports(_rangeNm);

    // Init UI
    UI.init({
      onRangeChange:  _onRangeChange,
      onFilterChange: (filters) => {
        // Re-filter current aircraft and redraw
        const lastMsg = { aircraft: _aircraft };
        // We store the full set — re-filter on next WS message
      },
      onReplayStart: async () => {
        const nowTs  = Math.floor(Date.now() / 1000);
        const fromTs = nowTs - 3600;
        UI.setReplayStatus("Loading history...");
        try {
          const resp = await fetch(`/api/replay?from_ts=${fromTs}&to_ts=${nowTs}`);
          const data = await resp.json();
          _runReplay(data.buckets || []);
        } catch (e) {
          UI.setReplayStatus("Error loading history");
        }
      },
      onReplayStop: () => {
        UI.setReplayStatus("Stopped");
      },
    });

    UI.setHomeLabel(_homeLabel);

    // Connect WebSocket
    _connectWS();
    _startHeartbeat();

    // Handle window resize
    window.addEventListener("resize", _resize);
    // Handle device orientation change on Pi touchscreen
    window.addEventListener("orientationchange", () => setTimeout(_resize, 200));
  }

  // ---------------------------------------------------------------------------
  // Replay playback
  // ---------------------------------------------------------------------------
  async function _runReplay(buckets) {
    if (!buckets.length) {
      UI.setReplayStatus("No history data");
      return;
    }
    UI.setReplayStatus(`Replaying ${buckets.length} snapshots...`);

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      AircraftRenderer.update(bucket.aircraft || []);
      AircraftRenderer.draw();

      const timeStr = Utils.formatTime(bucket.ts);
      UI.setReplayStatus(`${i + 1}/${buckets.length} — ${timeStr}`);

      await new Promise(r => setTimeout(r, 200));  // 200ms between frames = ~5x speed
    }

    UI.setReplayStatus("Replay complete");
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

})();
