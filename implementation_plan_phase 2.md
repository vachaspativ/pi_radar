# Map Background, Airport Markers & Plane Icons — Implementation Plan

## Overview

Three major visual enhancements:
1. **Map tile background** — OpenStreetMap tiles rendered on a new canvas layer, zooming/panning in sync with the NM range selector.
2. **Airport markers** — Airports within the current radar view fetched from the Overpass API (free, no auth) and rendered as distinct icons on the blip canvas.
3. **Plane-shaped icons** — Replace the circular blip with a rotated aircraft silhouette (SVG-path drawn via Canvas 2D), pointing in the direction of travel. Airports get a different distinctive icon.

---

## ⚠️ Critical Architecture Decision: Projection System

The current app uses a **polar (bearing + haversine) projection** centred on home:
```
dist = haversineNm(home → aircraft)     // great-circle distance
brng = bearingTo(home → aircraft)        // compass bearing
px   = cx + radius * (dist/maxRangeNm) * sin(brng)
py   = cy − radius * (dist/maxRangeNm) * cos(brng)
```

OSM map tiles use **Web Mercator** projection (EPSG:3857). These two projections do not match exactly.

**The good news:** At radar ranges of 25–200 nm centred at ~33° latitude (Prosper TX), the angular distortion between polar and Mercator is small. At 100 nm, edge distortion is ~3–5%, which is imperceptible on a radar display. This is not a navigation chart — it is a situational awareness display.

**Chosen approach:** Render map tiles using Web Mercator, keep all aircraft/airport positioning using the existing polar projection. The map provides geographic context (you can recognise roads and cities), not pixel-perfect geographic accuracy. No changes to `utils.js` or any coordinate math.

> [!NOTE]
> This is the same tradeoff used by real ATC radar displays — the map background and the blip coordinates use independent projections that are "close enough" for short ranges.

---

## Architecture Overview: Canvas Layer Stack

The current stack is 3 stacked `<canvas>` elements. We will insert a 4th as the bottom layer:

```
Layer 0 (NEW): map-canvas     ← OSM tile map (redrawn on range change)
Layer 1 (bg-canvas):          ← Range rings, compass rose, grid (transparent bg)
Layer 2 (sweep-canvas):       ← 60fps sweep animation (unchanged)
Layer 3 (blip-canvas):        ← Aircraft plane icons, airport markers, trails, labels
```

> [!IMPORTANT]
> The existing `bg-canvas` background (dark fill + rings) will remain on top of the map tiles. We will make its background **transparent** (remove the solid dark fill) so the map shows through, while keeping the range rings, compass, and grid overlay with semi-transparent styles.

---

## Open Questions / Design Decisions

> [!IMPORTANT]
> **Map tile opacity**: The map tiles will be visible underneath the phosphor-green radar overlay. We can render tiles at reduced opacity (e.g. 50–70%) so the map is readable but doesn't overpower the radar aesthetic. Do you want:
> - **Dark map tiles** (e.g. CartoDB Dark Matter — free, no API key) — stays in the phosphor theme
> - **Standard OSM tiles** (`tile.openstreetmap.org`) — colourful, slightly dissonant with green theme
> - **No base map colour, just coastlines/borders** — minimal map, pure radar feel
>
> **Recommendation:** CartoDB Dark Matter (`https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png`) — attribution required but free, dark-themed, no API key needed.

> [!IMPORTANT]
> **Airport filtering**: The Overpass API returns all aerodromes (commercial airports, private airfields, heliports, grass strips). Do you want to show:
> - Only **commercial airports** (IATA code present) — shows major airports only
> - **All aerodromes** — includes small private airfields (potentially many markers at low range)
> - **Configurable toggle** in the UI to show/hide airports

---

## Proposed Changes

---

### Component 1: Frontend — Map Tile Layer

#### [NEW] `frontend/js/map.js`

A new module `MapRenderer` responsible for:
- Computing the OSM tile zoom level from `rangeNm` and canvas size.
- Computing home lat/lon → Mercator tile `(x, y)` anchor and fractional pixel offset within the tile grid.
- Computing which tile X/Y cells are visible within the radar circle (a square neighbourhood around the anchor).
- Fetching tile PNG images asynchronously; caching them in a `Map<"z/x/y", HTMLImageElement>` to avoid re-fetching on redraws.
- Drawing each tile at the correct pixel offset on `map-canvas`, clipped to the radar circle.
- Applying `globalAlpha = 0.55` for the dimming overlay effect.
- Redrawing only when range or canvas size changes (not on every animation frame).

