/**
 * Sandbox Manager
 * Manages multiple Firecracker VM sandboxes that can be created/destroyed via tool calls
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FirecrackerVM, findFirecrackerBinary } from "./firecracker.ts";
import { GuestAgentClient } from "./vsock.ts";
import { FIRECRACKER, VSOCK } from "@shared/constants.ts";

/**
 * Sandbox instance representing a single VM
 */
export interface Sandbox {
  /** Unique sandbox identifier */
  id: string;
  /** Human-readable name (optional) */
  name?: string;
  /** The Firecracker VM instance */
  vm: FirecrackerVM;
  /** Connected guest agent client */
  agentClient: GuestAgentClient;
  /** When the sandbox was created */
  createdAt: Date;
  /** Socket paths for this sandbox */
  sockets: {
    api: string;
    vsock: string;
  };
  /** Whether workspace has been synced to this sandbox */
  workspaceSynced: boolean;
  /** Guest IP address (if network enabled) */
  guestIp: string | null;
}

/**
 * Sandbox metadata for listing
 */
export interface SandboxInfo {
  id: string;
  name?: string;
  createdAt: string;
  uptime: number;
  guestIp: string | null;
  workspaceSynced: boolean;
}

export interface SandboxManagerConfig {
  workspacePath: string;
  otusIgnoreFile: string;
}

/**
 * Manages multiple VM sandboxes
 */
export class SandboxManager {
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly config: SandboxManagerConfig;
  private nextCid = 3; // Starting CID for VSock (Firecracker uses CID 3+)
  private activeSandboxId: string | null = null;

  constructor(config: SandboxManagerConfig) {
    this.config = config;
  }

  /**
   * Check system prerequisites for running VMs
   */
  async checkPrerequisites(): Promise<{ ok: boolean; issues: string[] }> {
    const issues: string[] = [];

    // Check for Firecracker binary
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) {
      issues.push(
        "Firecracker binary not found. Install with ./infra/setup-firecracker.sh"
      );
    }

    // Check for kernel
    if (!existsSync(FIRECRACKER.KERNEL_PATH)) {
      issues.push(
        `Kernel not found at ${FIRECRACKER.KERNEL_PATH}. Run ./infra/build-kernel.sh`
      );
    }

    // Check for rootfs
    if (!existsSync(FIRECRACKER.ROOTFS_PATH)) {
      issues.push(
        `Rootfs not found at ${FIRECRACKER.ROOTFS_PATH}. Run ./infra/build-rootfs.sh`
      );
    }

    // Check KVM access (Linux only)
    if (process.platform === "linux") {
      try {
        const { access } = await import("fs/promises");
        const { constants } = await import("fs");
        await access("/dev/kvm", constants.R_OK | constants.W_OK);
      } catch {
        issues.push("/dev/kvm not accessible. Add user to kvm group: sudo usermod -aG kvm $USER");
      }
    }

