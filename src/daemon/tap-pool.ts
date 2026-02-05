/**
 * TAP Device Pool Manager
 * Manages a pool of TAP network devices for Firecracker VMs
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";

export interface TapDevice {
  /** TAP device name (e.g., otus-tap0) */
  name: string;
  /** Index in the pool */
  index: number;
  /** MAC address for the guest */
  macAddress: string;
  /** IP address for the guest */
  guestIp: string;
  /** Whether this device is currently in use */
  inUse: boolean;
}

export interface TapPoolConfig {
  /** Bridge name */
  bridgeName: string;
  /** TAP device prefix */
  tapPrefix: string;
  /** Number of TAP devices in the pool */
  tapCount: number;
  /** Bridge IP address */
  bridgeIp: string;
  /** Bridge subnet */
  bridgeSubnet: string;
  /** Starting IP for guests */
  guestIpStart: number;
}

/**
 * TAP Device Pool Manager
 * Thread-safe pool of TAP devices for VM networking
 */
export class TapPool {
  private devices: TapDevice[] = [];
  private config: TapPoolConfig;
  private allocated = new Set<string>();

  constructor(config?: Partial<TapPoolConfig>) {
    this.config = {
      bridgeName: "otus-br0",
      tapPrefix: "otus-tap",
      tapCount: 10,
      bridgeIp: "172.20.0.1",
      bridgeSubnet: "172.20.0.0/24",
      guestIpStart: 2,
      ...config,
    };
  }

  /**
   * Initialize the TAP pool
   * Loads configuration and prepares device list
   */
  async initialize(): Promise<void> {
    // Try to load config from system file
    const configPath = "/etc/otus-tap-pool.conf";
    if (existsSync(configPath)) {
      try {
        const configContent = await readFile(configPath, "utf-8");
        const parsedConfig = this.parseConfig(configContent);
        this.config = { ...this.config, ...parsedConfig };
      } catch (error) {
        console.warn(
          `[TapPool] Warning: Could not load config from ${configPath}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Initialize device list
    this.devices = [];
    for (let i = 0; i < this.config.tapCount; i++) {
      this.devices.push({
        name: `${this.config.tapPrefix}${i}`,
        index: i,
        macAddress: this.generateMacAddress(i),
        guestIp: `172.20.0.${this.config.guestIpStart + i}`,
        inUse: false,
      });
    }

    console.log(
      `[TapPool] Initialized with ${this.devices.length} TAP devices`
    );
  }

  /**
   * Parse configuration file
   */
  private parseConfig(content: string): Partial<TapPoolConfig> {
    const config: Partial<TapPoolConfig> = {};
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const [key, value] = trimmed.split("=").map((s) => s.trim());
      if (!key || !value) continue;

      switch (key) {
        case "BRIDGE_NAME":
          config.bridgeName = value;
          break;
        case "TAP_PREFIX":
          config.tapPrefix = value;
          break;
        case "TAP_COUNT":
          config.tapCount = parseInt(value, 10);
          break;
        case "BRIDGE_IP":
          config.bridgeIp = value;
          break;
        case "BRIDGE_SUBNET":
          config.bridgeSubnet = value;
          break;
        case "GUEST_IP_START":
          config.guestIpStart = parseInt(value, 10);
          break;
      }
    }

    return config;
  }

  /**
   * Generate a unique MAC address for a TAP device
   */
  private generateMacAddress(index: number): string {
    // Use locally administered unicast MAC address
    // First byte: 0x06 (00000110) - locally administered, unicast
    const bytes = [
      0x06,
      0x00,
      0x00,
      0x00,
      (index >> 8) & 0xff,
      index & 0xff,
    ];
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
  }

  /**
   * Allocate a TAP device from the pool
   * Returns null if no devices are available
   */
  async allocate(): Promise<TapDevice | null> {
    // Find first available device
    for (const device of this.devices) {
      if (!device.inUse && !this.allocated.has(device.name)) {
        device.inUse = true;
        this.allocated.add(device.name);
        console.log(`[TapPool] Allocated ${device.name} (${device.guestIp})`);
        return device;
      }
    }

    console.warn("[TapPool] No TAP devices available");
    return null;
  }

  /**
   * Release a TAP device back to the pool
   */
  async release(deviceName: string): Promise<void> {
    const device = this.devices.find((d) => d.name === deviceName);
    if (device) {
      device.inUse = false;
      this.allocated.delete(deviceName);
      console.log(`[TapPool] Released ${deviceName}`);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    total: number;
    available: number;
    inUse: number;
  } {
    const inUse = this.devices.filter((d) => d.inUse).length;
    return {
      total: this.devices.length,
      available: this.devices.length - inUse,
      inUse,
    };
  }

  /**
   * Get all devices in the pool
   */
  getDevices(): ReadonlyArray<Readonly<TapDevice>> {
    return this.devices;
  }

  /**
   * Get gateway IP (bridge IP)
   */
  getGatewayIp(): string {
    return this.config.bridgeIp;
  }

  /**
   * Get bridge name
   */
  getBridgeName(): string {
    return this.config.bridgeName;
  }

  /**
   * Verify TAP pool is set up correctly
   * Returns error message if setup is invalid, null if OK
   */
  async verify(): Promise<string | null> {
    const { existsSync } = await import("fs");
    const { $ } = await import("bun");

    // Check if bridge exists
    try {
      const result = await $`ip link show ${this.config.bridgeName}`.quiet();
      if (result.exitCode !== 0) {
        return `Bridge ${this.config.bridgeName} not found. Run: sudo ./infra/setup-tap-pool.sh`;
      }
    } catch (error) {
      return `Could not verify bridge. Is 'ip' command available?`;
    }

    // Check if at least one TAP device exists
    try {
      const tapName = `${this.config.tapPrefix}0`;
      const result = await $`ip link show ${tapName}`.quiet();
      if (result.exitCode !== 0) {
        return `TAP device ${tapName} not found. Run: sudo ./infra/setup-tap-pool.sh`;
      }
    } catch (error) {
      return `Could not verify TAP devices.`;
    }

    return null; // All checks passed
  }
}

/**
 * Global TAP pool instance
 */
let globalTapPool: TapPool | null = null;

/**
 * Get or create the global TAP pool instance
 */
export async function getTapPool(): Promise<TapPool> {
  if (!globalTapPool) {
    globalTapPool = new TapPool();
    await globalTapPool.initialize();
  }
  return globalTapPool;
}
