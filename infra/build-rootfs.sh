#!/bin/bash
# Build a minimal Ubuntu rootfs for the Firecracker VM
# Includes the Otus guest agent

set -euo pipefail

ROOTFS_SIZE="${ROOTFS_SIZE:-4G}"
UBUNTU_RELEASE="${UBUNTU_RELEASE:-noble}"  # Ubuntu 24.04 LTS
INSTALL_DIR="./infra"
ROOTFS_DIR="${INSTALL_DIR}/rootfs-build"
ROOTFS_IMAGE="${INSTALL_DIR}/rootfs.ext4"

echo "==> Building rootfs for Ubuntu ${UBUNTU_RELEASE}"

# Check for required tools
if ! command -v debootstrap &> /dev/null; then
    echo "Error: debootstrap not found"
    echo "Run: sudo apt install debootstrap"
    exit 1
fi

# Check for agent binary
if [[ ! -f "./dist/otus-agent" ]]; then
    echo "Error: Guest agent not found at ./dist/otus-agent"
    echo "Run: bun run build:agent"
    exit 1
fi

# Create build directory
echo "==> Creating rootfs directory"
sudo rm -rf "$ROOTFS_DIR"
mkdir -p "$ROOTFS_DIR"

# Run debootstrap
echo "==> Running debootstrap (this may take a few minutes)..."
sudo debootstrap \
    --variant=minbase \
    --arch=amd64 \
    --include=systemd,systemd-sysv,systemd-resolved,udev,dbus,ca-certificates,iproute2,iputils-ping,curl,python3 \
    "$UBUNTU_RELEASE" \
    "$ROOTFS_DIR" \
    http://archive.ubuntu.com/ubuntu/

echo "✓ Base system installed"

# Configure apt sources with universe repository for pip/venv
echo "==> Configuring apt sources"
sudo tee "${ROOTFS_DIR}/etc/apt/sources.list" > /dev/null <<EOF
deb http://archive.ubuntu.com/ubuntu/ ${UBUNTU_RELEASE} main universe
deb http://archive.ubuntu.com/ubuntu/ ${UBUNTU_RELEASE}-updates main universe
deb http://archive.ubuntu.com/ubuntu/ ${UBUNTU_RELEASE}-security main universe
EOF

# Install additional packages via chroot (with proper mounts)
echo "==> Installing Python and Node.js packages"

# Mount necessary filesystems for chroot
sudo mount --bind /proc "${ROOTFS_DIR}/proc"
sudo mount --bind /sys "${ROOTFS_DIR}/sys"
sudo mount --bind /dev "${ROOTFS_DIR}/dev"
sudo mount --bind /dev/pts "${ROOTFS_DIR}/dev/pts"

# Run apt-get in chroot
sudo chroot "$ROOTFS_DIR" /bin/bash -c "apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv nodejs npm && apt-get clean && rm -rf /var/lib/apt/lists/*"

# Unmount in reverse order
sudo umount "${ROOTFS_DIR}/dev/pts" || true
sudo umount "${ROOTFS_DIR}/dev" || true
sudo umount "${ROOTFS_DIR}/sys" || true
sudo umount "${ROOTFS_DIR}/proc" || true

echo "✓ Python and Node.js packages installed"

# Configure the rootfs
echo "==> Configuring rootfs"

# Set hostname
echo "otus-vm" | sudo tee "${ROOTFS_DIR}/etc/hostname" > /dev/null

# Configure /etc/hosts for localhost resolution
sudo tee "${ROOTFS_DIR}/etc/hosts" > /dev/null <<EOF
127.0.0.1   localhost
127.0.1.1   otus-vm
::1         localhost ip6-localhost ip6-loopback
EOF

# Configure networking
sudo mkdir -p "${ROOTFS_DIR}/etc/systemd/network"

# Configure loopback interface (required for localhost)
sudo tee "${ROOTFS_DIR}/etc/systemd/network/10-loopback.network" > /dev/null <<EOF
[Match]
Name=lo

[Network]
Address=127.0.0.1/8
EOF

# Create link file to ensure eth0 is always brought up
sudo tee "${ROOTFS_DIR}/etc/systemd/network/10-eth0.link" > /dev/null <<EOF
[Match]
OriginalName=eth0

[Link]
Name=eth0
MACAddressPolicy=none
EOF

# Create network configuration with DHCP
sudo tee "${ROOTFS_DIR}/etc/systemd/network/20-eth0.network" > /dev/null <<EOF
[Match]
Name=eth0

[Link]
RequiredForOnline=yes

[Network]
DHCP=yes
DNS=8.8.8.8
DNS=8.8.4.4

[DHCP]
UseDNS=yes
UseRoutes=yes
UseMTU=yes
RouteMetric=100
EOF

# Enable systemd-networkd services
sudo mkdir -p "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants"
sudo mkdir -p "${ROOTFS_DIR}/etc/systemd/system/network-online.target.wants"
sudo mkdir -p "${ROOTFS_DIR}/etc/systemd/system/sockets.target.wants"

sudo ln -sf /lib/systemd/system/systemd-networkd.service \
    "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
sudo ln -sf /lib/systemd/system/systemd-networkd.socket \
    "${ROOTFS_DIR}/etc/systemd/system/sockets.target.wants/systemd-networkd.socket"
sudo ln -sf /lib/systemd/system/systemd-networkd-wait-online.service \
    "${ROOTFS_DIR}/etc/systemd/system/network-online.target.wants/systemd-networkd-wait-online.service"
