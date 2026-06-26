#!/usr/bin/env bash
# Restart Pi Radar backend and kiosk UI
set -e
GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $*"; }

if [ "$(id -u)" -eq 0 ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    CONFIG_FILE="$SCRIPT_DIR/../config.yaml"
    VENV_PYTHON="$SCRIPT_DIR/../venv/bin/python"

    KIOSK_ENABLED="false"
    if [ -f "$CONFIG_FILE" ] && [ -f "$VENV_PYTHON" ]; then
        KIOSK_ENABLED=$("$VENV_PYTHON" -c "import yaml; print(str(yaml.safe_load(open('$CONFIG_FILE')).get('display', {}).get('kiosk_mode', False)).lower())" 2>/dev/null || echo "false")
    fi

    info "Restarting Pi Radar backend..."
    systemctl restart pi-radar

    if [ "$KIOSK_ENABLED" = "true" ]; then
        info "Restarting Pi Radar kiosk..."
        systemctl restart pi-radar-kiosk
    else
        info "Kiosk mode is disabled, stopping any running kiosk..."
        systemctl stop pi-radar-kiosk || true
    fi
    info "Done."
else
    echo "Please run as root: sudo bash scripts/restart-app.sh"
    exit 1
fi
