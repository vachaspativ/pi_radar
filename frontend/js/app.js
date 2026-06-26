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
  let _rangeOptions = {};
  let _alertsCfg    = null;

  // Alert & Audio State
  let _audioCtx      = null;
  let _sirenOsc1     = null;
  let _sirenOsc2     = null;
  let _sirenGain     = null;
  let _sirenInterval = null;
  let _customAudio   = null;
  let _autoSelectedHexes = new Set(); // tracks ICAO hexes we already auto-focused


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
      _rangeOptions = cfg.radar.range_options || {};

      // Populate range dropdown from config
      const select = document.getElementById("range-select");
      if (select && cfg.radar.range_options) {
        select.innerHTML = "";
        const ranges = Object.keys(cfg.radar.range_options).map(Number).sort((a, b) => a - b);
        for (const nm of ranges) {
          const opt = document.createElement("option");
          opt.value = nm;
          opt.textContent = `${nm} nm`;
          if (nm === _rangeNm) {
            opt.selected = true;
          }
          select.appendChild(opt);
        }
      }

      UI.setHomeLabel(_homeLabel);
      if (cfg.display && cfg.display.photo_api_url) {
        UI.setPhotoApiUrl(cfg.display.photo_api_url);
      }

      _alertsCfg = cfg.alerts || {
        emergency: { enabled: true, squawks: ["7700", "7600", "7500"], siren_volume: 0.1, audio_file_url: "", glow_color: "rgba(255, 59, 48, 0.4)" },
        proximity: { enabled: true, min_distance_nm: 1.0, altitude_distance_nm: 2.0, altitude_threshold_ft: 2000, glow_color: "rgba(0, 191, 255, 0.6)" }
      };
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

      // Check alerts for the full set of incoming aircraft (including filtered)
      _checkAlerts(msg.aircraft || []);

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
  // Alerts & Warning Alarm Sounds
  // ---------------------------------------------------------------------------
  function _checkAlerts(aircraftList) {
    if (!_alertsCfg) return;

    let hasEmergency = false;
    let hasProximity = false;
    let emergencyAircraft = null;

    for (const ac of aircraftList) {
      // 1. Check emergency squawk codes
      if (_alertsCfg.emergency.enabled && ac.squawk) {
        if (_alertsCfg.emergency.squawks.includes(ac.squawk)) {
          hasEmergency = true;
          emergencyAircraft = ac;
        }
      }

      // 2. Check proximity conditions
      if (_alertsCfg.proximity.enabled && ac.distance_nm != null) {
        const dist = ac.distance_nm;
        const alt = ac.altitude_ft;

        // Condition A: distance < min_distance_nm
        if (dist < _alertsCfg.proximity.min_distance_nm) {
          hasProximity = true;
        }
        // Condition B: distance < altitude_distance_nm AND altitude < altitude_threshold_ft
        else if (dist < _alertsCfg.proximity.altitude_distance_nm && alt != null && alt < _alertsCfg.proximity.altitude_threshold_ft) {
          hasProximity = true;
        }
      }
    }

    // Process Proximity visual alerts
    if (hasProximity) {
      UI.setProximityAlert(true, _alertsCfg.proximity.glow_color);
    } else {
      UI.setProximityAlert(false);
    }

    // Process Emergency alerts
    if (hasEmergency) {
      UI.setEmergencyAlert(true, _alertsCfg.emergency.glow_color);
      UI.showMuteButton(true);

      // Auto-Select the emergency aircraft if it is a new occurrence
      if (emergencyAircraft && !_autoSelectedHexes.has(emergencyAircraft.icao)) {
        _autoSelectedHexes.add(emergencyAircraft.icao);
        AircraftRenderer.selectAircraft(emergencyAircraft.icao);
        console.log(`[Alert] Auto-selected emergency aircraft: ${emergencyAircraft.callsign || emergencyAircraft.icao} (Squawk ${emergencyAircraft.squawk})`);
      }

      // Play Siren (if not muted)
      if (!UI.isMuted()) {
        _startSiren();
      }
    } else {
      UI.setEmergencyAlert(false);
      UI.showMuteButton(false);
      UI.resetMute(); // reset mute state if all emergencies are resolved
      _autoSelectedHexes.clear(); // clear auto-selected list once safe
      _stopSiren();
    }
  }

  function _startSiren() {
    if (UI.isMuted()) return;
    if (!_alertsCfg || !_alertsCfg.emergency || !_alertsCfg.emergency.enabled) return;

    // Check if custom audio file URL is set
    const customUrl = _alertsCfg.emergency.audio_file_url;
    if (customUrl) {
      if (!_customAudio) {
        _customAudio = new Audio(customUrl);
        _customAudio.loop = true;
        _customAudio.volume = _alertsCfg.emergency.siren_volume || 0.1;
      }
      if (_customAudio.paused) {
        _customAudio.play().catch(e => console.warn("[Audio] Autoplay blocked:", e));
      }
      return;
    }

    // Otherwise, synthesize siren using Web Audio API
    if (_audioCtx) return;

    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      _sirenOsc1 = _audioCtx.createOscillator();
      _sirenOsc2 = _audioCtx.createOscillator();
      _sirenGain = _audioCtx.createGain();

      _sirenOsc1.type = "sine";
      _sirenOsc1.frequency.setValueAtTime(440, _audioCtx.currentTime);

      _sirenOsc2.type = "triangle";
      _sirenOsc2.frequency.setValueAtTime(554.37, _audioCtx.currentTime);

      _sirenGain.gain.setValueAtTime(_alertsCfg.emergency.siren_volume || 0.1, _audioCtx.currentTime);

      _sirenOsc1.connect(_sirenGain);
      _sirenOsc2.connect(_sirenGain);
      _sirenGain.connect(_audioCtx.destination);

      _sirenOsc1.start();
      _sirenOsc2.start();

      let high = true;
      _sirenInterval = setInterval(() => {
        if (!_audioCtx) return;
        const now = _audioCtx.currentTime;
        if (high) {
          _sirenOsc1.frequency.exponentialRampToValueAtTime(750, now + 0.45);
          _sirenOsc2.frequency.exponentialRampToValueAtTime(950, now + 0.45);
        } else {
          _sirenOsc1.frequency.exponentialRampToValueAtTime(440, now + 0.45);
          _sirenOsc2.frequency.exponentialRampToValueAtTime(554, now + 0.45);
        }
        high = !high;
      }, 500);
    } catch (err) {
      console.error("[Audio] Failed to initialize AudioContext:", err);
    }
  }

  function _stopSiren() {
    if (_customAudio) {
      _customAudio.pause();
    }
    if (_sirenInterval) {
      clearInterval(_sirenInterval);
      _sirenInterval = null;
    }
    if (_sirenOsc1) {
      try { _sirenOsc1.stop(); } catch (e) {}
      _sirenOsc1 = null;
    }
    if (_sirenOsc2) {
      try { _sirenOsc2.stop(); } catch (e) {}
      _sirenOsc2 = null;
    }
    if (_audioCtx) {
      try { _audioCtx.close(); } catch (e) {}
      _audioCtx = null;
    }
  }

  function _unlockAudio() {
    if (_audioCtx && _audioCtx.state === "suspended") {
      _audioCtx.resume();
    }
    document.removeEventListener("click", _unlockAudio);
    document.removeEventListener("touchstart", _unlockAudio);
  }
  document.addEventListener("click", _unlockAudio);
  document.addEventListener("touchstart", _unlockAudio);

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
    RadarRenderer.init(bgCanvas, _rangeOptions, _rangeNm);
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
      onMuteChange: (isMuted) => {
        if (isMuted) {
          _stopSiren();
        } else {
          _checkAlerts(_aircraft);
        }
      }
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
