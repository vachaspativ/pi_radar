#!/usr/bin/env bash
# Restart Pi Radar backend and kiosk UI
set -e
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

if [ "$(id -u)" -eq 0 ]; then
    info "Restarting Pi Radar backend and kiosk..."
    systemctl restart pi-radar
    systemctl restart pi-radar-kiosk
    info "Done."
else
    echo "Please run as root: sudo bash scripts/restart-app.sh"
    exit 1
fi
