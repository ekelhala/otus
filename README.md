# Otus

An autonomous, local-first system engineering agent.

Otus uses a "Smart Host, Dumb Guest" architecture: all AI reasoning happens on your machine, while execution is isolated in Firecracker microVMs for safety.

## Architecture

- **Host Daemon ("The Den")**: Coordinates LLM inference (Claude), memory (SQLite + LanceDB), and task management
- **Guest Agent ("The Cage")**: Stateless executor running in a Firecracker VM, receives commands via VSock
- **Memory Systems**: 
  - Episodic (SQLite): Task history and command logs
  - Semantic (LanceDB): Vectorized codebase for RAG

## Prerequisites

1. **Linux** (Firecracker requires KVM)
2. **Bun** 1.3+
3. **KVM access**: `sudo usermod -aG kvm $USER` (then log out/in)
4. **debootstrap**: `sudo apt install debootstrap`
5. **API Keys**:
   - `ANTHROPIC_API_KEY`: Claude API key
   - `VOYAGE_API_KEY`: Voyage AI embeddings key

## Setup

### 1. Install dependencies
```bash
bun install
```

### 2. Build the guest agent
```bash
bun run build:agent
```

### 3. Setup Firecracker infrastructure

**First, check if everything is already available:**
```bash
bun run dev check
```

This will tell you what's missing. If you need to set up infrastructure:

```bash
# Download Firecracker binary (or use system firecracker if available)
./infra/setup-firecracker.sh

# Get Linux kernel
./infra/build-kernel.sh

# Build rootfs with guest agent (requires sudo)
./infra/build-rootfs.sh

# Setup network (TAP device pool)
bun run setup:network

# Verify setup
bun run dev check
```

This creates:
- `infra/firecracker`: Firecracker binary (or uses system firecracker)
- `infra/vmlinux.bin`: Linux kernel
- `infra/rootfs.ext4`: Ubuntu rootfs with the Otus agent
- Network bridge and TAP devices for VM connectivity

### 4. Set API keys
```bash
export ANTHROPIC_API_KEY="your-key"
export VOYAGE_API_KEY="your-key"
```

## Usage

### Check prerequisites
```bash
bun run dev check
```

Verifies that Firecracker, kernel, and rootfs are all set up correctly. Run this before initializing if you're unsure about your setup.

### Initialize a workspace
```bash
cd /path/to/your/project
bun run dev init
```

This creates `.otus/` with:
- SQLite database for episodic memory
- LanceDB vector index of your codebase
- Configuration

### Run a task
```bash
bun run dev do "create a hello world python script"
```

Otus will:
1. Check prerequisites
2. Index your codebase
3. Boot a Firecracker VM
4. Run a ReAct loop with Claude
5. Execute commands in the VM
6. Write results back to your workspace

### Check status
```bash
bun run dev status
```

## Project Structure

```
src/
  agent/          # Guest VM agent (compiled to standalone binary)
  daemon/         # Host orchestrator
    memory/       # SQLite + LanceDB
    firecracker.ts
    vsock.ts
    inference.ts  # Claude ReAct loop
    index.ts      # Main daemon
  shared/         # Types shared between host and guest
  cli/            # CLI entry point
infra/            # Infrastructure setup scripts
doc/              # Design documentation
```

## Development

```bash
# Build everything
bun run build
bun run build:agent

# Run without full build
bun run dev init
bun run dev do "your task"

# Check for errors
bun run typecheck  # (if added to package.json)
```

## How It Works

1. **Initialize**: Otus indexes your codebase using Voyage embeddings stored in LanceDB
2. **Boot VM**: Firecracker launches a microVM with the guest agent listening on VSock
3. **ReAct Loop**: Claude analyzes the task, searches code, and executes commands iteratively
4. **Memory**: All events are logged to SQLite; reflections are saved after completion
5. **File Sync**: VM accesses workspace via 9p virtio filesystem (to be implemented)
6. **Cleanup**: VM is destroyed; all reasoning/memory persists on host

## Current Limitations (MVP)

- No 9p filesystem support yet (planned)
- Guest agent uses HTTP instead of raw VSock (works for testing)
- No reality branching/snapshots yet
- Single VM at a time

## Security

- API keys never enter the VM
- VM network access is isolated via bridge/NAT (can be disabled)
- Hardware-level isolation via KVM
- All commands logged to SQLite

## Network Configuration

Otus VMs can access the internet through a TAP device pool. Each VM gets its own TAP device attached to a bridge.

### Network Setup

```bash
# Setup TAP device pool (creates 10 TAP devices by default)
bun run setup:network
```

This creates:
- Bridge device `otus-br0` at `172.20.0.1`
- TAP devices `otus-tap0` through `otus-tap9`
- NAT rules for internet access
- IP forwarding configuration
- DHCP server (dnsmasq) for automatic guest IP assignment

### Verify Network Setup

```bash
bun run check:network
```

This shows the status of the bridge, TAP devices, and network configuration.

### Network Details

- **Subnet**: `172.20.0.0/24`
- **Gateway**: `172.20.0.1` (bridge)
- **Guest IPs**: `172.20.0.2` - `172.20.0.11`
- **Pool Size**: 10 concurrent VMs

### Disable Network

To run VMs without network access, modify the Firecracker configuration:

```typescript
const vm = new FirecrackerVM({
  // ... other config
  enableNetwork: false,
});
```

### Cleanup Network

To remove all TAP devices, bridge, and network configuration:

```bash
bun run remove:network
```

This will:
- Remove all TAP devices
- Remove the bridge
- Remove iptables rules
- Remove DHCP configuration
- Optionally disable IP forwarding

## License

[To be determined]