**How tile positioning works (Mercator anchor):**
```
// Home lat/lon → fractional tile coordinate at zoom z
homeTileX = (homeLon + 180) / 360 * 2^z
homeTileY = (1 − ln(tan(lat) + sec(lat)) / π) / 2 * 2^z

// The home location is always drawn at canvas centre (cx, cy).
// Each tile is 256x256 CSS pixels. Tile (tx, ty) is drawn at:
pixelOffX = cx + (tx − homeTileX) * 256
pixelOffY = cy + (ty − homeTileY) * 256
```
This makes the map stay perfectly centred on home regardless of zoom.

**Zoom level mapping for Prosper TX (latitude ~33°):**

| Range (NM) | OSM Zoom Level | Ground resolution |
|---|---|---|
| 25 nm | 10 | ~0.5 nm/tile |
| 50 nm | 9 | ~1 nm/tile |
| 100 nm | 8 | ~2 nm/tile |
| 150 nm | 7 | ~4 nm/tile |
| 200 nm | 7 | ~4 nm/tile |

Formula: `zoom = clamp(floor(log2(cos(lat_rad) * 21639 * canvasDiameter_px / (rangeNm * 256 * 1.15))), 4, 12)`

**Key functions:**
- `init(canvas, cx, cy, radius, homeLat, homeLon)` — store geometry, setup tile cache
- `setRange(rangeNm)` — recompute zoom, fetch visible tiles, draw
- `resize(cx, cy, radius)` — update geometry, redraw
- `draw()` — composite tiles + clipping + attribution

**Tile server:** `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` (CartoDB Dark Matter — dark-themed, free, no API key)
**Attribution:** `"© OpenStreetMap contributors © CARTO"` drawn at 9px in bottom-left corner of the radar circle.

---

### Component 2: Frontend — `bg-canvas` Transparency Change

#### [MODIFY] [radar.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/radar.js)

- Remove the solid dark `ctx.fillRect(0, 0, w, h)` background fill from `_drawBackground()`.
- Change range ring and grid line colours to semi-transparent green variants (they currently read well on dark background; with map tiles they need slightly more contrast).
- Keep the outer border ring and vignette overlay (the radial gradient vignette already uses transparency and will still darken the edges over the map).
- The `_clipToCircle()` composite operation (destination-in) must be applied on the bg-canvas itself — this should still work fine.

---

### Component 3: Backend — Airport Endpoint

#### [NEW] `backend/api/airport_router.py`

A new FastAPI router with one endpoint:

```
GET /api/airports?range_nm=100
```

