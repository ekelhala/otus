/**
 * Firecracker Controller
 * Manages VM lifecycle via the Firecracker HTTP API
 */

import { spawn, type Subprocess } from "bun";
import { unlink, copyFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { $ } from "bun";
import { getTapPool, type TapDevice } from "./tap-pool";

/** Track all active temp rootfs files for cleanup on exit */
const activeTempRootfsFiles = new Set<string>();

/**
 * Find firecracker binary
 * Checks PATH first, then falls back to local installation
 */
export async function findFirecrackerBinary(): Promise<string | null> {
  // Check if firecracker is in PATH
  try {
    const result = await $`which firecracker`.quiet();
    if (result.exitCode === 0) {
      const path = result.text().trim();
      if (path) {
        return path;
      }
    }
  } catch {
    // which command failed, continue to local check
  }

  // Check local installation
  const localPath = "./infra/firecracker";
  if (existsSync(localPath)) {
    return localPath;
  }

  return null;
}

/**
 * Clean up orphaned temp rootfs files from previous daemon runs
 * These can accumulate if the daemon crashes or is killed ungracefully
 */
export async function cleanupOrphanedTempRootfs(): Promise<number> {
  const tmp = tmpdir();
  let cleanedCount = 0;

  try {
    const files = await readdir(tmp);
    const orphanedFiles = files.filter((f) => f.startsWith("firecracker-rootfs-") && f.endsWith(".ext4"));

    for (const file of orphanedFiles) {
      const filePath = join(tmp, file);
      // Skip files that are actively tracked by this process
      if (activeTempRootfsFiles.has(filePath)) {
        continue;
      }

      try {
        await unlink(filePath);
        cleanedCount++;
        console.log(`[Firecracker] Cleaned up orphaned temp rootfs: ${file}`);
      } catch (error) {
        // File might be in use by another process, skip
        console.log(`[Firecracker] Could not clean up ${file}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    console.log(`[Firecracker] Error scanning for orphaned temp files: ${error instanceof Error ? error.message : error}`);
  }

  return cleanedCount;
}

/**
 * Clean up all temp rootfs files tracked by this process
 * Call this on graceful shutdown
 */
export async function cleanupAllTempRootfs(): Promise<void> {
  for (const filePath of activeTempRootfsFiles) {
    try {
      if (existsSync(filePath)) {
        await unlink(filePath);
        console.log(`[Firecracker] Cleaned up temp rootfs: ${filePath}`);
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  }
  activeTempRootfsFiles.clear();
}

export interface FirecrackerConfig {
  /** Path to Firecracker binary */
  binaryPath?: string;
  /** Path to kernel image */
  kernelPath: string;
  /** Path to rootfs image */
  rootfsPath: string;
  /** Unix socket for Firecracker API */
  apiSocket: string;
  /** Unix socket for VSock proxy */
  vsockSocket: string;
  /** Guest CID for VSock */
  guestCid?: number;
  /** VM resources */
  vcpuCount?: number;
  memSizeMib?: number;
  /** Boot arguments */
  bootArgs?: string;
  /** Enable network (allocates TAP device) */
  enableNetwork?: boolean;
}

export interface VMState {
  state: "Not started" | "Running" | "Paused";
}

/**
 * Firecracker VM Controller
 */
export class FirecrackerVM {
  private process: Subprocess | null = null;
  private readonly config: Required<FirecrackerConfig>;
  private tapDevice: TapDevice | null = null;
  private tempRootfsPath: string | null = null;

  constructor(config: FirecrackerConfig) {
    this.config = {
      binaryPath: "./infra/firecracker",
      guestCid: 3,
      vcpuCount: 2,
      memSizeMib: 512,
      bootArgs: "console=ttyS0 reboot=k panic=1 pci=off quiet",
      enableNetwork: true,
      ...config,
    };
  }

  /**
   * Verify firecracker binary exists
   */
  private verifyBinary(): void {
    if (!existsSync(this.config.binaryPath)) {
      throw new Error(
        `Firecracker binary not found at ${this.config.binaryPath}.\n\n` +
        `Please run one of the following:\n` +
        `  1. Install system-wide: sudo apt install firecracker (Ubuntu/Debian)\n` +
        `  2. Install locally: ./infra/setup-firecracker.sh\n` +
        `  3. Download from: https://github.com/firecracker-microvm/firecracker/releases`
      );
    }
  }

  /**
   * Start the Firecracker VM
   */
  async boot(): Promise<void> {
    // Verify binary exists
    this.verifyBinary();

    // Allocate TAP device if network is enabled
    if (this.config.enableNetwork) {
      const tapPool = await getTapPool();
      
      // Verify TAP pool setup
      const verifyError = await tapPool.verify();
      if (verifyError) {
        throw new Error(
          `TAP pool not set up correctly: ${verifyError}\n\n` +
          `Please run: sudo ./infra/setup-tap-pool.sh`
        );
      }
      
      this.tapDevice = await tapPool.allocate();
      if (!this.tapDevice) {
        throw new Error(
          "No TAP devices available. All devices in the pool are in use."
        );
      }
      console.log(
        `[Firecracker] Allocated network: ${this.tapDevice.name} (${this.tapDevice.guestIp})`
      );
    }

    // Clean up any existing sockets
    await this.cleanupSockets();

    // Copy rootfs to temp file to avoid persisting changes
    this.tempRootfsPath = join(tmpdir(), `firecracker-rootfs-${Date.now()}-${process.pid}.ext4`);
    await copyFile(this.config.rootfsPath, this.tempRootfsPath);
    activeTempRootfsFiles.add(this.tempRootfsPath);
    console.log(`[Firecracker] Using temp rootfs: ${this.tempRootfsPath}`);

    // Start Firecracker process
    console.log("[Firecracker] Starting VM...");
    
    this.process = spawn({
      cmd: [
        this.config.binaryPath,
        "--api-sock",
        this.config.apiSocket,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for API socket to be ready
    await this.waitForSocket(this.config.apiSocket);
    console.log("[Firecracker] API socket ready");

    // Configure the VM
    await this.configureMachine();
    await this.configureBootSource();
    await this.configureBlockDevice();
    await this.configureVsock();
    
    // Configure network if enabled
    if (this.config.enableNetwork && this.tapDevice) {
      await this.configureNetwork();
    }

    // Start the VM
    await this.apiRequest("PUT", "/actions", {
      action_type: "InstanceStart",
    });

    console.log("[Firecracker] VM booted successfully");
  }

  /**
   * Configure machine resources
   */
  private async configureMachine(): Promise<void> {
    await this.apiRequest("PUT", "/machine-config", {
      vcpu_count: this.config.vcpuCount,
      mem_size_mib: this.config.memSizeMib,
      smt: false,
      track_dirty_pages: true,
    });
  }

  /**
   * Configure boot source (kernel)
   */
  private async configureBootSource(): Promise<void> {
    await this.apiRequest("PUT", "/boot-source", {
      kernel_image_path: this.config.kernelPath,
      boot_args: this.config.bootArgs,
    });
  }

  /**
   * Configure block device (rootfs)
   */
  private async configureBlockDevice(): Promise<void> {
    await this.apiRequest("PUT", "/drives/rootfs", {
      drive_id: "rootfs",
      path_on_host: this.tempRootfsPath ?? this.config.rootfsPath,
      is_root_device: true,
      is_read_only: false,
    });
  }

  /**
   * Configure VSock device
   */
  private async configureVsock(): Promise<void> {
    await this.apiRequest("PUT", "/vsock", {
      guest_cid: this.config.guestCid,
      uds_path: this.config.vsockSocket,
    });
  }

  /**
   * Configure network interface (TAP device)
   */
  private async configureNetwork(): Promise<void> {
    if (!this.tapDevice) {
      throw new Error("No TAP device allocated");
    }

    await this.apiRequest("PUT", "/network-interfaces/eth0", {
      iface_id: "eth0",
      host_dev_name: this.tapDevice.name,
      guest_mac: this.tapDevice.macAddress,
    });

    console.log(
      `[Firecracker] Network configured: ${this.tapDevice.name} -> ${this.tapDevice.macAddress}`
    );
  }

  /**
   * Pause the VM
   */
  async pause(): Promise<void> {
    await this.apiRequest("PATCH", "/vm", {
      state: "Paused",
    });
    console.log("[Firecracker] VM paused");
  }

  /**
   * Resume the VM
   */
  async resume(): Promise<void> {
    await this.apiRequest("PATCH", "/vm", {
      state: "Resumed",
    });
    console.log("[Firecracker] VM resumed");
  }

  /**
   * Create a snapshot of the VM
   */
  async snapshot(snapshotPath: string, memPath: string): Promise<void> {
    await this.pause();
    
    await this.apiRequest("PUT", "/snapshot/create", {
      snapshot_type: "Full",
      snapshot_path: snapshotPath,
      mem_file_path: memPath,
    });

    console.log("[Firecracker] Snapshot created");
    await this.resume();
  }

  /**
   * Load a snapshot
   */
  async loadSnapshot(snapshotPath: string, memPath: string): Promise<void> {
    await this.apiRequest("PUT", "/snapshot/load", {
      snapshot_path: snapshotPath,
      mem_backend: {
        backend_path: memPath,
        backend_type: "File",
      },
    });

    console.log("[Firecracker] Snapshot loaded");
  }

  /**
   * Get VM state
   */
  async getState(): Promise<VMState> {
    const response = await this.apiRequest("GET", "/vm");
    return response as VMState;
  }

  /**
   * Shutdown and destroy the VM
   */
  async destroy(): Promise<void> {
    if (this.process && !this.process.killed) {
      console.log("[Firecracker] Shutting down VM...");
      
      // Send shutdown action
      try {
        await this.apiRequest("PUT", "/actions", {
          action_type: "SendCtrlAltDel",
        });
        
        // Wait a bit for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        // If API call fails, VM might already be down
      }

      // Force kill if still running
      if (!this.process.killed) {
        this.process.kill();
      }

      this.process = null;
    }

    // Release TAP device back to pool
    if (this.tapDevice) {
      const tapPool = await getTapPool();
      await tapPool.release(this.tapDevice.name);
      this.tapDevice = null;
    }

    await this.cleanupSockets();

    // Clean up temp rootfs copy
    if (this.tempRootfsPath) {
      try {
        await unlink(this.tempRootfsPath);
        activeTempRootfsFiles.delete(this.tempRootfsPath);
        console.log(`[Firecracker] Cleaned up temp rootfs: ${this.tempRootfsPath}`);
      } catch {
        // Ignore if already deleted
        activeTempRootfsFiles.delete(this.tempRootfsPath);
      }
      this.tempRootfsPath = null;
    }

    console.log("[Firecracker] VM destroyed");
  }

  /**
   * Make an API request to Firecracker
   */
  private async apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<any> {
    const socketPath = this.config.apiSocket;

    try {
      const response = await fetch(`http://localhost${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        // Use Unix socket transport
        // @ts-ignore - Bun supports this but TypeScript doesn't know
        unix: socketPath,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Firecracker API error: ${error}`);
      }

      // Some requests don't return a body
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0" || !contentLength) {
        return null;
      }

      return await response.json();
    } catch (error) {
      throw new Error(
        `Firecracker API request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Wait for a Unix socket to be ready
   */
  private async waitForSocket(
    socketPath: string,
    timeout = 5000
  ): Promise<void> {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      if (existsSync(socketPath)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for socket: ${socketPath}`);
  }

  /**
   * Clean up socket files
   */
  private async cleanupSockets(): Promise<void> {
    try {
      if (existsSync(this.config.apiSocket)) {
        await unlink(this.config.apiSocket);
      }
      if (existsSync(this.config.vsockSocket)) {
        await unlink(this.config.vsockSocket);
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  }

  /**
   * Check if VM is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Get the allocated TAP device info
   */
  getTapDevice(): TapDevice | null {
    return this.tapDevice;
  }

  /**
   * Get the guest IP address (if network is enabled)
   */
  getGuestIp(): string | null {
    return this.tapDevice?.guestIp ?? null;
  }
}
