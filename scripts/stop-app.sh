#!/usr/bin/env bash
# Stop Pi Radar backend and kiosk UI only
set -e
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

if [ "$(id -u)" -eq 0 ]; then
    info "Stopping Pi Radar backend and kiosk..."
    systemctl stop pi-radar-kiosk || true
    systemctl stop pi-radar || true
    info "Pi Radar stopped."
else
    echo "Please run as root: sudo bash scripts/stop-app.sh"
    exit 1
fi