- Computes bounding box from `config.radar.home_lat/lon` + margin from `range_nm`.
- Queries the **Overpass API** (free, no auth): `https://overpass-api.de/api/interpreter`
- Query: all nodes/ways tagged `aeroway=aerodrome` within the bounding box.
- Returns a filtered list: `[{ icao, iata, name, lat, lon, type }]`.
- **Caches results in memory for 30 minutes** (airports don't move; avoids hammering Overpass).
- Filters out airports without a position (nodes without centroid).
- Falls back to an empty list if Overpass is unreachable (no hard error).

This is added to `backend/main.py` as `app.include_router(airport_router)`.

---

### Component 4: Frontend — Airport Renderer

#### [MODIFY] [aircraft.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/aircraft.js)

Add new airport rendering logic to the existing `AircraftRenderer` module:

- Add `updateAirports(airportArray)` function to store airport list.
- In the `draw()` function, after drawing aircraft, call `_drawAirports(ctx)`.
- `_drawAirports()` iterates over airports, converts each `lat/lon` to canvas coords via `Utils.latLonToCanvas()`, and draws the airport icon.

**Airport icon design** — a simple runway symbol (two crossing lines with a circle):
```
    |
  ──┼──   (cross with a circle around it)
    |
```
Drawn using Canvas 2D paths in phosphor amber colour (`#ffaa00`) to visually distinguish from aircraft (green).

**Airport labels:** Show ICAO code below the icon (or IATA if ICAO unavailable). Suppressed below a minimum pixel spacing to avoid label overlap.

---

### Component 5: Frontend — Plane-shaped Aircraft Icons

#### [MODIFY] [aircraft.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/aircraft.js)

Replace `_drawBlip()` with `_drawPlaneIcon()`:

- The icon is a small aircraft silhouette drawn as a Canvas 2D path, rotated by `heading_deg`.
- Uses `ctx.save()` / `ctx.translate(x, y)` / `ctx.rotate(headingRad)` / `ctx.restore()` pattern.
- The path is a simplified top-down aircraft shape (~14px wingspan):
  - Fuselage: narrow vertical rectangle (nose up by default).
  - Wings: swept-back horizontal lines midway along fuselage.
  - Tail: small horizontal line at the rear.
- Altitude colour-coding is retained (the fill/stroke colour matches the current altitude band).
- Selected aircraft: slightly larger icon + white colour + glow effect (same as current behaviour).
- On-ground aircraft: shown as a smaller, dimmer version of the icon.
- Remove the separate `_drawHeadingArrow()` since the plane icon itself conveys direction.

**Existing trail and label logic is unchanged** — only the blip rendering changes.

---

### Component 6: Frontend — App Integration

#### [MODIFY] [app.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/app.js)

- Add `map-canvas` element to the canvas stack in `_initCanvases()`.
- Initialize `MapRenderer` with `init(mapCanvas, homeLat, homeLon)`.
- On range change: call `MapRenderer.setRange(rangeNm)` alongside existing `RadarRenderer.setRange()`.
- On resize: call `MapRenderer.resize()`.
- Fetch `/api/airports?range_nm=<current>` on startup and on range change. Pass result to `AircraftRenderer.updateAirports()`.
- Re-fetch airports whenever range changes (bounding box grows/shrinks).

#### [MODIFY] [index.html](file:///c:/Users/vacha/code/pi%20radar/frontend/index.html)

- Add `<canvas id="map-canvas" class="radar-canvas" aria-hidden="true"></canvas>` as the first canvas inside `#radar-container`.
- Add `<script src="/js/map.js"></script>` before `radar.js`.

---

## Verification Plan

### Manual Verification

1. Start the server: `uvicorn backend.main:app --host 0.0.0.0 --port 8000`
2. Open `http://localhost:8000` in Chrome.
3. **Map tiles:** Verify map background loads and shows the Dallas/Fort Worth area centered at Prosper TX.
4. **Range zoom:** Change range from 100 nm → 25 nm. Map should zoom in (streets become visible); change to 200 nm, map zooms out to show multi-state view.
5. **Airport markers:** At 100 nm range, Dallas/Fort Worth (KDFW), Dallas Love Field (KDAL), Alliance (KAFW), and McKinney (KTKI) should all appear with amber runway icons.
6. **Plane icons:** All aircraft should appear as directional plane silhouettes pointing in their direction of travel. Rotating aircraft icon should visually match the heading vector.
7. **Click detection:** Clicking a plane icon still selects the aircraft and opens the info panel.
8. **Phosphor aesthetic:** The green phosphor radar overlay (rings, sweep, blips) should remain dominant and legible with the map underneath.
9. **Pi 7" screen:** Test at 800×480 — icons should remain visible without overlap. Minimum icon size: 12px.

### API Verification

```powershell
# Check airport endpoint
curl http://localhost:8000/api/airports?range_nm=100
# Expect: JSON array with KDFW, KDAL, KAFW etc. with lat/lon/icao/name
```

---

## Files Summary

| File | Action | Purpose |
|---|---|---|
| `frontend/js/map.js` | **NEW** | OSM tile map renderer |
| `frontend/js/aircraft.js` | **MODIFY** | Plane icons + airport marker rendering |
| `frontend/index.html` | **MODIFY** | Add map-canvas layer + map.js script tag |
| `backend/api/airport_router.py` | **NEW** | `/api/airports` endpoint via Overpass API |
| `backend/main.py` | **MODIFY** | Register airport router |
| `frontend/js/radar.js` | **MODIFY** | Remove solid background fill (make transparent) |
| `frontend/js/app.js` | **MODIFY** | Wire MapRenderer + airport fetch on range change |
