#!/usr/bin/env bash
# Restart all ADS-B receiver components (decoder, app backend, kiosk UI, feeder)
set -e
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

if [ "$(id -u)" -eq 0 ]; then
    info "Restarting dump1090-fa (decoder)..."
    systemctl restart dump1090-fa || true
    
    info "Restarting Pi Radar application & kiosk..."
    systemctl restart pi-radar
    systemctl restart pi-radar-kiosk
    
    if systemctl list-unit-files | grep -q "fr24feed.service"; then
        info "Restarting fr24feed (FlightRadar24 feeder)..."
        systemctl restart fr24feed || true
    fi
    info "Done."
else
    echo "Please run as root: sudo bash scripts/restart-all.sh"
    exit 1
fi
