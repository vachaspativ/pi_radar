import asyncio
import json
import logging
from typing import Optional, Tuple
from fastapi import FastAPI

logger = logging.getLogger("pi_radar.gps")

def convert_nmea_coords(lat_val: str, lat_dir: str, lon_val: str, lon_dir: str) -> Optional[Tuple[float, float]]:
    try:
        if not lat_val or not lon_val:
            return None
        
        # Latitude: DDMM.MMMM...
        lat_deg = float(lat_val[:2])
        lat_min = float(lat_val[2:])
        lat = lat_deg + (lat_min / 60.0)
        if lat_dir == "S":
            lat = -lat
            
        # Longitude: DDDMM.MMMM... (three digits for degrees)
        lon_deg = float(lon_val[:3])
        lon_min = float(lon_val[3:])
        lon = lon_deg + (lon_min / 60.0)
        if lon_dir == "W":
            lon = -lon
            
        return lat, lon
    except Exception:
        return None

def parse_nmea(line: str) -> Optional[Tuple[float, float]]:
    parts = line.split(",")
    if not parts:
        return None
    
    cmd = parts[0]
    # Handle both standard GP and multi-constellation GN, etc.
    if cmd.endswith("RMC"):
        # $--RMC,time,status,lat,N,lon,E,speed,track,date,...
        if len(parts) >= 7 and parts[2] == "A": # "A" = Active/Valid Fix
            return convert_nmea_coords(parts[3], parts[4], parts[5], parts[6])
    elif cmd.endswith("GGA"):
        # $--GGA,time,lat,N,lon,E,fix_quality,num_satellites,...
        if len(parts) >= 7 and parts[6] != "0": # fix_quality != 0 (invalid)
            return convert_nmea_coords(parts[2], parts[3], parts[4], parts[5])
    return None

class GPSPoller:
    """
    Background worker that queries gpsd over local TCP or opens a serial
    port to parse NMEA directly. Dynamically updates the home lat/lon coordinates
    of the radar and broadcasts updates via WebSocket.
    """
    def __init__(self, app: FastAPI):
        self.app = app
        self.config = app.state.config
        self.running = False
        self.task = None

    def start(self):
        if hasattr(self.config, "gps") and self.config.gps.enabled:
            self.running = True
            self.task = asyncio.create_task(self.run())
            logger.info("[GPS] Poller enabled & started")
        else:
            logger.info("[GPS] Poller disabled in configuration")

    def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
            logger.info("[GPS] Poller stopped")

    async def run(self):
        while self.running:
            try:
                if self.config.gps.use_gpsd:
                    await self._poll_gpsd()
                else:
                    await self._poll_serial()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"[GPS] Error in polling loop: {e}")
            
            # Wait before attempting connection/polling retry
            await asyncio.sleep(10)

    async def _poll_gpsd(self):
        host = self.config.gps.gpsd_host
        port = self.config.gps.gpsd_port
        
        logger.info(f"[GPS] Connecting to gpsd daemon at {host}:{port}...")
        try:
            reader, writer = await asyncio.open_connection(host, port)
        except Exception as e:
            logger.warning(f"[GPS] Failed to connect to gpsd: {e}")
            raise
            
        # Register for GPS JSON updates
        writer.write(b'?WATCH={"enable":true,"json":true};\n')
        await writer.drain()
        
        logger.info("[GPS] Connected to gpsd, waiting for TPV sentences...")
        while self.running:
            line = await reader.readline()
            if not line:
                break
            try:
                data = json.loads(line.decode("utf-8", errors="ignore").strip())
                if data.get("class") == "TPV" and "lat" in data and "lon" in data:
                    lat = float(data["lat"])
                    lon = float(data["lon"])
                    await self._update_location(lat, lon)
            except Exception as e:
                logger.debug(f"[GPS] Error parsing gpsd response: {e}")

    async def _poll_serial(self):
        try:
            import serial
        except ImportError:
            logger.error("[GPS] 'pyserial' is not installed. Please run `pip install pyserial` to read GPS over serial.")
            await asyncio.sleep(60)
            return

        device = self.config.gps.device
        baud = self.config.gps.baudrate
        
        logger.info(f"[GPS] Opening serial device {device} at {baud} baud...")
        loop = asyncio.get_running_loop()
        
        # Run synchronous serial reader loop in executor to keep main async loop free
        await loop.run_in_executor(None, self._serial_read_sync, device, baud)

    def _serial_read_sync(self, device: str, baud: int):
        import serial
        try:
            ser = serial.Serial(device, baud, timeout=2)
        except Exception as e:
            logger.error(f"[GPS] Failed to open serial device {device}: {e}")
            return
            
        try:
            logger.info(f"[GPS] Successfully opened serial port {device}, reading NMEA lines...")
            while self.running:
                line_bytes = ser.readline()
                if not line_bytes:
                    continue
                try:
                    line = line_bytes.decode("ascii", errors="ignore").strip()
                    if line.startswith("$"):
                        res = parse_nmea(line)
                        if res:
                            lat, lon = res
                            # Safe propagation to the main asyncio loop thread
                            asyncio.run_coroutine_threadsafe(
                                self._update_location(lat, lon), 
                                self.app.state.loop
                            )
                except Exception as e:
                    logger.debug(f"[GPS] Error parsing serial line: {e}")
        finally:
            ser.close()

    async def _update_location(self, lat: float, lon: float):
        old_lat = self.config.radar.home_lat
        old_lon = self.config.radar.home_lon
        
        # Only update if there is a significant movement (> 0.0001 degrees)
        if abs(old_lat - lat) > 0.0001 or abs(old_lon - lon) > 0.0001:
            logger.info(f"[GPS] Location Lock Updated: Lat={lat:.6f}, Lon={lon:.6f}")
            self.config.radar.home_lat = lat
            self.config.radar.home_lon = lon
            
            # Propagate to managers
            self.app.state.data_manager.set_home(lat, lon)
            self.app.state.source_manager.set_home(lat, lon)
            
            # Broadcast update via WS
            ws_mgr = self.app.state.ws_manager
            await ws_mgr.broadcast_json({
                "type": "location_update",
                "lat": lat,
                "lon": lon
            })
