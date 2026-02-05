#!/bin/bash
set -e

# Setup TAP Device Pool for Otus
# This script creates a pool of TAP devices and configures network connectivity

# Configuration
BRIDGE_NAME="otus-br0"
TAP_PREFIX="otus-tap"
TAP_COUNT=10
BRIDGE_IP="172.20.0.1"
BRIDGE_SUBNET="172.20.0.0/24"
GUEST_IP_START=2

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Otus TAP Device Pool Setup ===${NC}"

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}Error: This script must be run as root${NC}"
   echo "Please run: sudo $0"
   exit 1
fi

# Install required packages
echo -e "${YELLOW}Checking dependencies...${NC}"
if ! command -v ip &> /dev/null; then
    echo "Installing iproute2..."
    apt-get update && apt-get install -y iproute2
fi

if ! command -v iptables &> /dev/null; then
    echo "Installing iptables..."
    apt-get update && apt-get install -y iptables
fi

if ! command -v dnsmasq &> /dev/null; then
    echo "Installing dnsmasq..."
    apt-get update && apt-get install -y dnsmasq
fi

# Enable IP forwarding
echo -e "${YELLOW}Enabling IP forwarding...${NC}"
sysctl -w net.ipv4.ip_forward=1 > /dev/null
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-otus.conf

# Create bridge if it doesn't exist
if ! ip link show "$BRIDGE_NAME" &> /dev/null; then
    echo -e "${YELLOW}Creating bridge $BRIDGE_NAME...${NC}"
    ip link add name "$BRIDGE_NAME" type bridge
    ip addr add "$BRIDGE_IP/24" dev "$BRIDGE_NAME"
    ip link set "$BRIDGE_NAME" up
    echo -e "${GREEN}✓ Bridge created${NC}"
else
    echo -e "${GREEN}✓ Bridge $BRIDGE_NAME already exists${NC}"
fi

# Create TAP devices
echo -e "${YELLOW}Creating TAP devices...${NC}"
for i in $(seq 0 $((TAP_COUNT - 1))); do
    TAP_NAME="${TAP_PREFIX}${i}"
    
    if ! ip link show "$TAP_NAME" &> /dev/null; then
        # Create TAP device
        ip tuntap add "$TAP_NAME" mode tap
        
        # Set ownership to current user (if sudo from user)
        if [[ -n "$SUDO_USER" ]]; then
            chown "$SUDO_USER" "/dev/net/tun" 2>/dev/null || true
        fi
        
        # Attach to bridge
        ip link set "$TAP_NAME" master "$BRIDGE_NAME"
        ip link set "$TAP_NAME" up
        
        echo -e "${GREEN}✓ Created $TAP_NAME${NC}"
    else
        # Ensure it's attached to bridge
        if ! ip link show "$TAP_NAME" | grep -q "master $BRIDGE_NAME"; then
            ip link set "$TAP_NAME" master "$BRIDGE_NAME"
        fi
        ip link set "$TAP_NAME" up
        echo -e "${GREEN}✓ $TAP_NAME already exists (verified)${NC}"
    fi
done

# Setup NAT for internet access
echo -e "${YELLOW}Configuring NAT...${NC}"

# Get default network interface
DEFAULT_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)

if [[ -z "$DEFAULT_IFACE" ]]; then
    echo -e "${YELLOW}Warning: Could not detect default network interface${NC}"
    echo "NAT will not be configured. VMs will not have internet access."
else
    echo "Using interface: $DEFAULT_IFACE"
    
    # Clear existing NAT rules for this bridge
    iptables -t nat -D POSTROUTING -s "$BRIDGE_SUBNET" -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null || true
    
    # Add NAT rule
    iptables -t nat -A POSTROUTING -s "$BRIDGE_SUBNET" -o "$DEFAULT_IFACE" -j MASQUERADE
    
    # Allow forwarding
    iptables -D FORWARD -i "$BRIDGE_NAME" -o "$DEFAULT_IFACE" -j ACCEPT 2>/dev/null || true
    iptables -D FORWARD -i "$DEFAULT_IFACE" -o "$BRIDGE_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
    
    iptables -A FORWARD -i "$BRIDGE_NAME" -o "$DEFAULT_IFACE" -j ACCEPT
    iptables -A FORWARD -i "$DEFAULT_IFACE" -o "$BRIDGE_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT
    
    echo -e "${GREEN}✓ NAT configured${NC}"
fi

# Save iptables rules (Debian/Ubuntu)
if command -v iptables-save &> /dev/null; then
    echo -e "${YELLOW}Saving iptables rules...${NC}"
    
    # Try to save to persistent location
    if [[ -d /etc/iptables ]]; then
        iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    fi
    
    # Also try netfilter-persistent if available
    if command -v netfilter-persistent &> /dev/null; then
        netfilter-persistent save 2>/dev/null || true
    fi
fi

# Create configuration file for Otus
CONFIG_FILE="/etc/otus-tap-pool.conf"
cat > "$CONFIG_FILE" << EOF
# Otus TAP Device Pool Configuration
# Generated on $(date)

