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
  let _onReplayStop = null;
  let _replayActive = false;
  const _metaCache  = new Map();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init(callbacks = {}) {
    _onRangeChange  = callbacks.onRangeChange  || (() => {});
    _onFilterChange = callbacks.onFilterChange || (() => {});
    _onReplayStart  = callbacks.onReplayStart  || (() => {});
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
      replayStatus:     document.getElementById("replay-status"),
      homeLabel:        document.getElementById("home-label"),
      clockEl:          document.getElementById("clock"),
    };

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
      metaHtml = `
        ${cachedMeta.airline ? `<div class="info-row"><span>Airline</span><span style="color: #00ff65; font-weight: bold;">${cachedMeta.airline}</span></div>` : ""}
        ${cachedMeta.model ? `<div class="info-row"><span>Model</span><span>${cachedMeta.model}</span></div>` : ""}
        ${cachedMeta.registration ? `<div class="info-row"><span>Registration</span><span>${cachedMeta.registration}</span></div>` : ""}
      `;
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
    `;
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
          _onReplayStart();
        } else {
          _replayActive = false;
          _els.replayPlayBtn.textContent = "▶ Play";
        }
      });
    }

    // Replay stop
    if (_els.replayStopBtn) {
      _els.replayStopBtn.addEventListener("click", () => {
        _replayActive = false;
        _els.replayPlayBtn.textContent = "▶ Play";
        _onReplayStop();
        setReplayStatus("Stopped");
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
    console.log("[UI] _fetchMetadata starting for:", icao);
    try {
      const resp = await fetch(`/api/aircraft/${icao}/metadata`);
      if (!resp.ok) {
        console.warn("[UI] Metadata fetch HTTP error:", resp.status);
        return;
      }
      const meta = await resp.json();
      console.log("[UI] _fetchMetadata received meta:", icao, meta);
      _metaCache.set(icao, meta);
      _renderMetadata(icao, meta);
    } catch (e) {
      console.warn(`[UI] Failed to fetch metadata for ${icao}:`, e);
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

    if (!meta || (!meta.airline && !meta.model && !meta.registration)) {
      metaEl.innerHTML = "";
      return;
    }

    metaEl.innerHTML = `
      ${meta.airline ? `<div class="info-row"><span>Airline</span><span style="color: #00ff65; font-weight: bold;">${meta.airline}</span></div>` : ""}
      ${meta.model ? `<div class="info-row"><span>Model</span><span>${meta.model}</span></div>` : ""}
      ${meta.registration ? `<div class="info-row"><span>Registration</span><span>${meta.registration}</span></div>` : ""}
    `;
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
    getFilters,
  };
})();
