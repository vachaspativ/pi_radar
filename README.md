# Pi Radar — ADS-B Flight Radar

Real-time radar-style display for flights overhead, powered by a USB RTL-SDR dongle decoding ADS-B at 1090 MHz. Falls back to OpenSky Network when the dongle is unavailable. Runs on Raspberry Pi 5 and develops on Windows.

---

## Quick Start (Windows Development)

### 1. Install Python 3.11+

Download from **https://www.python.org/downloads/** — during installation:
- ✅ Check **"Add Python to PATH"**
- Click **Customize installation** → check **"pip"** and **"venv"**

Verify: open a new PowerShell and run `python --version`

### 2. Create Virtual Environment

```powershell
cd "c:\Users\vacha\code\pi radar"
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If you get an execution policy error:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 3. Configure

Edit `config.yaml` — set your home coordinates (the centre of the radar):
```yaml
radar:
  home_lat: 32.7767    # ← Your latitude
  home_lon: -96.7970   # ← Your longitude
```

The `development.use_mock_source: true` setting in `config.yaml` enables simulated aircraft for Windows testing.

### 4. Run

```powershell
.\venv\Scripts\Activate.ps1
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

Open your browser at: **http://localhost:8000**

You should see the green phosphor radar with simulated aircraft flying around!

---

## OpenSky Network Fallback (Optional)

1. Create a free account at https://opensky-network.org
2. Go to **Account → API Clients** → Create a new client
3. Copy your `client_id` and `client_secret` into `config.yaml`:
   ```yaml
   opensky:
     enabled: true
     client_id: "your_client_id"
     client_secret: "your_client_secret"
   ```
4. To test fallback on Windows, set `development.use_mock_source: false` and ensure dump1090 is not running (it will fail 3 times then switch to OpenSky)

---

## Raspberry Pi 5 — Full Installation

### Prerequisites
- Raspberry Pi 5 (4GB or 8GB)
- Raspberry Pi OS 64-bit (Bookworm)
- RTL-SDR Blog V3 or NooElec NESDR dongle + 1090 MHz antenna
- Internet connection for setup

### Install

Copy the project to the Pi and run:
```bash
sudo bash scripts/install.sh
```

This will:
1. Install system dependencies
2. Blacklist the DVB kernel module (required for RTL-SDR)
3. Install `dump1090-fa` (ADS-B decoder)
4. Create Python venv and install dependencies
5. Install and enable systemd services
6. Optionally install `fr24feed` (feed to FlightRadar24 for free Business subscription)

### After Installation

1. Edit `/home/pi/pi-radar/config.yaml`:
   - Set your home coordinates
   - Add OpenSky credentials
   - Set `development.use_mock_source: false`
2. Restart the service: `sudo systemctl restart pi-radar`
3. Access the radar at `http://pi-radar.local:8000`

---

## Project Structure

```
pi-radar/
├── config.yaml              ← All configuration (edit this!)
├── requirements.txt
│
├── backend/
│   ├── main.py              ← FastAPI app entry point
│   ├── config.py            ← Config loader
│   ├── data_manager.py      ← Aircraft state + geo math
│   ├── sources/
│   │   ├── mock_source.py   ← Simulated data (Windows dev)
│   │   ├── dump1090_source.py ← RTL-SDR live data
│   │   ├── opensky_source.py  ← OpenSky API fallback
│   │   └── source_manager.py  ← Auto-switch logic
│   ├── db/database.py       ← SQLite (1hr track history)
│   ├── ws/websocket_handler.py ← WebSocket broadcast
│   └── api/                 ← REST endpoints
│
├── frontend/
│   ├── index.html           ← Single page app
│   ├── css/main.css         ← Phosphor green theme
│   ├── css/radar.css        ← Layout & panels
│   └── js/
│       ├── utils.js         ← Geo math utilities
│       ├── radar.js         ← Background canvas (rings, compass)
│       ├── sweep.js         ← 60fps sweep animation
│       ├── aircraft.js      ← Blips, trails, click detection
│       ├── ui.js            ← Info panel, filters, controls
│       └── app.js           ← Main app + WebSocket client
│
├── systemd/                 ← Pi systemd service files
└── scripts/install.sh       ← Pi automated installer
```

---

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | GET | Radar UI |
| `/api/aircraft` | GET | All live aircraft |
| `/api/aircraft/{icao}` | GET | Single aircraft |
| `/api/status` | GET | System status |
| `/api/history/{icao}` | GET | Track history |
| `/api/replay?from_ts=&to_ts=` | GET | Replay data |
| `/api/config` | GET/POST | Configuration |
| `/ws` | WebSocket | Live updates (5s) |

---

## Troubleshooting

**No aircraft visible in mock mode?**
Check `development.use_mock_source: true` in `config.yaml` and restart.

**OpenSky returns 401?**
The API now uses OAuth2. Ensure you have `client_id` and `client_secret` (not username/password) from the OpenSky Account → API Clients page.

**dump1090-fa not connecting on Pi?**
Run `systemctl status dump1090-fa` and `rtl_test` to verify the dongle is recognized. Ensure DVB module is blacklisted.

**Canvas not rendering in Chromium on Pi?**
Enable GPU rasterization: the kiosk service already passes `--enable-gpu-rasterization --enable-zero-copy`.

---

*Built with FastAPI + Vanilla JS + Canvas 2D · Runs on Raspberry Pi 5*
