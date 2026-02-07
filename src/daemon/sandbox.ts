/**
 * Sandbox Manager
 * Manages multiple Firecracker VM sandboxes that can be created/destroyed via tool calls
 */

import { existsSync, writeFileSync, readFileSync } from "fs";
import { rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { minimatch } from "minimatch";
import * as tar from "tar";
import { FirecrackerVM, findFirecrackerBinary } from "./firecracker.ts";
import { GuestAgentClient } from "./vsock.ts";
import { VSOCK, resolveVMAssets, getVMAssetInstructions, SYSTEM_PATHS } from "../shared/constants.ts";
import { vmPool } from "./vm-pool.ts";

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

    // Check for kernel and rootfs
    const vmAssets = resolveVMAssets();
    if (!vmAssets) {
      issues.push(getVMAssetInstructions());
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
   * Start a new sandbox VM (uses pool VM if available)
   */
  async startSandbox(name?: string): Promise<Sandbox> {
    // Try to get a pre-warmed VM from the pool
    const poolVM = vmPool.getVM();
    
    if (poolVM) {
      console.log(`[Sandbox] Using pre-warmed VM ${poolVM.id}${name ? ` for ${name}` : ""}`);
      
      const sandbox: Sandbox = {
        id: poolVM.id,
        name,
        vm: poolVM.vm,
        agentClient: poolVM.agentClient,
        createdAt: poolVM.createdAt,
        sockets: poolVM.sockets,
        workspaceSynced: false,
        guestIp: poolVM.guestIp,
      };

      this.sandboxes.set(sandbox.id, sandbox);

      // Set as active if it's the first sandbox
      if (!this.activeSandboxId) {
        this.activeSandboxId = sandbox.id;
      }

      console.log(`[Sandbox] ✓ Sandbox ${sandbox.id} ready (IP: ${sandbox.guestIp}) - from pool`);
      return sandbox;
    }

    // No pool VM available, create a new one
    console.log(`[Sandbox] No pool VM available, creating new VM...`);
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

    // Resolve VM assets (kernel and rootfs)
    const vmAssets = resolveVMAssets();
    if (!vmAssets) {
      throw new Error(getVMAssetInstructions());
    }

    // Create unique socket paths for this sandbox
    const sockets = {
      api: `/tmp/firecracker-${id}.socket`,
      vsock: `/tmp/firecracker-${id}-vsock.socket`,
    };

    console.log(`[Sandbox] Starting sandbox ${id}${name ? ` (${name})` : ""}...`);
    console.log(`[Sandbox] Using VM assets from ${vmAssets.source === "system" ? SYSTEM_PATHS.SYSTEM_DIR : SYSTEM_PATHS.LOCAL_DIR}`);

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

    // Extract to workspace, then delete any stale host files not present in the sandbox snapshot.
    // This mirrors the sandbox contents for the synced subset, while leaving excluded paths untouched.
    const { mkdtemp } = await import("fs/promises");
    const tmpDir = await mkdtemp(join(tmpdir(), "otus-sync-"));
    const tarFile = join(tmpDir, "workspace.tar.gz");

    try {
      writeFileSync(tarFile, result.tarData);

      // 1) Extract snapshot into workspace (overlay)
      try {
        await tar.x({
          file: tarFile,
          cwd: this.config.workspacePath,
          gzip: true,
        });
      } catch (error) {
        throw new Error(
          `tar extract failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // 2) Build snapshot manifest from the tarball
      const snapshot = await this.getTarSnapshotPaths(tarFile);

      // 3) Delete any host files/dirs not present in snapshot (except excluded paths)
      await this.deleteStaleHostPaths({
        snapshot,
        excludes,
      });
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
   * Paths that are never synced in either direction.
   * These are critical workspace-local files that the sandbox agent must not overwrite.
   */
  private isProtectedPath(relPath: string): boolean {
    // .otus/ directory (contains memory DB, config, lancedb, etc.)
    if (relPath === ".otus" || relPath.startsWith(".otus/")) return true;
    // .otusignore file
    if (relPath === ".otusignore") return true;
    return false;
  }

  private async getTarSnapshotPaths(tarFile: string): Promise<Set<string>> {
    const snapshotPaths = new Set<string>();

    const entryPaths: string[] = [];
    await tar.t({
      file: tarFile,
      gzip: true,
      onentry: (entry) => {
        entryPaths.push(entry.path);
      },
    });

    for (const entryPath of entryPaths) {
      const normalized = this.normalizeRelPath(entryPath);
      if (!normalized) continue;
      snapshotPaths.add(normalized);

      // Ensure parent directories are considered present even if not explicitly listed.
      const parts = normalized.split("/");
      if (parts.length > 1) {
        let current = "";
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i]!;
          snapshotPaths.add(current);
        }
      }
    }

    return snapshotPaths;
  }

  private normalizeRelPath(p: string): string {
    let s = p.trim();
    if (!s) return "";
    // tar listings sometimes include leading './'
    if (s === "." || s === "./") return "";
    s = s.replace(/^\.\//, "");
    // Normalize directory entries that end with '/'
    s = s.replace(/\/$/, "");
    if (!s) return "";
    return s;
  }

  private shouldExcludePath(relPath: string, excludes: string[]): boolean {
    // Protected paths are never synced in either direction.
    if (this.isProtectedPath(relPath)) return true;

    // Best-effort match tar-style excludes using minimatch.
    // Match both the whole path and the basename to emulate tar's common behavior
    // for patterns without slashes (e.g., 'node_modules', '.git', '*.tmp').
    const baseName = relPath.split("/").pop() || relPath;

    for (const pattern of excludes) {
      const pat = pattern.trim();
      if (!pat) continue;

      // Directories in tar listings won't have trailing '/', but patterns may refer to directory names.
      if (
        minimatch(relPath, pat, { dot: true, matchBase: true }) ||
        minimatch(baseName, pat, { dot: true, matchBase: true })
      ) {
        return true;
      }
    }

    return false;
  }

  private async deleteStaleHostPaths(args: {
    snapshot: Set<string>;
    excludes: string[];
  }): Promise<void> {
    const { readdir } = await import("fs/promises");

    const walk = async (absDir: string, relDir: string): Promise<boolean> => {
      const entries = await readdir(absDir, { withFileTypes: true });

      let containsExcludedDescendant = false;

      // Recurse first so we can safely decide whether it's OK to delete a directory.
      const childDirHasExcluded = new Map<string, boolean>();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        const normalized = this.normalizeRelPath(relPath);
        if (!normalized) continue;

        if (this.shouldExcludePath(normalized, args.excludes)) {
          containsExcludedDescendant = true;
          continue;
        }

        const hasExcluded = await walk(join(absDir, entry.name), normalized);
        childDirHasExcluded.set(normalized, hasExcluded);
        if (hasExcluded) containsExcludedDescendant = true;
      }

      // Delete files/dirs not present in snapshot (but never touch excluded paths).
      for (const entry of entries) {
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        const normalized = this.normalizeRelPath(relPath);
        if (!normalized) continue;

        if (this.shouldExcludePath(normalized, args.excludes)) {
          containsExcludedDescendant = true;
          continue;
        }

        if (!args.snapshot.has(normalized)) {
          const absPath = join(this.config.workspacePath, normalized);
          if (entry.isDirectory()) {
            const hasExcluded = childDirHasExcluded.get(normalized) ?? false;
            // If this directory contains excluded descendants, we must not delete it wholesale,
            // otherwise we'd indirectly delete do-not-sync paths.
            if (!hasExcluded) {
              await rm(absPath, { recursive: true, force: true });
            }
          } else {
            await rm(absPath, { recursive: true, force: true });
          }
        }
      }

      return containsExcludedDescendant;
    };

    await walk(this.config.workspacePath, "");
  }

  /**
   * Create tar archive of workspace
   */
  private async createWorkspaceTar(): Promise<Buffer> {
    const excludes = await this.parseIgnoreFile();

    const stream = tar.c(
      {
        gzip: true,
        cwd: this.config.workspacePath,
        portable: true,
        noMtime: true,
        filter: (p) => {
          const rel = this.normalizeRelPath(p);
          if (!rel) return true;
          return !this.shouldExcludePath(rel, excludes);
        },
      },
      ["."]
    );

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
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
