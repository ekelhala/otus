#!/bin/bash
# Build Ubuntu rootfs for Firecracker VM using debootstrap
# Uses full variant (not minbase) for a more complete environment

set -euo pipefail

ROOTFS_SIZE="${ROOTFS_SIZE:-4G}"
UBUNTU_RELEASE="${UBUNTU_RELEASE:-noble}"  # Ubuntu 24.04 LTS
INSTALL_DIR="./infra"
ROOTFS_DIR="${INSTALL_DIR}/rootfs-build"
ROOTFS_IMAGE="${INSTALL_DIR}/rootfs.ext4"

# Cleanup function to unmount filesystems
cleanup() {
    echo "==> Cleaning up mounts..."
    sudo umount "${ROOTFS_DIR}/dev/pts" 2>/dev/null || true
    sudo umount "${ROOTFS_DIR}/dev" 2>/dev/null || true
    sudo umount "${ROOTFS_DIR}/sys" 2>/dev/null || true
    sudo umount "${ROOTFS_DIR}/proc" 2>/dev/null || true
}

# Set trap to always cleanup on exit
trap cleanup EXIT INT TERM

echo "==> Building rootfs for Ubuntu ${UBUNTU_RELEASE} (full variant)"

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

# Run debootstrap with full variant (not minbase) and common packages
# Note: python3-pip, python3-venv, nodejs, npm, tree are in universe, installed later
echo "==> Running debootstrap (this may take a few minutes)..."
sudo debootstrap \
    --arch=amd64 \
    --include=systemd,systemd-sysv,systemd-resolved,udev,dbus,\
ca-certificates,iproute2,iputils-ping,curl,wget,\
bash,bash-completion,coreutils,findutils,grep,sed,gawk,\
python3,git,vim-tiny,nano,less,file,\
build-essential,make,gcc,g++,\
openssh-client,rsync,tar,gzip,unzip,\
locales,sudo \
    "$UBUNTU_RELEASE" \
    "$ROOTFS_DIR" \
    http://archive.ubuntu.com/ubuntu/

echo "✓ Base system installed"

# Configure apt sources with universe repository
echo "==> Configuring apt sources"
sudo tee "${ROOTFS_DIR}/etc/apt/sources.list" > /dev/null <<EOF
deb http://archive.ubuntu.com/ubuntu/ ${UBUNTU_RELEASE} main universe
deb http://archive.ubuntu.com/ubuntu/ ${UBUNTU_RELEASE}-updates main universe
deb http://archive.ubuntu.com/ubuntu/ ${UBUNTU_RELEASE}-security main universe
EOF

# Install packages from universe repository via chroot
echo "==> Installing additional packages from universe..."
sudo mount --bind /proc "${ROOTFS_DIR}/proc"
sudo mount --bind /sys "${ROOTFS_DIR}/sys"
sudo mount --bind /dev "${ROOTFS_DIR}/dev"
sudo mount --bind /dev/pts "${ROOTFS_DIR}/dev/pts"

sudo chroot "$ROOTFS_DIR" /bin/bash -c "apt-get update && apt-get install -y --no-install-recommends python3-pip python3-venv nodejs npm tree tmux && apt-get clean"

# Unmounts will be handled by the cleanup trap

# Configure locale
echo "==> Configuring locale"
sudo chroot "$ROOTFS_DIR" /bin/bash -c "locale-gen en_US.UTF-8"
echo "LANG=en_US.UTF-8" | sudo tee "${ROOTFS_DIR}/etc/default/locale" > /dev/null

echo "✓ Additional packages installed"

# Configure the rootfs
echo "==> Configuring rootfs"

# Set hostname
echo "otus-vm" | sudo tee "${ROOTFS_DIR}/etc/hostname" > /dev/null

# Configure /etc/hosts
sudo tee "${ROOTFS_DIR}/etc/hosts" > /dev/null <<EOF
127.0.0.1   localhost
127.0.1.1   otus-vm
::1         localhost ip6-localhost ip6-loopback
EOF

# Configure networking
sudo mkdir -p "${ROOTFS_DIR}/etc/systemd/network"

# Loopback interface
sudo tee "${ROOTFS_DIR}/etc/systemd/network/10-loopback.network" > /dev/null <<EOF
[Match]
Name=lo

[Network]
Address=127.0.0.1/8
EOF

# eth0 link configuration
sudo tee "${ROOTFS_DIR}/etc/systemd/network/10-eth0.link" > /dev/null <<EOF
[Match]
OriginalName=eth0

[Link]
Name=eth0
MACAddressPolicy=none
EOF

