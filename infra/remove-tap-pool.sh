#!/bin/bash
set -e

# Remove TAP Device Pool for Otus
# This script removes all TAP devices, bridge, and network configuration

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${YELLOW}=== Removing Otus TAP Device Pool ===${NC}"
echo ""

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo -e "${RED}Error: This script must be run as root${NC}"
   echo "Please run: sudo $0"
   exit 1
fi

# Load configuration or use defaults
if [[ -f /etc/otus-tap-pool.conf ]]; then
    source /etc/otus-tap-pool.conf
    echo -e "${GREEN}Loaded configuration from /etc/otus-tap-pool.conf${NC}"
else
    echo -e "${YELLOW}Warning: /etc/otus-tap-pool.conf not found, using defaults${NC}"
    BRIDGE_NAME="otus-br0"
    TAP_PREFIX="otus-tap"
    TAP_COUNT=10
    BRIDGE_SUBNET="172.20.0.0/24"
fi

echo ""

# Stop any VMs that might be using TAP devices
echo -e "${YELLOW}Warning: This will remove all TAP devices.${NC}"
echo "Make sure all Otus VMs are stopped before proceeding."
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo ""

# Remove TAP devices
echo -e "${YELLOW}Removing TAP devices...${NC}"
REMOVED_COUNT=0
for i in $(seq 0 $((TAP_COUNT - 1))); do
    TAP_NAME="${TAP_PREFIX}${i}"
    if ip link show "$TAP_NAME" &> /dev/null; then
        ip link set "$TAP_NAME" down 2>/dev/null || true
        ip link delete "$TAP_NAME" 2>/dev/null || true
        echo -e "${GREEN}✓ Removed $TAP_NAME${NC}"
        REMOVED_COUNT=$((REMOVED_COUNT + 1))
    fi
done

if [[ $REMOVED_COUNT -gt 0 ]]; then
    echo -e "${GREEN}Removed $REMOVED_COUNT TAP devices${NC}"
else
    echo "No TAP devices found to remove"
fi

# Remove bridge
echo ""
echo -e "${YELLOW}Removing bridge...${NC}"
if ip link show "$BRIDGE_NAME" &> /dev/null; then
    ip link set "$BRIDGE_NAME" down 2>/dev/null || true
    ip link delete "$BRIDGE_NAME" 2>/dev/null || true
    echo -e "${GREEN}✓ Removed bridge $BRIDGE_NAME${NC}"
else
    echo "Bridge $BRIDGE_NAME not found"
fi

# Remove iptables rules
echo ""
echo -e "${YELLOW}Removing iptables rules...${NC}"
DEFAULT_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
if [[ -n "$DEFAULT_IFACE" ]]; then
    # Try to remove the rules (ignore errors if they don't exist)
    iptables -t nat -D POSTROUTING -s "$BRIDGE_SUBNET" -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null && \
        echo -e "${GREEN}✓ Removed NAT rule${NC}" || \
        echo "NAT rule not found (already removed)"
    
    iptables -D FORWARD -i "$BRIDGE_NAME" -o "$DEFAULT_IFACE" -j ACCEPT 2>/dev/null && \
        echo -e "${GREEN}✓ Removed forward rule (bridge -> $DEFAULT_IFACE)${NC}" || true
    
    iptables -D FORWARD -i "$DEFAULT_IFACE" -o "$BRIDGE_NAME" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null && \
        echo -e "${GREEN}✓ Removed forward rule ($DEFAULT_IFACE -> bridge)${NC}" || true
else
    echo -e "${YELLOW}Warning: Could not detect default network interface${NC}"
fi

# Save iptables rules
if command -v iptables-save &> /dev/null; then
    if [[ -d /etc/iptables ]]; then
        iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    fi
    if command -v netfilter-persistent &> /dev/null; then
        netfilter-persistent save 2>/dev/null || true
    fi
fi

# Remove dnsmasq configuration
echo ""
echo -e "${YELLOW}Removing DHCP server configuration...${NC}"
if [[ -f /etc/dnsmasq.d/otus.conf ]]; then
    rm -f /etc/dnsmasq.d/otus.conf
    echo -e "${GREEN}✓ Removed /etc/dnsmasq.d/otus.conf${NC}"
    
    # Restart dnsmasq if it's running
    if systemctl is-active --quiet dnsmasq; then
        systemctl restart dnsmasq
        echo -e "${GREEN}✓ Restarted dnsmasq${NC}"
    fi
else
    echo "DHCP configuration not found"
fi

# Optionally disable IP forwarding
echo ""
echo -e "${YELLOW}IP Forwarding:${NC}"
echo "IP forwarding is currently enabled (required by Otus)."
echo "You can keep it enabled or disable it."
echo ""
read -p "Disable IP forwarding? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    sysctl -w net.ipv4.ip_forward=0 > /dev/null
    rm -f /etc/sysctl.d/99-otus.conf
    echo -e "${GREEN}✓ IP forwarding disabled${NC}"
else
    echo "IP forwarding left enabled"
fi

# Remove configuration file
echo ""
echo -e "${YELLOW}Removing configuration file...${NC}"
if [[ -f /etc/otus-tap-pool.conf ]]; then
    rm -f /etc/otus-tap-pool.conf
    echo -e "${GREEN}✓ Removed /etc/otus-tap-pool.conf${NC}"
fi

echo ""
echo -e "${GREEN}=== Cleanup Complete ===${NC}"
echo ""
echo "All Otus network components have been removed."
echo ""
echo "To set up the network again, run:"
echo "  bun run setup:network"
echo ""