    return { ok: issues.length === 0, issues };
  }

  /**
   * Start a new sandbox VM
   */
  async startSandbox(name?: string): Promise<Sandbox> {
    const id = `sandbox-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const cid = this.nextCid++;

    // Find firecracker binary
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) {
      throw new Error(
        "Firecracker binary not found.\n" +
        "Please run: ./infra/setup-firecracker.sh"
      );
    }

    // Check prerequisites
    if (!existsSync(FIRECRACKER.KERNEL_PATH)) {
      throw new Error(`Kernel not found at ${FIRECRACKER.KERNEL_PATH}. Run: ./infra/build-kernel.sh`);
    }
    if (!existsSync(FIRECRACKER.ROOTFS_PATH)) {
      throw new Error(`Rootfs not found at ${FIRECRACKER.ROOTFS_PATH}. Run: ./infra/build-rootfs.sh`);
    }

    // Create unique socket paths for this sandbox
    const sockets = {
      api: `/tmp/firecracker-${id}.socket`,
      vsock: `/tmp/firecracker-${id}-vsock.socket`,
    };

    console.log(`[Sandbox] Starting sandbox ${id}${name ? ` (${name})` : ""}...`);

    // Create VM instance
    const vm = new FirecrackerVM({
      binaryPath,
      kernelPath: FIRECRACKER.KERNEL_PATH,
      rootfsPath: FIRECRACKER.ROOTFS_PATH,
      apiSocket: sockets.api,
      vsockSocket: sockets.vsock,
      guestCid: cid,
      enableNetwork: true,
    });

    try {
      // Boot the VM
      await vm.boot();

      // Wait for VM to initialize
      console.log(`[Sandbox] Waiting for VM to initialize...`);
      await new Promise((resolve) => setTimeout(resolve, 8000));

      // Connect to guest agent
      console.log(`[Sandbox] Connecting to guest agent...`);
      const agentClient = new GuestAgentClient(sockets.vsock, cid, VSOCK.AGENT_PORT);

      let connected = false;
      for (let attempts = 0; attempts < 10; attempts++) {
        try {
          await agentClient.connect();
          await agentClient.health();
          connected = true;
          break;
        } catch (error) {
          console.log(`[Sandbox] Connection attempt ${attempts + 1}/10: ${error instanceof Error ? error.message : error}`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      if (!connected) {
        throw new Error("Failed to connect to guest agent after 10 attempts");
      }

      const sandbox: Sandbox = {
        id,
        name,
        vm,
        agentClient,
        createdAt: new Date(),
        sockets,
        workspaceSynced: false,
        guestIp: vm.getGuestIp(),
      };

      this.sandboxes.set(id, sandbox);

      // Set as active if it's the first sandbox
      if (!this.activeSandboxId) {
        this.activeSandboxId = id;
      }

      console.log(`[Sandbox] ✓ Sandbox ${id} ready (IP: ${sandbox.guestIp})`);
      return sandbox;
    } catch (error) {
      // Cleanup on failure
      try {
        await vm.destroy();
      } catch {}
      throw error;
    }
  }

  /**
   * Stop and destroy a sandbox
   */
  async stopSandbox(sandboxId: string, syncBack = true): Promise<void> {
    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }

    console.log(`[Sandbox] Stopping sandbox ${sandboxId}...`);

    try {
      // Optionally sync workspace back before destroying
      if (syncBack && sandbox.workspaceSynced) {
        console.log(`[Sandbox] Syncing workspace from sandbox...`);
        await this.syncFromSandbox(sandboxId);
      }

      // Close agent connection
      try {
        await sandbox.agentClient.close();
      } catch {}

      // Destroy VM
      await sandbox.vm.destroy();

    } finally {
      this.sandboxes.delete(sandboxId);

      // Update active sandbox if needed
      if (this.activeSandboxId === sandboxId) {
        const remaining = Array.from(this.sandboxes.keys());
        this.activeSandboxId = remaining.length > 0 ? remaining[0]! : null;
      }
    }

    console.log(`[Sandbox] ✓ Sandbox ${sandboxId} stopped`);
  }

  /**
   * Get a sandbox by ID
   */
  getSandbox(sandboxId: string): Sandbox | undefined {
    return this.sandboxes.get(sandboxId);
  }

  /**
   * Get the active sandbox
   */
  getActiveSandbox(): Sandbox | undefined {
    if (!this.activeSandboxId) return undefined;
    return this.sandboxes.get(this.activeSandboxId);
  }

  /**
   * Set the active sandbox
   */
  setActiveSandbox(sandboxId: string): void {
    if (!this.sandboxes.has(sandboxId)) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }
    this.activeSandboxId = sandboxId;
  }

  /**
   * List all sandboxes
   */
  async listSandboxes(): Promise<SandboxInfo[]> {
    const infos: SandboxInfo[] = [];

    for (const [id, sandbox] of this.sandboxes) {
      let uptime = 0;
      try {
        const health = await sandbox.agentClient.health();
        uptime = health.uptime;
      } catch {}

      infos.push({
        id,
        name: sandbox.name,
        createdAt: sandbox.createdAt.toISOString(),
        uptime,
        guestIp: sandbox.guestIp,
        workspaceSynced: sandbox.workspaceSynced,
      });
    }

    return infos;
  }

  /**
   * Execute a command in a sandbox
   */
  async executeInSandbox(
    command: string,
    options?: {
      sandboxId?: string;
      timeout?: number;
      cwd?: string;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    timedOut?: boolean;
  }> {
    const sandboxId = options?.sandboxId || this.activeSandboxId;
    if (!sandboxId) {
      throw new Error("No active sandbox. Start one with start_sandbox first.");
    }

    const sandbox = this.sandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${sandboxId}`);
    }

    return sandbox.agentClient.execute(command, {
      timeout: options?.timeout,
      cwd: options?.cwd,
    });
  }

  /**
   * Sync workspace to a sandbox
   */
  async syncToSandbox(sandboxId?: string): Promise<{ filesWritten: number }> {
    const id = sandboxId || this.activeSandboxId;
    if (!id) {
      throw new Error("No active sandbox");
    }

    const sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${id}`);
    }

    console.log(`[Sandbox] Syncing workspace to sandbox ${id}...`);

    // Create tar archive
    const tarData = await this.createWorkspaceTar();
    if (!tarData || tarData.length === 0) {
      console.log("[Sandbox] No files to sync");
      return { filesWritten: 0 };
    }

    console.log(`[Sandbox] Uploading ${(tarData.length / 1024).toFixed(1)}KB to sandbox...`);

    const result = await sandbox.agentClient.syncToGuest(tarData);
    if (!result.success) {
      throw new Error(`Sync failed: ${result.error}`);
    }

    sandbox.workspaceSynced = true;
    console.log(`[Sandbox] ✓ Synced ${result.filesWritten} files to sandbox`);
    return { filesWritten: result.filesWritten };
  }

  /**
   * Sync workspace from a sandbox
   */
  async syncFromSandbox(sandboxId?: string): Promise<{ size: number }> {
    const id = sandboxId || this.activeSandboxId;
    if (!id) {
      throw new Error("No active sandbox");
    }

    const sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      throw new Error(`Sandbox not found: ${id}`);
    }

    // Get user exclude patterns
    const excludes = await this.parseIgnoreFile();

    const result = await sandbox.agentClient.syncFromGuest("/workspace", excludes);
    if (!result.tarData || result.tarData.length === 0) {
      return { size: 0 };
    }

    // Extract to workspace
    const { mkdtemp } = await import("fs/promises");
    const tmpDir = await mkdtemp(join(tmpdir(), "otus-sync-"));
    const tarFile = join(tmpDir, "workspace.tar.gz");

    try {
      writeFileSync(tarFile, result.tarData);

      const proc = Bun.spawn(
        ["tar", "-xzf", tarFile, "-C", this.config.workspacePath],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      if (proc.exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`tar extract failed: ${stderr}`);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }

    return { size: result.size };
  }

  /**
   * Parse .otusignore file
   */
  private async parseIgnoreFile(): Promise<string[]> {
    try {
      const content = readFileSync(this.config.otusIgnoreFile, "utf-8");
      return content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

  /**
   * Create tar archive of workspace
   */
  private async createWorkspaceTar(): Promise<Buffer> {
    const patterns = await this.parseIgnoreFile();
    const excludes = patterns.map((pattern) => `--exclude=${pattern}`);

    const proc = Bun.spawn(
      ["tar", "-czf", "-", ...excludes, "-C", this.config.workspacePath, "."],
      { stdout: "pipe", stderr: "pipe" }
    );

    const output = await new Response(proc.stdout).arrayBuffer();
    await proc.exited;

    return Buffer.from(output);
  }

  /**
   * Stop all sandboxes
   */
  async stopAll(): Promise<void> {
    console.log(`[Sandbox] Stopping all sandboxes...`);
    
    const ids = Array.from(this.sandboxes.keys());
    for (const id of ids) {
      try {
        await this.stopSandbox(id, true);
      } catch (error) {
        console.error(`[Sandbox] Error stopping ${id}:`, error);
      }
    }
  }

  /**
   * Check if any sandboxes are running
   */
  hasSandboxes(): boolean {
    return this.sandboxes.size > 0;
  }

  /**
   * Get count of running sandboxes
   */
  getSandboxCount(): number {
    return this.sandboxes.size;
  }
}
