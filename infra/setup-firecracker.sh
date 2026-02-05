#!/bin/bash
# Setup Firecracker on Linux
# Downloads and installs Firecracker binary

set -euo pipefail

FIRECRACKER_VERSION="${FIRECRACKER_VERSION:-v1.11.1}"
INSTALL_DIR="./infra"

echo "==> Setting up Firecracker ${FIRECRACKER_VERSION}"

# Check if running on Linux
if [[ "$(uname)" != "Linux" ]]; then
    echo "Error: Firecracker only runs on Linux"
    exit 1
fi

# Check if firecracker is already available
if command -v firecracker &> /dev/null; then
    EXISTING_VERSION=$(firecracker --version | head -n1 || echo "unknown")
    echo "✓ Found firecracker in PATH: $EXISTING_VERSION"
    echo ""
    read -p "Use existing firecracker (Y) or install locally to ./infra/firecracker (n)? [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
        echo "✓ Using system firecracker from PATH"
        echo ""
        echo "Next steps:"
        echo "  1. Run ./infra/build-kernel.sh to get a Linux kernel"
        echo "  2. Run ./infra/build-rootfs.sh to create the guest filesystem"
        exit 0
    fi
fi

# Check if already installed locally
if [[ -f "${INSTALL_DIR}/firecracker" ]]; then
    LOCAL_VERSION=$("${INSTALL_DIR}/firecracker" --version | head -n1 || echo "unknown")
    echo "✓ Found local firecracker: $LOCAL_VERSION"
    echo ""
    read -p "Reinstall firecracker ${FIRECRACKER_VERSION}? [y/N] " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "✓ Using existing local installation"
        echo ""
        echo "Next steps:"
        echo "  1. Run ./infra/build-kernel.sh to get a Linux kernel"
        echo "  2. Run ./infra/build-rootfs.sh to create the guest filesystem"
        exit 0
    fi
fi

# Check KVM access
if [[ ! -r /dev/kvm ]] || [[ ! -w /dev/kvm ]]; then
    echo "Error: No access to /dev/kvm"
    echo "Run: sudo usermod -aG kvm \${USER}"
    echo "Then log out and log back in"
    exit 1
fi

echo "✓ KVM access verified"

# Create install directory
mkdir -p "$INSTALL_DIR"

# Download Firecracker binary
ARCH="$(uname -m)"
RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${ARCH}.tgz"

echo "==> Downloading Firecracker from ${RELEASE_URL}"
curl -L "$RELEASE_URL" -o "${INSTALL_DIR}/firecracker.tgz"

echo "==> Extracting Firecracker"
tar -xzf "${INSTALL_DIR}/firecracker.tgz" -C "${INSTALL_DIR}" "release-${FIRECRACKER_VERSION}-${ARCH}/firecracker-${FIRECRACKER_VERSION}-${ARCH}"

# Move binary and make executable
mv "${INSTALL_DIR}/release-${FIRECRACKER_VERSION}-${ARCH}/firecracker-${FIRECRACKER_VERSION}-${ARCH}" "${INSTALL_DIR}/firecracker"
chmod +x "${INSTALL_DIR}/firecracker"

# Cleanup
rm -rf "${INSTALL_DIR}/firecracker.tgz" "${INSTALL_DIR}/release-${FIRECRACKER_VERSION}-${ARCH}"

echo "✓ Firecracker installed to ${INSTALL_DIR}/firecracker"

# Verify installation
"${INSTALL_DIR}/firecracker" --version

echo ""
echo "==> Setup complete!"
echo "Next steps:"
echo "  1. Run ./infra/build-kernel.sh to get a Linux kernel"
echo "  2. Run ./infra/build-rootfs.sh to create the guest filesystem"
