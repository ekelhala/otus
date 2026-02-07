/**
 * VM Pool
 * Manages a pool of pre-warmed VMs that can be used by any workspace
 */

import { FirecrackerVM, findFirecrackerBinary } from "./firecracker.ts";
import { GuestAgentClient } from "./vsock.ts";
import { VSOCK, resolveVMAssets, getVMAssetInstructions, SYSTEM_PATHS } from "@shared/constants.ts";
import { initLogger } from "../shared/logger";

const logger = initLogger(false);

export interface PoolVM {
  id: string;
  vm: FirecrackerVM;
  agentClient: GuestAgentClient;
  sockets: {
    api: string;
    vsock: string;
  };
  cid: number;
  guestIp: string | null;
  createdAt: Date;
}

/**
 * Global VM Pool
 */
export class VMPool {
  private availableVMs: PoolVM[] = [];
  private nextCid = 3; // Starting CID for VSock
  private poolSize = 1; // Number of VMs to keep ready
  private isWarming = false;
  private hasLoggedPrereqError = false;

  /**
   * Start warming the pool
   */
  async startWarming(): Promise<void> {
    if (this.isWarming) {
      return;
    }

    this.isWarming = true;
    logger.debug(`Starting VM pool warming (target: ${this.poolSize} VMs)...`);

    // Warm VMs in background
    this.warmPool().catch((error) => {
      logger.debug(`VM pool warming failed: ${error instanceof Error ? error.message : error}`);
      // Ensure callers can retry warming later
      this.isWarming = false;
    });
  }

  /**
   * Warm the pool to target size
   */
  private async warmPool(): Promise<void> {
    try {
      while (this.availableVMs.length < this.poolSize) {
        try {
          const vm = await this.createPoolVM();
          this.availableVMs.push(vm);
          logger.debug(`Pool VM ${vm.id} ready (${this.availableVMs.length}/${this.poolSize})`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.debug(`Failed to create pool VM: ${message}`);

          // If we're missing prerequisites (e.g. TAP pool not set up), log a clear error once
          // and pause warming to avoid spamming "VM destroyed" on retry.
          if (this.isPrerequisiteFailure(message)) {
            if (!this.hasLoggedPrereqError) {
              this.hasLoggedPrereqError = true;
              logger.error(
                `VM pool warming paused: ${message}\n` +
                  `Fix the prerequisite and then restart the daemon (or rerun the command that starts it).`
              );
            }
            return;
          }

          // Wait before retrying transient failures
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    } finally {
      // Allow future warm attempts (e.g. after prerequisite is fixed)
      this.isWarming = false;
    }
  }

  /**
   * Detect failures that require user action (as opposed to transient boot/connect issues).
   */
  private isPrerequisiteFailure(message: string): boolean {
    const m = message.toLowerCase();

    // TAP pool / networking not set up
    if (m.includes("tap pool") && m.includes("not set up")) return true;
    if (m.includes("bridge") && m.includes("not found") && m.includes("setup-tap-pool")) return true;
    if (m.includes("tap device") && m.includes("not found") && m.includes("setup-tap-pool")) return true;
    if (m.includes("setup-tap-pool.sh")) return true;

    // Missing VM assets
    if (m.includes("vm assets not found")) return true;

    // Missing firecracker binary
    if (m.includes("firecracker binary not found")) return true;

    return false;
  }

  /**
   * Create a single pool VM
   */
  private async createPoolVM(): Promise<PoolVM> {
    const id = `pool-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const cid = this.nextCid++;

    // Find firecracker binary
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) {
      throw new Error("Firecracker binary not found. Please run: ./infra/setup-firecracker.sh");
    }

    // Resolve VM assets
    const vmAssets = resolveVMAssets();
    if (!vmAssets) {
      throw new Error(getVMAssetInstructions());
    }

    // Create unique socket paths
    const sockets = {
      api: `/tmp/firecracker-${id}.socket`,
      vsock: `/tmp/firecracker-${id}-vsock.socket`,
    };

    logger.debug(`Creating pool VM ${id} (CID ${cid})...`);

    // Create VM instance
    const vm = new FirecrackerVM({
      binaryPath,
      kernelPath: vmAssets.kernelPath,
      rootfsPath: vmAssets.rootfsPath,
      apiSocket: sockets.api,
      vsockSocket: sockets.vsock,
      guestCid: cid,
      enableNetwork: true,
    });

    try {
      // Boot the VM
      await vm.boot();

      // Wait for VM to initialize
      logger.debug(`Pool VM ${id}: waiting for initialization...`);
      await new Promise((resolve) => setTimeout(resolve, 8000));

      // Connect to guest agent
      logger.debug(`Pool VM ${id}: connecting to agent...`);
      const agentClient = new GuestAgentClient(sockets.vsock, cid, VSOCK.AGENT_PORT);

      let connected = false;
      for (let attempts = 0; attempts < 10; attempts++) {
        try {
          await agentClient.connect();
          await agentClient.health();
          connected = true;
          break;
        } catch (error) {
          logger.debug(`Pool VM ${id}: connection attempt ${attempts + 1}/10`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      if (!connected) {
        throw new Error("Failed to connect to guest agent");
      }

      return {
        id,
        vm,
        agentClient,
        sockets,
        cid,
        guestIp: vm.getGuestIp(),
        createdAt: new Date(),
      };
    } catch (error) {
      // Cleanup on failure
      try {
        await vm.destroy();
      } catch {}
      throw error;
    }
  }

  /**
   * Get a VM from the pool (returns null if none available)
   */
  getVM(): PoolVM | null {
    const vm = this.availableVMs.shift();
    
    if (vm) {
      logger.debug(`Providing pool VM ${vm.id} to workspace`);
      
      // Start warming a replacement VM in background
      this.startWarming().catch((error) => {
        logger.debug(
          `Failed to warm replacement VM: ${error instanceof Error ? error.message : error}`
        );
      });
    }

    return vm || null;
  }

  /**
   * Return a VM to the pool (for reuse)
   */
  returnVM(vm: PoolVM): void {
    logger.debug(`Returning VM ${vm.id} to pool`);
    this.availableVMs.push(vm);
  }

  /**
   * Get pool statistics
   */
  getStats(): { available: number; target: number } {
    return {
      available: this.availableVMs.length,
      target: this.poolSize,
    };
  }

  /**
   * Shutdown all pool VMs
   */
  async shutdown(): Promise<void> {
    logger.debug(`Shutting down VM pool (${this.availableVMs.length} VMs)...`);
    
    for (const vm of this.availableVMs) {
      try {
        await vm.vm.destroy();
      } catch (error) {
        logger.debug(`Failed to destroy pool VM ${vm.id}: ${error}`);
      }
    }

    this.availableVMs = [];
  }
}

// Global singleton instance
export const vmPool = new VMPool();