BRIDGE_NAME=$BRIDGE_NAME
TAP_PREFIX=$TAP_PREFIX
TAP_COUNT=$TAP_COUNT
BRIDGE_IP=$BRIDGE_IP
BRIDGE_SUBNET=$BRIDGE_SUBNET
GUEST_IP_START=$GUEST_IP_START
EOF

echo -e "${GREEN}✓ Configuration saved to $CONFIG_FILE${NC}"

# Setup DHCP server (dnsmasq)
echo -e "${YELLOW}Configuring DHCP server...${NC}"

# Stop any running dnsmasq that might interfere
systemctl stop dnsmasq 2>/dev/null || true

# Create dnsmasq configuration for Otus bridge
DNSMASQ_CONF="/etc/dnsmasq.d/otus.conf"
cat >   DHCP Server: dnsmasq on $BRIDGE_NAME"
echo ""
echo "To verify the setup:"
echo "  bun run check:networkP Configuration
# Only bind to Otus bridge
interface=$BRIDGE_NAME
bind-interfaces

# DHCP range (172.20.0.2 - 172.20.0.254)
dhcp-range=172.20.0.$GUEST_IP_START,172.20.0.254,255.255.255.0,12h

# DNS servers (Google DNS)
dhcp-option=6,8.8.8.8,8.8.4.4

# Gateway
dhcp-option=3,$BRIDGE_IP

# Don't read /etc/resolv.conf or /etc/hosts for this interface
no-resolv
no-hosts
server=8.8.8.8
server=8.8.4.4

# Static leases for known TAP devices (optional, for predictable IPs)
EOF

# Add static DHCP leases for each TAP device (ensures predictable IPs)
for i in $(seq 0 $((TAP_COUNT - 1))); do
    TAP_NAME="${TAP_PREFIX}${i}"
    # Generate MAC address (same logic as in tap-pool.ts)
    MAC=$(printf "06:00:00:00:%02x:%02x" $((i / 256)) $((i % 256)))
    IP="172.20.0.$((GUEST_IP_START + i))"
    echo "dhcp-host=$MAC,$IP" >> "$DNSMASQ_CONF"
done

# Restart dnsmasq
systemctl restart dnsmasq
systemctl enable dnsmasq

echo -e "${GREEN}✓ DHCP server configured${NC}"

# Display summary
echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo "TAP Device Pool:"
echo "  Bridge: $BRIDGE_NAME ($BRIDGE_IP)"
echo "  TAP Devices: ${TAP_PREFIX}0 - ${TAP_PREFIX}$((TAP_COUNT - 1))"
echo "  Guest IP Range: 172.20.0.$GUEST_IP_START - 172.20.0.$((GUEST_IP_START + TAP_COUNT - 1))"
echo ""
echo "To verify the setup:"
echo "  ip link show | grep -E '(${BRIDGE_NAME}|${TAP_PREFIX})'"
echo "  ip addr show ${BRIDGE_NAME}"
echo ""
echo "To clean up (remove all TAP devices):"
echo "  sudo $0 clean"
echo ""

# Handle cleanup command
if [[ "${1:-}" == "clean" ]]; then
    echo ""
    echo -e "${YELLOW}=== Cleaning up TAP devices ===${NC}"
    
    # Remove TAP devices
    for i in $(seq 0 $((TAP_COUNT - 1))); do
        TAP_NAME="${TAP_PREFIX}${i}"
        if ip link show "$TAP_NAME" &> /dev/null; then
            ip link delete "$TAP_NAME"
            echo -e "${GREEN}✓ Removed $TAP_NAME${NC}"
        fi
    done
    
    # Remove bridge
    if ip link show "$BRIDGE_NAME" &> /dev/null; then
        ip link delete "$BRIDGE_NAME"
        echo -e "${GREEN}✓ Removed bridge $BRIDGE_NAME${NC}"
    fi
    
    # Remove iptables rules
    DEFAULT_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
    if [[ -n "$DEFAULT_IFACE" ]]; then
        iptables -t nat -D POSTROUTING -s "$BRIDGE_SUBNET" -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null || true
        iptables -D FORWARD -i "$BRIDGE_NAME" -o "$DEFAULT_IFACE" -j ACCEPT 2>/dev/null || true
        iptables -D FORWARD -i "$DEFAULT_IFACE" -o "$BRIDGE_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
        echo -e "${GREEN}✓ Removed iptables rules${NC}"
    # Remove dnsmasq configuration
    if [[ -f /etc/dnsmasq.d/otus.conf ]]; then
        rm -f /etc/dnsmasq.d/otus.conf
        systemctl restart dnsmasq 2>/dev/null || true
        echo -e "${GREEN}✓ Removed dnsmasq configuration${NC}"
    fi
    
    fi
    
    echo ""
    echo -e "${GREEN}Cleanup complete!${NC}"
    exit 0
fi
