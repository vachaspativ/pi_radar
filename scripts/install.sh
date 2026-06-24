#!/usr/bin/env bash
# =============================================================================
# Pi Radar — Automated Installation Script for Raspberry Pi 5
# Run as: bash scripts/install.sh
# =============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/home/pi/pi-radar"
VENV_DIR="$INSTALL_DIR/venv"
PI_USER="${SUDO_USER:-pi}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || error "This script must be run as root: sudo bash scripts/install.sh"
[ -f /proc/device-tree/model ] && grep -q "Raspberry Pi" /proc/device-tree/model || warn "Not running on a Raspberry Pi — skipping Pi-specific steps"

info "======================================================="
info " Pi Radar Installation Starting"
info "======================================================="

# ── 1. System dependencies ─────────────────────────────────────────────────
info "Installing system packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl wget git \
    librtlsdr0 rtl-sdr \
    chromium-browser \
    2>/dev/null || true

# ── 2. Blacklist DVB kernel module (required for RTL-SDR) ──────────────────
info "Blacklisting DVB-T kernel module..."
cat > /etc/modprobe.d/blacklist-rtl-sdr.conf << 'EOF'
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
EOF
modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

# ── 3. Install dump1090-fa ─────────────────────────────────────────────────
if ! command -v dump1090-fa &>/dev/null; then
    info "Installing dump1090-fa (FlightAware ADS-B decoder)..."
    wget -qO- https://flightaware.com/adsb/piaware/install | bash -s
    apt-get install -y dump1090-fa 2>/dev/null || \
        warn "Could not install dump1090-fa automatically — install manually from FlightAware PPA"
else
    info "dump1090-fa is already installed"
fi

# ── 4. Copy Pi Radar source ────────────────────────────────────────────────
info "Copying Pi Radar to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR"/../* "$INSTALL_DIR/"
chown -R "$PI_USER:$PI_USER" "$INSTALL_DIR"

# ── 5. Python virtual environment ─────────────────────────────────────────
info "Creating Python virtual environment..."
sudo -u "$PI_USER" python3 -m venv "$VENV_DIR"
sudo -u "$PI_USER" "$VENV_DIR/bin/pip" install --upgrade pip -q
sudo -u "$PI_USER" "$VENV_DIR/bin/pip" install -r "$INSTALL_DIR/requirements.txt" -q
info "Python dependencies installed"

# ── 6. Configure Pi Radar ─────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/config.yaml" ]; then
    cp "$INSTALL_DIR/config.yaml.example" "$INSTALL_DIR/config.yaml"
fi
info "Edit $INSTALL_DIR/config.yaml to set your home coordinates and API keys"

# ── 7. Systemd services ────────────────────────────────────────────────────
info "Installing systemd services..."
cp "$INSTALL_DIR/systemd/pi-radar.service"       /etc/systemd/system/
cp "$INSTALL_DIR/systemd/pi-radar-kiosk.service" /etc/systemd/system/
systemctl daemon-reload

systemctl enable dump1090-fa
systemctl enable pi-radar
systemctl enable pi-radar-kiosk

info "Starting dump1090-fa..."
systemctl start dump1090-fa || warn "dump1090-fa failed to start — is RTL-SDR connected?"

info "Starting Pi Radar backend..."
systemctl start pi-radar

# ── 8. Optional: fr24feed ─────────────────────────────────────────────────
read -p "$(echo -e ${YELLOW}Install fr24feed to feed FlightRadar24? [y/N]${NC} )" -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    info "Installing fr24feed..."
    wget -qO- https://fr24.com/install.sh | bash -s
    info "Run 'sudo fr24feed --signup' to configure your sharing key"
    info "Set receiver type=Beast TCP, host=127.0.0.1, port=30005"
fi

# ── 9. Summary ────────────────────────────────────────────────────────────
info "======================================================="
info " Installation Complete!"
info "======================================================="
info " Pi Radar URL : http://localhost:8000"
info " Config file  : $INSTALL_DIR/config.yaml"
info " View logs    : journalctl -u pi-radar -f"
info " Status       : systemctl status pi-radar"
info ""
info " After configuring config.yaml, restart with:"
info "   sudo systemctl restart pi-radar"