# eth0 network with DHCP
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

# Static resolv.conf
sudo rm -f "${ROOTFS_DIR}/etc/resolv.conf"
sudo tee "${ROOTFS_DIR}/etc/resolv.conf" > /dev/null <<EOF
nameserver 8.8.8.8
nameserver 8.8.4.4
options edns0 trust-ad
EOF

# Fallback network init script
sudo tee "${ROOTFS_DIR}/usr/local/bin/init-network.sh" > /dev/null <<'SCRIPT'
#!/bin/bash
set -e
IFACE="eth0"
TIMEOUT=10
GATEWAY="172.20.0.1"

ip link set "$IFACE" up 2>/dev/null || true

for i in $(seq 1 $TIMEOUT); do
    if ip addr show "$IFACE" | grep -q "inet "; then
        exit 0
    fi
    sleep 1
done

if ! ip route | grep -q "default"; then
    MAC=$(cat /sys/class/net/$IFACE/address 2>/dev/null || echo "")
    if [[ -n "$MAC" ]]; then
        LAST_OCTETS=$(echo "$MAC" | cut -d: -f5,6 | tr ':' ' ')
        HIGH=$(echo "$LAST_OCTETS" | awk '{print $1}')
        LOW=$(echo "$LAST_OCTETS" | awk '{print $2}')
        INDEX=$((16#$HIGH * 256 + 16#$LOW))
        GUEST_IP="172.20.0.$((2 + INDEX))"
    else
        GUEST_IP="172.20.0.2"
    fi
    ip addr add "$GUEST_IP/24" dev "$IFACE" 2>/dev/null || true
    ip route add default via "$GATEWAY" 2>/dev/null || true
fi
SCRIPT
sudo chmod +x "${ROOTFS_DIR}/usr/local/bin/init-network.sh"

# Systemd service for fallback network
sudo tee "${ROOTFS_DIR}/etc/systemd/system/init-network.service" > /dev/null <<EOF
[Unit]
Description=Fallback Network Initialization
After=systemd-networkd.service
Wants=systemd-networkd.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/init-network.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo ln -sf /etc/systemd/system/init-network.service \
    "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/init-network.service"

# Install the Otus agent
echo "==> Installing Otus agent"
sudo mkdir -p "${ROOTFS_DIR}/usr/local/bin"
sudo cp ./dist/otus-agent "${ROOTFS_DIR}/usr/local/bin/otus-agent"
sudo chmod +x "${ROOTFS_DIR}/usr/local/bin/otus-agent"

# Systemd service for agent
sudo tee "${ROOTFS_DIR}/etc/systemd/system/otus-agent.service" > /dev/null <<EOF
[Unit]
Description=Otus Guest Agent
After=local-fs.target

[Service]
Type=simple
ExecStart=/usr/local/bin/otus-agent
Restart=always
RestartSec=1
WorkingDirectory=/workspace

[Install]
WantedBy=multi-user.target
EOF

sudo ln -sf /etc/systemd/system/otus-agent.service \
    "${ROOTFS_DIR}/etc/systemd/system/multi-user.target.wants/otus-agent.service"

# Create workspace directory
sudo mkdir -p "${ROOTFS_DIR}/workspace"

# Set root password (for debugging)
echo "root:otus" | sudo chroot "$ROOTFS_DIR" /usr/sbin/chpasswd

# Clean up
echo "==> Cleaning up build artifacts"
sudo rm -rf "${ROOTFS_DIR}/var/cache/apt/archives"/*.deb
sudo rm -rf "${ROOTFS_DIR}/var/lib/apt/lists"/*

# Unmount special filesystems before creating image
echo "==> Unmounting special filesystems..."
cleanup

# Create the ext4 image
echo "==> Creating ext4 filesystem image"
rm -f "$ROOTFS_IMAGE"
truncate -s "$ROOTFS_SIZE" "$ROOTFS_IMAGE"
sudo mkfs.ext4 -d "$ROOTFS_DIR" -F "$ROOTFS_IMAGE"

echo "✓ Rootfs image created at ${ROOTFS_IMAGE}"

# Cleanup build directory
echo "==> Cleaning up build directory"
sudo rm -rf "$ROOTFS_DIR"

ls -lh "$ROOTFS_IMAGE"

echo "==> Setting permissions on rootfs image"
sudo chown "$USER" "$ROOTFS_IMAGE"

echo ""
echo "==> Rootfs build complete!"
echo "Included: bash, git, python3, nodejs, build-essential, common tools"
echo "The guest agent will start automatically on boot"
