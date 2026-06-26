/**
 * ui.js — All UI panels, controls, and status indicators.
 *
 * Manages:
 *  • Aircraft info panel (right sidebar, shown on blip click)
 *  • Status badge (LIVE / FALLBACK / MOCK indicator)
 *  • Range selector (zoom dropdown)
 *  • Filter panel (altitude filter)
 *  • Replay controls
 *  • Aircraft count overlay
 */

"use strict";

const UI = (() => {

  // ---------------------------------------------------------------------------
  // DOM references (set in init)
  // ---------------------------------------------------------------------------
  let _els = {};
  let _onRangeChange = null;
  let _onFilterChange = null;
  let _onReplayStart = null;
  let _onReplayPause = null;
  let _onReplayResume = null;
  let _onReplayStop = null;
  let _onMuteChange = null;
  let _isMuted = false;
  let _replayActive = false;
  let _replayLoaded = false;
  const _metaCache  = new Map();
  const _photoCache = new Map();
  let _photoApiUrl = "";

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(callbacks = {}) {
    _onRangeChange  = callbacks.onRangeChange  || (() => {});
    _onFilterChange = callbacks.onFilterChange || (() => {});
    _onReplayStart  = callbacks.onReplayStart  || (() => {});
    _onReplayPause  = callbacks.onReplayPause  || (() => {});
    _onReplayResume = callbacks.onReplayResume || (() => {});
    _onReplayStop   = callbacks.onReplayStop   || (() => {});

    // Cache DOM elements
    _els = {
      statusBadge:      document.getElementById("status-badge"),
      statusSource:     document.getElementById("status-source"),
      aircraftCount:    document.getElementById("aircraft-count"),
      rangeSelect:      document.getElementById("range-select"),
      infoPanel:        document.getElementById("info-panel"),
      infoPanelContent: document.getElementById("info-content"),
      closePanelBtn:    document.getElementById("close-panel"),
      filterToggle:     document.getElementById("filter-toggle"),
      filterPanel:      document.getElementById("filter-panel"),
      altMinSlider:     document.getElementById("alt-min"),
      altMaxSlider:     document.getElementById("alt-max"),
      altMinVal:        document.getElementById("alt-min-val"),
      altMaxVal:        document.getElementById("alt-max-val"),
      replayToggle:     document.getElementById("replay-toggle"),
      replayPanel:      document.getElementById("replay-panel"),
      replayPlayBtn:    document.getElementById("replay-play"),
      replayStopBtn:    document.getElementById("replay-stop"),
      goLiveBtn:        document.getElementById("go-live-btn"),
      replayStatus:     document.getElementById("replay-status"),
      homeLabel:        document.getElementById("home-label"),
      clockEl:          document.getElementById("clock"),
      muteBtn:          document.getElementById("mute-btn"),
      emergencyBanner:  document.getElementById("emergency-banner"),
      radarContainer:   document.getElementById("radar-container"),
      app:              document.getElementById("app"),
    };

    _onMuteChange = callbacks.onMuteChange || (() => {});

    _bindEvents();
    _startClock();
  }

  // ------------------------------------------------------------------
  // Status badge
  // ------------------------------------------------------------------

  function updateStatus(msg) {
    if (!_els.statusBadge) return;

    const source = msg.source || "UNKNOWN";
    const label  = msg.source_label || source;
    const count  = msg.aircraft_count || 0;

    // Badge class
    _els.statusBadge.className = "status-badge " + (
      source === "LIVE"     ? "live"     :
      source === "FALLBACK" ? "fallback" : "mock"
    );
    _els.statusBadge.textContent =
      source === "LIVE"     ? "● LIVE"     :
      source === "FALLBACK" ? "◉ FALLBACK" : "◎ MOCK";

    if (_els.statusSource) _els.statusSource.textContent = label;
    if (_els.aircraftCount) _els.aircraftCount.textContent = count + " aircraft";
  }

  // ------------------------------------------------------------------
  // Info panel
  // ------------------------------------------------------------------

  function showAircraftInfo(ac) {
    if (!ac || !_els.infoPanel) return;
    _els.infoPanel.classList.add("visible");
    console.log("[UI] showAircraftInfo for:", ac.icao);

    const callsign = ac.callsign || ac.icao.toUpperCase();
    const vrate = Utils.formatVrate(ac.vertical_rate_fpm);
    const vrateClass = ac.vertical_rate_fpm > 64  ? "climb"  :
                       ac.vertical_rate_fpm < -64 ? "descend" : "";

    const cleanIcao = ac.icao.toLowerCase().trim();
    const cachedMeta = _metaCache.get(cleanIcao);

    let metaHtml = "";
    if (cachedMeta) {
      if (cachedMeta.loading) {
        metaHtml = `
          <div class="info-row"><span style="color: var(--text-dim);">Details</span><span style="color: var(--text-dim); font-style: italic;">Loading...</span></div>
        `;
      } else if (!cachedMeta.airline && !cachedMeta.manufacturer && !cachedMeta.model && !cachedMeta.registration) {
        metaHtml = `
          <div class="info-row"><span style="color: var(--text-dim);">Details</span><span style="color: var(--text-dim); font-style: italic;">Not available</span></div>
        `;
      } else {
        metaHtml = `
          ${cachedMeta.airline ? `<div class="info-row"><span>Airline</span><span style="color: #00ff65; font-weight: bold;">${cachedMeta.airline}</span></div>` : ""}
          ${cachedMeta.manufacturer ? `<div class="info-row"><span>Manufacturer</span><span>${cachedMeta.manufacturer}</span></div>` : ""}
          ${cachedMeta.model ? `<div class="info-row"><span>Model</span><span>${cachedMeta.model}</span></div>` : ""}
          ${cachedMeta.registration ? `<div class="info-row"><span>Registration</span><span>${cachedMeta.registration}</span></div>` : ""}
        `;
      }
    } else {
      metaHtml = `
        <div class="info-row"><span style="color: var(--text-dim);">Details</span><span style="color: var(--text-dim); font-style: italic;">Loading...</span></div>
      `;
      _fetchMetadata(cleanIcao);
    }

    _els.infoPanelContent.innerHTML = `
      <div class="info-callsign">${callsign}</div>
      <div class="info-icao">ICAO: ${ac.icao.toUpperCase()}</div>
      ${ac.squawk ? `<div class="info-row"><span>Squawk</span><span>${ac.squawk}</span></div>` : ""}
      
      <div id="info-meta-section">
        ${metaHtml}
      </div>
      
      <div class="info-divider"></div>
      <div class="info-row"><span>Altitude</span><span>${Utils.formatAlt(ac.altitude_ft)}</span></div>
      <div class="info-row ${vrateClass}"><span>Climb Rate</span><span>${vrate}</span></div>
      <div class="info-row"><span>Speed</span><span>${Utils.formatSpeed(ac.speed_kts)}</span></div>
      <div class="info-row"><span>Heading</span><span>${Utils.formatBearing(ac.heading_deg)}</span></div>
      <div class="info-divider"></div>
      <div class="info-row"><span>Bearing</span><span>${Utils.formatBearing(ac.bearing_deg)}</span></div>
      <div class="info-row"><span>Distance</span><span>${Utils.formatDist(ac.distance_nm)}</span></div>
      <div class="info-row"><span>On Ground</span><span>${ac.on_ground ? "Yes" : "No"}</span></div>
      <div class="info-divider"></div>
      <div class="info-row small"><span>First seen</span><span>${Utils.formatTime(ac.first_seen)}</span></div>
      <div class="info-row small"><span>Last seen</span><span>${Utils.formatTime(ac.last_seen)}</span></div>
      
      <div id="info-photo-section" style="margin-top: 15px; text-align: center;"></div>
    `;

    const cachedPhoto = _photoCache.get(cleanIcao);
    if (cachedPhoto) {
      _renderPhoto(cleanIcao, cachedPhoto);
    } else {
      _fetchPhoto(cleanIcao);
    }
  }

  function hideAircraftInfo() {
    if (_els.infoPanel) _els.infoPanel.classList.remove("visible");
  }

  // ------------------------------------------------------------------
  // Filter
  // ------------------------------------------------------------------

  function getFilters() {
    const minAlt = _els.altMinSlider ? parseInt(_els.altMinSlider.value) : 0;
    const maxAlt = _els.altMaxSlider ? parseInt(_els.altMaxSlider.value) : 50000;
    return { minAlt, maxAlt };
  }

  function filterAircraft(aircraft) {
    const { minAlt, maxAlt } = getFilters();
    return aircraft.filter(ac => {
      if (ac.on_ground) return minAlt === 0;
      if (ac.altitude_ft == null) return true;
      return ac.altitude_ft >= minAlt && ac.altitude_ft <= maxAlt;
    });
  }

  // ------------------------------------------------------------------
  // Replay controls
  // ------------------------------------------------------------------

  function setReplayStatus(text) {
    if (_els.replayStatus) _els.replayStatus.textContent = text;
  }

  // ------------------------------------------------------------------
  // Utility
  // ------------------------------------------------------------------

  function setHomeLabel(label) {
    if (_els.homeLabel) _els.homeLabel.textContent = label;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  function _bindEvents() {
    // Range dropdown
    if (_els.rangeSelect) {
      _els.rangeSelect.addEventListener("change", () => {
        const nm = parseInt(_els.rangeSelect.value);
        _onRangeChange(nm);
      });
    }

    // Close info panel
    if (_els.closePanelBtn) {
      _els.closePanelBtn.addEventListener("click", () => {
        hideAircraftInfo();
        AircraftRenderer.clearSelection();
      });
    }

    // Filter toggle
    if (_els.filterToggle) {
      _els.filterToggle.addEventListener("click", () => {
        _els.filterPanel.classList.toggle("visible");
      });
    }

    // Altitude sliders
    if (_els.altMinSlider) {
      _els.altMinSlider.addEventListener("input", () => {
        _els.altMinVal.textContent = parseInt(_els.altMinSlider.value).toLocaleString() + " ft";
        _onFilterChange(getFilters());
      });
    }
    if (_els.altMaxSlider) {
      _els.altMaxSlider.addEventListener("input", () => {
        _els.altMaxVal.textContent = parseInt(_els.altMaxSlider.value).toLocaleString() + " ft";
        _onFilterChange(getFilters());
      });
    }

    // Replay toggle
    if (_els.replayToggle) {
      _els.replayToggle.addEventListener("click", () => {
        _els.replayPanel.classList.toggle("visible");
      });
    }

    // Replay play
    if (_els.replayPlayBtn) {
      _els.replayPlayBtn.addEventListener("click", () => {
        if (!_replayActive) {
          _replayActive = true;
          _els.replayPlayBtn.textContent = "⏸ Pause";
          if (!_replayLoaded) {
            _replayLoaded = true;
            _onReplayStart();
          } else {
            _onReplayResume();
          }
        } else {
          _replayActive = false;
          _els.replayPlayBtn.textContent = "▶ Play";
          _onReplayPause();
        }
      });
    }

    // Replay stop
    if (_els.replayStopBtn) {
      _els.replayStopBtn.addEventListener("click", () => {
        _replayActive = false;
        _replayLoaded = false;
        _els.replayPlayBtn.textContent = "▶ Play";
        _onReplayStop();
        setReplayStatus("Stopped");
      });
    }

    // Go Live button click
    if (_els.goLiveBtn) {
      _els.goLiveBtn.addEventListener("click", () => {
        _replayActive = false;
        _replayLoaded = false;
        if (_els.replayPlayBtn) _els.replayPlayBtn.textContent = "▶ Play";
        _onReplayStop();
        setReplayStatus("Ready");
      });
    }

    // Mute button click
    if (_els.muteBtn) {
      _els.muteBtn.addEventListener("click", () => {
        _isMuted = !_isMuted;
        if (_isMuted) {
          _els.muteBtn.classList.add("muted");
          _els.muteBtn.textContent = "🔇 Siren Muted";
        } else {
          _els.muteBtn.classList.remove("muted");
          _els.muteBtn.textContent = "🔊 Mute Siren";
        }
        _onMuteChange(_isMuted);
      });
    }
  }

  function _startClock() {
    function tick() {
      if (_els.clockEl) {
        _els.clockEl.textContent = new Date().toLocaleTimeString();
      }
    }
    tick();
    setInterval(tick, 1000);
  }

  async function _fetchMetadata(icao) {
    if (_metaCache.has(icao)) return;
    _metaCache.set(icao, { loading: true });
    console.log("[UI] _fetchMetadata starting for:", icao);
    try {
      const resp = await fetch(`/api/aircraft/${icao}/metadata`);
      if (!resp.ok) {
        console.warn("[UI] Metadata fetch HTTP error:", resp.status);
        _metaCache.delete(icao);
        return;
      }
      const meta = await resp.json();
      console.log("[UI] _fetchMetadata received meta:", icao, meta);
      _metaCache.set(icao, meta);
      _renderMetadata(icao, meta);
    } catch (e) {
      console.warn(`[UI] Failed to fetch metadata for ${icao}:`, e);
      _metaCache.delete(icao);
    }
  }

  function _renderMetadata(icao, meta) {
    // Check if this aircraft is still selected
    const selected = AircraftRenderer.getSelected();
    console.log("[UI] _renderMetadata checking for:", icao, "selected:", selected ? selected.icao : null, "meta:", meta);
    if (!selected || selected.icao.toLowerCase() !== icao) {
      console.log("[UI] _renderMetadata early exit: selection changed or mismatch");
      return;
    }

    const metaEl = document.getElementById("info-meta-section");
    if (!metaEl) {
      console.warn("[UI] _renderMetadata: #info-meta-section element not found");
      return;
    }

    if (!meta || (!meta.airline && !meta.manufacturer && !meta.model && !meta.registration)) {
      metaEl.innerHTML = `
        <div class="info-row"><span style="color: var(--text-dim);">Details</span><span style="color: var(--text-dim); font-style: italic;">Not available</span></div>
      `;
      return;
    }

    metaEl.innerHTML = `
      ${meta.airline ? `<div class="info-row"><span>Airline</span><span style="color: #00ff65; font-weight: bold;">${meta.airline}</span></div>` : ""}
      ${meta.manufacturer ? `<div class="info-row"><span>Manufacturer</span><span>${meta.manufacturer}</span></div>` : ""}
      ${meta.model ? `<div class="info-row"><span>Model</span><span>${meta.model}</span></div>` : ""}
      ${meta.registration ? `<div class="info-row"><span>Registration</span><span>${meta.registration}</span></div>` : ""}
    `;
  }

  function setPhotoApiUrl(url) {
    _photoApiUrl = url;
  }

  async function _fetchPhoto(icao) {
    if (_photoCache.has(icao)) return;
    _photoCache.set(icao, { loading: true });
    _renderPhoto(icao, { loading: true });
    
    const urlPattern = _photoApiUrl || "https://api.planespotters.net/pub/photos/hex/{icao}";
    const url = urlPattern.replace("{icao}", icao);
    
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        _photoCache.delete(icao);
        _renderPhoto(icao, null);
        return;
      }
      const data = await resp.json();
      const photo = data.photos && data.photos.length > 0 ? data.photos[0] : null;
      _photoCache.set(icao, photo);
      _renderPhoto(icao, photo);
    } catch (e) {
      console.warn(`[UI] Failed to fetch photo for ${icao}:`, e);
      _photoCache.delete(icao);
      _renderPhoto(icao, null);
    }
  }

  function _renderPhoto(icao, photo) {
    const selected = AircraftRenderer.getSelected();
    if (!selected || selected.icao.toLowerCase() !== icao) return;

    const photoEl = document.getElementById("info-photo-section");
    if (!photoEl) return;

    if (photo && photo.loading) {
      photoEl.innerHTML = `<span style="color: var(--text-dim); font-style: italic; font-size: 11px;">Loading aircraft photo...</span>`;
      return;
    }

    if (!photo) {
      photoEl.innerHTML = "";
      return;
    }

    const src = photo.thumbnail_large ? photo.thumbnail_large.src : (photo.thumbnail ? photo.thumbnail.src : null);
    if (!src) {
      photoEl.innerHTML = "";
      return;
    }

    photoEl.innerHTML = `
      <img src="${src}" alt="Aircraft Photo" style="max-width: 100%; border-radius: 4px; border: 1px solid rgba(0, 255, 100, 0.3); margin-top: 8px; box-shadow: 0 0 8px rgba(0, 255, 100, 0.15);" />
      <div style="font-size: 9px; color: var(--text-dim); text-align: right; margin-top: 2px;">Photo by ${photo.photographer || "unknown"}</div>
    `;
  }

  function setProximityAlert(active, color) {
    if (!_els.radarContainer) return;
    if (active) {
      _els.radarContainer.classList.add("proximity-alert");
      if (color) {
        _els.radarContainer.style.setProperty("--proximity-glow-color", color);
      }
    } else {
      _els.radarContainer.classList.remove("proximity-alert");
    }
  }

  function setEmergencyAlert(active, color) {
    if (!_els.app) return;
    if (active) {
      _els.app.classList.add("emergency-alert");
      if (color) {
        _els.app.style.setProperty("--emergency-glow-color", color);
      }
      if (_els.emergencyBanner) _els.emergencyBanner.classList.remove("hidden");
    } else {
      _els.app.classList.remove("emergency-alert");
      if (_els.emergencyBanner) _els.emergencyBanner.classList.add("hidden");
    }
  }

  function showMuteButton(visible) {
    if (!_els.muteBtn) return;
    if (visible) {
      _els.muteBtn.classList.remove("hidden");
    } else {
      _els.muteBtn.classList.add("hidden");
    }
  }

  function isMuted() {
    return _isMuted;
  }

  function resetMute() {
    _isMuted = false;
    if (_els.muteBtn) {
      _els.muteBtn.classList.remove("muted");
      _els.muteBtn.textContent = "🔊 Mute Siren";
    }
  }

  function showGoLiveButton(visible) {
    if (!_els.goLiveBtn) return;
    if (visible) {
      _els.goLiveBtn.classList.remove("hidden");
    } else {
      _els.goLiveBtn.classList.add("hidden");
    }
  }

  // ---------------------------------------------------------------------------
  return {
    init,
    updateStatus,
    showAircraftInfo,
    hideAircraftInfo,
    filterAircraft,
    setReplayStatus,
    setHomeLabel,
    setPhotoApiUrl,
    getFilters,
    setProximityAlert,
    setEmergencyAlert,
    showMuteButton,
    isMuted,
    resetMute,
    showGoLiveButton,
  };
})();
