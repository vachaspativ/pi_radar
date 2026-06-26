#!/usr/bin/env bash
# =============================================================================
# Pi Radar — Automated Installation Script for Raspberry Pi 5
# Run as: bash scripts/install.sh
# =============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_USER="${SUDO_USER:-$USER}"
[ -z "$PI_USER" ] || [ "$PI_USER" = "root" ] && PI_USER="pi"
USER_HOME=$(eval echo ~"$PI_USER")
INSTALL_DIR="$USER_HOME/pi-radar"
VENV_DIR="$INSTALL_DIR/venv"

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

# ── 3. Install dump1090-fa & piaware ───────────────────────────────────────
if ! command -v dump1090-fa &>/dev/null; then
    info "Installing FlightAware APT repository..."
    wget -q https://www.flightaware.com/adsb/piaware/files/packages/pool/piaware/f/flightaware-apt-repository/flightaware-apt-repository_1.3_all.deb
    dpkg -i flightaware-apt-repository_1.3_all.deb
    rm flightaware-apt-repository_1.3_all.deb
    apt-get update -qq

    info "Installing dump1090-fa and piaware..."
    apt-get install -y dump1090-fa piaware 2>/dev/null || \
        warn "Could not install dump1090-fa/piaware automatically — install manually from FlightAware PPA"
else
    info "dump1090-fa is already installed"
fi

# ── 4. Copy Pi Radar source ────────────────────────────────────────────────
info "Copying Pi Radar to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR"/../* "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR"/scripts/*.sh
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

# Load display screen dimensions from config.yaml
SCREEN_WIDTH="800"
SCREEN_HEIGHT="480"
CONFIG_PATH="$INSTALL_DIR/config.yaml"
if [ -f "$CONFIG_PATH" ]; then
    SCREEN_WIDTH=$("$VENV_DIR/bin/python" -c "import yaml; print(str(yaml.safe_load(open('$CONFIG_PATH')).get('display', {}).get('screen_width', 800)))" 2>/dev/null || echo "800")
    SCREEN_HEIGHT=$("$VENV_DIR/bin/python" -c "import yaml; print(str(yaml.safe_load(open('$CONFIG_PATH')).get('display', {}).get('screen_height', 480)))" 2>/dev/null || echo "480")
fi

# Replace user, group and path placeholders to support custom usernames (not just 'pi')
sed -e "s|User=pi|User=$PI_USER|g" \
    -e "s|Group=pi|Group=$PI_USER|g" \
    -e "s|/home/pi/pi-radar|$INSTALL_DIR|g" \
    "$INSTALL_DIR/systemd/pi-radar.service" > /etc/systemd/system/pi-radar.service

sed -e "s|User=pi|User=$PI_USER|g" \
    -e "s|Group=pi|Group=$PI_USER|g" \
    -e "s|/home/pi/pi-radar|$INSTALL_DIR|g" \
    -e "s|/home/pi/|$USER_HOME/|g" \
    -e "s|--window-size=800,480|--window-size=$SCREEN_WIDTH,$SCREEN_HEIGHT|g" \
    "$INSTALL_DIR/systemd/pi-radar-kiosk.service" > /etc/systemd/system/pi-radar-kiosk.service

systemctl daemon-reload

systemctl enable dump1090-fa
systemctl enable pi-radar

# Determine if kiosk mode should be enabled/started based on config.yaml
KIOSK_ENABLED="false"
CONFIG_PATH="$INSTALL_DIR/config.yaml"
if [ -f "$CONFIG_PATH" ]; then
    KIOSK_ENABLED=$("$VENV_DIR/bin/python" -c "import yaml; print(str(yaml.safe_load(open('$CONFIG_PATH')).get('display', {}).get('kiosk_mode', False)).lower())" 2>/dev/null || echo "false")
fi

info "Starting dump1090-fa..."
systemctl start dump1090-fa || warn "dump1090-fa failed to start — is RTL-SDR connected?"

info "Starting Pi Radar backend..."
systemctl start pi-radar

if [ "$KIOSK_ENABLED" = "true" ]; then
    info "Enabling and starting Pi Radar Chromium Kiosk..."
    systemctl enable pi-radar-kiosk
    systemctl start pi-radar-kiosk
else
    info "Kiosk mode is disabled in config.yaml. Disabling kiosk service..."
    systemctl disable pi-radar-kiosk || true
    systemctl stop pi-radar-kiosk || true
fi

# ── 8. Optional: fr24feed ─────────────────────────────────────────────────
if ! command -v fr24feed &>/dev/null; then
    read -p "$(echo -e ${YELLOW}Install fr24feed to feed FlightRadar24? [y/N]${NC} )" -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        info "Installing fr24feed..."
        wget -qO- https://fr24.com/install.sh | bash -s
        info "Run 'sudo fr24feed --signup' to configure your sharing key"
        info "Set receiver type=Beast TCP, host=127.0.0.1, port=30005"
    fi
else
    info "fr24feed is already installed — skipping installation"
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
