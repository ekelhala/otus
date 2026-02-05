#!/bin/bash
# Check TAP Device Pool Status
# Shows the current state of the TAP device pool

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Otus TAP Device Pool Status ===${NC}"
echo ""

# Load configuration
if [[ -f /etc/otus-tap-pool.conf ]]; then
    source /etc/otus-tap-pool.conf
else
    echo -e "${YELLOW}Warning: /etc/otus-tap-pool.conf not found${NC}"
    echo "Using default values"
    BRIDGE_NAME="otus-br0"
    TAP_PREFIX="otus-tap"
    TAP_COUNT=10
fi

# Check bridge status
echo -e "${BLUE}Bridge Status:${NC}"
if ip link show "$BRIDGE_NAME" &> /dev/null; then
    echo -e "${GREEN}✓ Bridge $BRIDGE_NAME exists${NC}"
    
    # Show bridge details
    BRIDGE_STATE=$(ip link show "$BRIDGE_NAME" | grep -oP 'state \K\w+')
    BRIDGE_IP=$(ip addr show "$BRIDGE_NAME" | grep 'inet ' | awk '{print $2}' | head -1)
    
    echo "  State: $BRIDGE_STATE"
    echo "  IP: ${BRIDGE_IP:-not configured}"
else
    echo -e "${RED}✗ Bridge $BRIDGE_NAME not found${NC}"
    echo ""
    echo "Run: sudo ./infra/setup-tap-pool.sh"
    exit 1
fi

echo ""
echo -e "${BLUE}TAP Devices:${NC}"

# Check each TAP device
ACTIVE_COUNT=0
TOTAL_COUNT=0

for i in $(seq 0 $((TAP_COUNT - 1))); do
    TAP_NAME="${TAP_PREFIX}${i}"
    TOTAL_COUNT=$((TOTAL_COUNT + 1))
    
    if ip link show "$TAP_NAME" &> /dev/null; then
        STATE=$(ip link show "$TAP_NAME" | grep -oP 'state \K\w+')
        
        # Check if attached to bridge
        MASTER=$(ip link show "$TAP_NAME" | grep -oP 'master \K\w+' || echo "none")
        
        if [[ "$STATE" == "UP" ]] || [[ "$STATE" == "UNKNOWN" ]]; then
            ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
            echo -e "  ${GREEN}✓${NC} $TAP_NAME - $STATE (master: $MASTER)"
        else
            echo -e "  ${YELLOW}○${NC} $TAP_NAME - $STATE (master: $MASTER)"
        fi
    else
        echo -e "  ${RED}✗${NC} $TAP_NAME - not found"
    fi
done

echo ""
echo -e "${BLUE}Summary:${NC}"
echo "  Total TAP devices: $TOTAL_COUNT"
echo "  Active: $ACTIVE_COUNT"
echo "  Available: $ACTIVE_COUNT (assuming none in use)"

# Check IP forwarding
echo ""
echo -e "${BLUE}Network Configuration:${NC}"

IP_FORWARD=$(cat /proc/sys/net/ipv4/ip_forward)
if [[ "$IP_FORWARD" == "1" ]]; then
    echo -e "  ${GREEN}✓${NC} IP forwarding enabled"
else
    echo -e "  ${RED}✗${NC} IP forwarding disabled"
fi

# Check NAT rules
DEFAULT_IFACE=$(ip route | grep default | awk '{print $5}' | head -1)
if [[ -n "$DEFAULT_IFACE" ]]; then
    echo "  Default interface: $DEFAULT_IFACE"
    
    if sudo iptables -t nat -L POSTROUTING -n | grep -q "MASQUERADE.*172.20.0.0/24"; then
        echo -e "  ${GREEN}✓${NC} NAT rule configured"
    else
        echo -e "  ${YELLOW}⚠${NC} NAT rule not found"
    fi
fi

echo ""
echo -e "${BLUE}To test network from VM:${NC}"
echo "  1. Boot a VM with enableNetwork: true"
echo "  2. In VM: ping 8.8.8.8"
echo "  3. In VM: curl http://example.com"
echo ""
