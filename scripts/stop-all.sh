#!/usr/bin/env bash
# Stop all ADS-B receiver components
set -e
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

if [ "$(id -u)" -eq 0 ]; then
    if systemctl list-unit-files | grep -q "fr24feed.service"; then
        info "Stopping fr24feed..."
        systemctl stop fr24feed || true
    fi
    
    info "Stopping Pi Radar backend & kiosk..."
    systemctl stop pi-radar-kiosk || true
    systemctl stop pi-radar || true
    
    info "Stopping dump1090-fa..."
    systemctl stop dump1090-fa || true
    
    info "All components stopped."
else
    echo "Please run as root: sudo bash scripts/stop-all.sh"
    exit 1
fi
