# Map Improvements, Smaller Planes, Zoom Levels, Airport Filtering & Aircraft Details — Implementation Plan

This plan introduces five major improvements to the Pi Radar application to enhance readability, usability, and detail coverage.

## User Review Required

> [!NOTE]
> **Mock Metadata Generation**: In development/mock mode, we will generate realistic simulated metadata (e.g. Southwest Airlines, Boeing 737-800) based on the simulated callsigns, so that the metadata features can be tested fully without requiring a live SDR antenna.
>
> **HexDB Rate Limiting**: The public `hexdb.io` API has rate limits. To protect it and speed up the UI, we will cache all resolved metadata in a new local SQLite table (`aircraft_metadata`). Unknown aircraft will also be cached as empty to prevent repeated lookups.

## Open Questions

No open questions. The requirements are fully specified.

---

## Proposed Changes

### Component 1: Map Contrast, Vignette & Translucent Radar Layer

#### [MODIFY] [map.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/map.js)
- Increase `TILE_OPACITY` from `0.52` to `0.85` so the background map is clearer and on focus.
- Increase `MAX_ZOOM` from `12` to `14` to allow higher-resolution tiles when zoomed in to 5 or 10 nm.

#### [MODIFY] [radar.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/radar.js)
- Modify the `C` color palette to use transparent/translucent greens (e.g., `rgba(...)` with low alphas) so they float as a "very light radar layer" on top of the map.
- Modify the vignette overlay in `_drawBackground` to use a dark translucent black vignette (`rgba(0,0,0,0.1)` to `rgba(0,0,0,0.4)`) instead of green, ensuring the map tiles shine through clearly while preserving contrast at the edges.
- Define a dictionary `RANGE_RINGS` mapping each range (5, 10, 25, 50, 100, 150, 200 nm) to its respective concentric ring locations (e.g., 5 nm range draws rings at 1, 2, 3, 4, and 5 nm). Update `setRange()` to load these rings dynamically.

#### [MODIFY] [sweep.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/sweep.js)
- Dim the sweep decay trail by changing its maximum alpha from `0.18` to `0.09`.
- Dim the leading sweep line gradient by changing its maximum alpha from `1.0` to `0.7`.

---

### Component 2: Shrunk Plane Icons & Airport Labels

#### [MODIFY] [aircraft.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/aircraft.js)
- Reduce `BLIP_RADIUS` from `5` to `3.5` and `SELECTED_RADIUS` from `8` to `6`.
- Update `_drawPlaneIcon` scale factor `s` from `size * 1.5` to `size * 1.1`. This reduces the overall canvas plane silhouette dimensions to about half, minimizing screen clutter.
- Update `_drawAirportIcon` to read and display the FAA code (`ap.faa`) as a fallback label if `icao` and `iata` are not present.

---

### Component 3: Zoom Levels (5 nm and 10 nm)

#### [MODIFY] [index.html](file:///c:/Users/vacha/code/pi%20radar/frontend/index.html)
- Add `<option value="5">5 nm</option>` and `<option value="10">10 nm</option>` to the `#range-select` dropdown.

---

### Component 4: Airport Filtering (Show only large/public airports)

#### [MODIFY] [airport_router.py](file:///c:/Users/vacha/code/pi%20radar/backend/api/airport_router.py)
- Update `_fetch_airports` to populate the `faa` key from the tags, if present.
- Filter out aerodromes that lack all identifier codes (`icao`, `iata`, and `faa`). This successfully removes backyard grass strips, gliderports, and private helipads while keeping all municipal, regional, and international commercial airports (including McKinney, Addison, and Denton).

---

### Component 5: Extended Aircraft Details Panel

#### [MODIFY] [database.py](file:///c:/Users/vacha/code/pi%20radar/backend/db/database.py)
- Define a new schema for the `aircraft_metadata` table:
  ```sql
  CREATE TABLE IF NOT EXISTS aircraft_metadata (
      icao              TEXT PRIMARY KEY,
      registration      TEXT,
      manufacturer      TEXT,
      model             TEXT,
      airline           TEXT,
      updated_at        INTEGER NOT NULL
  );
  ```
- Initialize it in `init_db()`.
- Add helper functions `get_aircraft_metadata(icao: str)` and `insert_aircraft_metadata(...)` to read/write cache entries.

#### [MODIFY] [aircraft_router.py](file:///c:/Users/vacha/code/pi%20radar/backend/api/aircraft_router.py)
- Create a new endpoint `GET /api/aircraft/{icao}/metadata`.
- If mock source mode is active, generate realistic mock registration, airline, and model details based on the callsign.
- Otherwise:
  - Query `aircraft_metadata` local DB table.
  - If a cached record is found and is less than 7 days old, return it.
  - Otherwise, query `https://hexdb.io/api/v1/aircraft/{hex}`.
  - If found (200), parse the fields (`Registration`, `Manufacturer`, `Type` for model, `RegisteredOwners` for airline) and store them in the database.
  - If not found (404), store empty values in the database (so we don't query hexdb again for this unknown target).

#### [MODIFY] [ui.js](file:///c:/Users/vacha/code/pi%20radar/frontend/js/ui.js)
- Update `showAircraftInfo(ac)` to fetch details asynchronously from `/api/aircraft/{icao}/metadata`.
- Populate these extra fields (Airline, Model, Registration) in the right details panel.
- Update CSS styling if necessary to support the new rows cleanly.

---

## Verification Plan

### Automated Tests
- Restart the FastAPI application.
- Execute unit tests or script-level queries to verify:
  1. `/api/airports` properly filters down to ~76 airports for Dallas/Prosper at 100 nm (removing all small backyard strips).
  2. `/api/aircraft/{icao}/metadata` returns correct mock data in mock mode, and queries HexDB correctly in live mode.

### Manual Verification
- Open the web application in a browser.
- Zoom in to `5 nm` and `10 nm` zoom levels; verify rings render at appropriate offsets and map tiles load in high resolution.
- Verify the map background is clearer/more vibrant and the green radar lines are light and translucent on top.
- Click an aircraft and verify the details panel displays the airline name, plane model, and registration.
- Verify plane icons are smaller and less cluttered.