sudo ln -sf /lib/systemd/system/systemd-resolved.service \
    "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/systemd-resolved.service"

# Create static resolv.conf with DNS servers
sudo rm -f "${ROOTFS_DIR}/etc/resolv.conf"
sudo tee "${ROOTFS_DIR}/etc/resolv.conf" > /dev/null <<EOF
# Static DNS configuration
nameserver 8.8.8.8
nameserver 8.8.4.4
options edns0 trust-ad
EOF

# Create network initialization script (fallback if systemd-networkd doesn't work)
sudo tee "${ROOTFS_DIR}/usr/local/bin/init-network.sh" > /dev/null <<'SCRIPT'
#!/bin/bash
# Fallback network initialization for Firecracker VM
# Waits for DHCP, falls back to static config if needed

set -e

IFACE="eth0"
TIMEOUT=10
GATEWAY="172.20.0.1"

# Bring interface up
ip link set "$IFACE" up 2>/dev/null || true

# Wait for DHCP to assign an address
for i in $(seq 1 $TIMEOUT); do
    if ip addr show "$IFACE" | grep -q "inet "; then
        echo "Network configured via DHCP"
        exit 0
    fi
    sleep 1
done

# DHCP failed - check if we have a route
if ! ip route | grep -q "default"; then
    echo "DHCP timed out, configuring fallback network..."
    
    # Get assigned IP from MAC-based TAP pool mapping
    # MAC format: 06:00:00:00:XX:YY where index = XX*256 + YY
    MAC=$(cat /sys/class/net/$IFACE/address 2>/dev/null || echo "")
    if [[ -n "$MAC" ]]; then
        # Parse the last two octets to get the TAP index
        LAST_OCTETS=$(echo "$MAC" | cut -d: -f5,6 | tr ':' ' ')
        HIGH=$(echo "$LAST_OCTETS" | awk '{print $1}')
        LOW=$(echo "$LAST_OCTETS" | awk '{print $2}')
        INDEX=$((16#$HIGH * 256 + 16#$LOW))
        GUEST_IP="172.20.0.$((2 + INDEX))"
    else
        GUEST_IP="172.20.0.2"
    fi
    
    # Configure static IP
    ip addr add "$GUEST_IP/24" dev "$IFACE" 2>/dev/null || true
    ip route add default via "$GATEWAY" 2>/dev/null || true
    
    echo "Fallback network configured: $GUEST_IP via $GATEWAY"
fi
SCRIPT
sudo chmod +x "${ROOTFS_DIR}/usr/local/bin/init-network.sh"

# Create systemd service for fallback network init
sudo tee "${ROOTFS_DIR}/etc/systemd/system/init-network.service" > /dev/null <<EOF
[Unit]
Description=Fallback Network Initialization
After=systemd-networkd.service
Wants=systemd-networkd.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/init-network.sh
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo ln -sf /etc/systemd/system/init-network.service \
    "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/init-network.service"

# Install the Otus agent (Go binary with native VSock support)
echo "==> Installing Otus agent"
sudo mkdir -p "${ROOTFS_DIR}/usr/local/bin"
sudo cp ./dist/otus-agent "${ROOTFS_DIR}/usr/local/bin/otus-agent"
sudo chmod +x "${ROOTFS_DIR}/usr/local/bin/otus-agent"

# Create systemd service for the agent (no proxy needed - Go agent supports VSock directly)
sudo tee "${ROOTFS_DIR}/etc/systemd/system/otus-agent.service" > /dev/null <<EOF
[Unit]
Description=Otus Guest Agent
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/local/bin/otus-agent
Restart=always
RestartSec=1
StandardOutput=journal
StandardError=journal
WorkingDirectory=/workspace

[Install]
WantedBy=multi-user.target
EOF

# Enable agent service
sudo ln -sf /etc/systemd/system/otus-agent.service \
    "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/otus-agent.service"

# Create workspace directory
sudo mkdir -p "${ROOTFS_DIR}/workspace"

# Set root password (for debugging, not used normally)
# chpasswd needs /etc to be writable (already is) but can work without special mounts
echo "root:otus" | sudo chroot "$ROOTFS_DIR" /usr/sbin/chpasswd

# Clean up any stale mounts before creating the image
echo "==> Ensuring clean filesystem state"
for mp in "${ROOTFS_DIR}/dev/pts" "${ROOTFS_DIR}/dev" "${ROOTFS_DIR}/sys" "${ROOTFS_DIR}/proc" "${ROOTFS_DIR}/run"; do
    sudo umount "$mp" 2>/dev/null || true
done

# Kill any processes that might still be using the rootfs
sudo fuser -k "${ROOTFS_DIR}" 2>/dev/null || true

# Create the ext4 image
echo "==> Creating ext4 filesystem image"
rm -f "$ROOTFS_IMAGE"
truncate -s "$ROOTFS_SIZE" "$ROOTFS_IMAGE"
sudo mkfs.ext4 -d "$ROOTFS_DIR" -F "$ROOTFS_IMAGE"

echo "✓ Rootfs image created at ${ROOTFS_IMAGE}"

# Cleanup
echo "==> Cleaning up build directory"
sudo rm -rf "$ROOTFS_DIR"

# Show file info
ls -lh "$ROOTFS_IMAGE"

echo ""
echo "==> Rootfs build complete!"
echo "The guest agent will start automatically on boot"
echo "Next step: Configure your VM with ./infra/vm-config.json"
