#!/bin/bash
# Download a Linux kernel for Firecracker
# Uses the recommended approach from https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md

set -euo pipefail

INSTALL_DIR="./infra"

echo "==> Setting up Linux kernel for Firecracker"

# Create install directory
mkdir -p "$INSTALL_DIR"

# Architecture
ARCH="$(uname -m)"

# Check if kernel already exists and is valid
if [[ -f "${INSTALL_DIR}/vmlinux.bin" ]]; then
    if file "${INSTALL_DIR}/vmlinux.bin" | grep -q "ELF.*executable"; then
        SIZE=$(stat -c%s "${INSTALL_DIR}/vmlinux.bin" 2>/dev/null || stat -f%z "${INSTALL_DIR}/vmlinux.bin" 2>/dev/null)
        if [[ $SIZE -gt 1000000 ]]; then  # At least 1MB
            echo "✓ Valid kernel already exists at ${INSTALL_DIR}/vmlinux.bin"
            file "${INSTALL_DIR}/vmlinux.bin"
            ls -lh "${INSTALL_DIR}/vmlinux.bin"
            exit 0
        fi
    fi
    echo "Existing kernel is invalid, removing..."
    rm -f "${INSTALL_DIR}/vmlinux.bin"
fi

echo "==> Finding latest Firecracker CI kernel..."

# Get the latest Firecracker release version
release_url="https://github.com/firecracker-microvm/firecracker/releases"
echo "Checking latest Firecracker release..."
latest_version=$(basename $(curl -fsSLI -o /dev/null -w %{url_effective} ${release_url}/latest))
CI_VERSION=${latest_version%.*}  # Remove patch version for CI path

echo "Latest version: ${latest_version}"
echo "CI version: ${CI_VERSION}"

# Query S3 bucket for available kernels
echo "Querying S3 for available kernels..."
latest_kernel_key=$(curl -s "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/$CI_VERSION/$ARCH/vmlinux-&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/$CI_VERSION/$ARCH/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)

if [[ -z "$latest_kernel_key" ]]; then
    echo "✗ Failed to find kernel in CI artifacts"
    echo ""
    echo "This can happen if:"
    echo "  1. The S3 bucket structure has changed"
    echo "  2. No kernels are available for version ${CI_VERSION}"
    echo ""
    echo "Trying fallback method with direct release artifacts..."
    
    # Fallback: try direct release artifacts
    KERNEL_URL="${release_url}/download/${latest_version}/vmlinux-6.1"
    echo "Trying: ${KERNEL_URL}"
    
    if curl -L --fail -o "${INSTALL_DIR}/vmlinux.bin" "${KERNEL_URL}"; then
        if file "${INSTALL_DIR}/vmlinux.bin" | grep -q "ELF.*executable"; then
            echo "✓ Downloaded kernel from release artifacts"
            chmod +x "${INSTALL_DIR}/vmlinux.bin"
            file "${INSTALL_DIR}/vmlinux.bin"
            ls -lh "${INSTALL_DIR}/vmlinux.bin"
            exit 0
        fi
    fi
    
    echo ""
    echo "✗ All download methods failed"
    echo ""
    echo "Manual options:"
    echo "  1. Download from: https://github.com/firecracker-microvm/firecracker/releases"
    echo "  2. Place kernel at: ${INSTALL_DIR}/vmlinux.bin"
    exit 1
fi

echo "Found kernel: ${latest_kernel_key}"

# Download the kernel
KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}"
echo "Downloading from: ${KERNEL_URL}"

curl -fsSL -o "${INSTALL_DIR}/vmlinux.bin" "${KERNEL_URL}"

# Verify download
if ! file "${INSTALL_DIR}/vmlinux.bin" | grep -q "ELF.*executable"; then
    echo "✗ Downloaded file is not a valid ELF kernel"
    rm -f "${INSTALL_DIR}/vmlinux.bin"
    exit 1
fi

SIZE=$(stat -c%s "${INSTALL_DIR}/vmlinux.bin" 2>/dev/null || stat -f%z "${INSTALL_DIR}/vmlinux.bin" 2>/dev/null)
if [[ $SIZE -lt 1000000 ]]; then
    echo "✗ Downloaded kernel is too small (${SIZE} bytes)"
    rm -f "${INSTALL_DIR}/vmlinux.bin"
    exit 1
fi

chmod +x "${INSTALL_DIR}/vmlinux.bin"

echo "✓ Kernel installed to ${INSTALL_DIR}/vmlinux.bin"

# Show kernel info
file "${INSTALL_DIR}/vmlinux.bin"
ls -lh "${INSTALL_DIR}/vmlinux.bin"

echo ""
echo "==> Kernel setup complete!"
echo "Next step: Run ./infra/build-rootfs.sh to create the guest filesystem"

chmod +x "${INSTALL_DIR}/vmlinux.bin"

echo "✓ Kernel installed to ${INSTALL_DIR}/vmlinux.bin"

# Show kernel info
file "${INSTALL_DIR}/vmlinux.bin"
ls -lh "${INSTALL_DIR}/vmlinux.bin"

echo ""
echo "==> Kernel setup complete!"
echo "Next step: Run ./infra/build-rootfs.sh to create the guest filesystem"
