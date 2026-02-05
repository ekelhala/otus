/**
 * Otus Daemon
 * Main orchestrator that coordinates all components
 */

import { mkdir, readFile, writeFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, relative } from "path";
import { WORKSPACE, FIRECRACKER } from "@shared/constants.ts";
import { FirecrackerVM, findFirecrackerBinary } from "./firecracker.ts";
import { GuestAgentClient, NetworkAgentClient } from "./vsock.ts";
import { EpisodicMemory } from "./memory/episodic.ts";
import { SemanticMemory } from "./memory/semantic.ts";
import { VoyageClient } from "./embeddings.ts";
import { InferenceEngine } from "./inference.ts";

export interface DaemonConfig {
  workspacePath: string;
  anthropicApiKey: string;
  voyageApiKey: string;
}

export interface TaskResult {
  taskId: string;
  goal: string;
  status: "completed" | "failed";
  duration: number;
}

/**
 * Main Otus Daemon
 */
export class OtusDaemon {
  private readonly config: DaemonConfig;
  private readonly otusPath: string;
  
  private episodicMemory: EpisodicMemory | null = null;
  private semanticMemory: SemanticMemory | null = null;
  private voyageClient: VoyageClient | null = null;
  private vm: FirecrackerVM | null = null;
  private agentClient: GuestAgentClient | NetworkAgentClient | null = null;
  private inferenceEngine: InferenceEngine | null = null;
  private guestIp: string | null = null;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.otusPath = join(config.workspacePath, WORKSPACE.OTUS_DIR);
  }

  /**
   * Check system prerequisites
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
        // Check if /dev/kvm exists and is accessible
        const { access } = await import("fs/promises");
        const { constants } = await import("fs");
        await access("/dev/kvm", constants.R_OK | constants.W_OK);
      } catch {
        issues.push("/dev/kvm not accessible. Add user to kvm group: sudo usermod -aG kvm $USER");
      }
    }

    return {
      ok: issues.length === 0,
      issues,
    };
  }

  /**
   * Initialize the Otus workspace
   */
  async init(): Promise<void> {
    console.log("[Otus] Initializing workspace...");

    // Create .otus directory structure
    const dirs = [
      this.otusPath,
      join(this.otusPath, WORKSPACE.LANCEDB_DIR),
      join(this.otusPath, WORKSPACE.SNAPSHOTS_DIR),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }
    }

    // Create configuration file
    const configPath = join(this.otusPath, WORKSPACE.CONFIG_FILE);
    if (!existsSync(configPath)) {
      const config = {
        version: "0.1.0",
        created: new Date().toISOString(),
      };
      await Bun.write(configPath, JSON.stringify(config, null, 2));
    }

    // Initialize episodic memory
    this.episodicMemory = new EpisodicMemory(this.config.workspacePath);
    console.log("[Otus] ✓ Episodic memory initialized");

    // Initialize semantic memory
    this.voyageClient = new VoyageClient(this.config.voyageApiKey);
    this.semanticMemory = new SemanticMemory(
      this.config.workspacePath,
      this.voyageClient
    );
    await this.semanticMemory.initialize();
    console.log("[Otus] ✓ Semantic memory initialized");

    // Index the workspace
    console.log("[Otus] Indexing workspace (this may take a moment)...");
    await this.semanticMemory.indexWorkspace();
    console.log("[Otus] ✓ Workspace indexed");

    // Start file watcher
    this.semanticMemory.startWatching();
    console.log("[Otus] ✓ File watcher started");

    console.log("\n[Otus] Initialization complete!");
    console.log(`Workspace: ${this.config.workspacePath}`);
    console.log(`Otus data: ${this.otusPath}`);
  }

  /**
   * Execute a task
   */
  async do(goal: string): Promise<TaskResult> {
    if (!this.episodicMemory || !this.semanticMemory || !this.voyageClient) {
      throw new Error("Daemon not initialized. Run init() first.");
    }

    const taskId = `task-${Date.now()}`;
    const startTime = Date.now();
    let syncStartTime = Date.now(); // Track when we started for incremental sync

    console.log(`\n[Otus] Starting task ${taskId}`);
    console.log(`Goal: ${goal}\n`);

    // Create task in episodic memory
    this.episodicMemory.createTask(taskId, goal);

    try {
      // Boot VM
      console.log("[Otus] Booting Firecracker VM...");
      await this.bootVM();
      console.log("[Otus] ✓ VM ready");

      // Connect to guest agent
      console.log("[Otus] Connecting to guest agent...");
      await this.connectAgent();
      console.log("[Otus] ✓ Agent connected");

      // Verify agent health
      const health = await this.agentClient!.health();
      console.log(`[Otus] ✓ Agent healthy (uptime: ${health.uptime.toFixed(1)}s)`);

      // Sync workspace to guest
      console.log("[Otus] Syncing workspace to VM...");
      syncStartTime = Date.now();
      await this.syncWorkspaceToGuest();
      console.log("[Otus] ✓ Workspace synced to VM");

      // Initialize inference engine
      this.inferenceEngine = new InferenceEngine({
        apiKey: this.config.anthropicApiKey,
        agentClient: this.agentClient!,
        episodicMemory: this.episodicMemory,
        semanticMemory: this.semanticMemory,
        workspacePath: this.config.workspacePath,
      });

      // Execute task
      await this.inferenceEngine.executeTask(taskId, goal);

      // Sync workspace back from guest before marking complete
      console.log("[Otus] Syncing workspace from VM...");
      await this.syncWorkspaceFromGuest(syncStartTime);
      console.log("[Otus] ✓ Workspace synced from VM");

      // Mark as completed
      this.episodicMemory.updateTaskStatus(taskId, "completed");

      const duration = Date.now() - startTime;
      console.log(`\n[Otus] Task completed in ${(duration / 1000).toFixed(1)}s`);

      return {
        taskId,
        goal,
        status: "completed",
        duration,
      };
    } catch (error) {
      console.error("\n[Otus] Task failed:", error);
      
      // Try to sync back any changes even on failure
      if (this.agentClient) {
        try {
          console.log("[Otus] Attempting to sync workspace on failure...");
          await this.syncWorkspaceFromGuest(syncStartTime);
          console.log("[Otus] ✓ Workspace synced from VM (partial)");
        } catch (syncError) {
          console.error("[Otus] Failed to sync workspace:", syncError);
        }
      }
      
      this.episodicMemory.updateTaskStatus(taskId, "failed");

      const duration = Date.now() - startTime;
      return {
        taskId,
        goal,
        status: "failed",
        duration,
      };
    } finally {
      // Cleanup
      await this.cleanup();
    }
  }

  /**
   * Boot the Firecracker VM
   */
  private async bootVM(): Promise<void> {
    // Find firecracker binary
    const binaryPath = await findFirecrackerBinary();
    if (!binaryPath) {
      throw new Error(
        "Firecracker binary not found.\n\n" +
        "Please install Firecracker:\n" +
        "  1. System-wide: Install via package manager\n" +
        "     Ubuntu/Debian: sudo apt install firecracker-bin\n" +
        "  2. Locally: Run ./infra/setup-firecracker.sh\n" +
        "  3. Manual: Download from https://github.com/firecracker-microvm/firecracker/releases\n\n" +
        "After installation, make sure firecracker is in PATH or at ./infra/firecracker"
      );
    }

    console.log(`[Otus] Using Firecracker at: ${binaryPath}`);

    // Check for kernel and rootfs
    if (!existsSync(FIRECRACKER.KERNEL_PATH)) {
      throw new Error(
        `Kernel not found at ${FIRECRACKER.KERNEL_PATH}\n` +
        "Run: ./infra/build-kernel.sh"
      );
    }

    if (!existsSync(FIRECRACKER.ROOTFS_PATH)) {
      throw new Error(
        `Rootfs not found at ${FIRECRACKER.ROOTFS_PATH}\n` +
        "Run: ./infra/build-rootfs.sh"
      );
    }

    this.vm = new FirecrackerVM({
      binaryPath,
      kernelPath: FIRECRACKER.KERNEL_PATH,
      rootfsPath: FIRECRACKER.ROOTFS_PATH,
      apiSocket: FIRECRACKER.API_SOCKET,
      vsockSocket: FIRECRACKER.VSOCK_SOCKET,
    });

    await this.vm.boot();

    // Wait for VM to boot and services to start
    // Increased to allow more time for Python packages and network init
    console.log("[Otus] Waiting for VM to initialize...");
    await new Promise((resolve) => setTimeout(resolve, 8000));
  }

  /**
   * Connect to the guest agent
   * Tries VSock first, falls back to network connection if VSock fails
   */
  private async connectAgent(): Promise<void> {
    // Try VSock first
    console.log("[Otus] Attempting VSock connection...");
    let vsockFailed = false;
    
    for (let attempts = 0; attempts < 5; attempts++) {
      try {
        this.agentClient = new GuestAgentClient();
        await this.agentClient.connect();
        
        // Verify with health check
        await this.agentClient.health();
        console.log("[Otus] Connected via VSock");
        return;
      } catch (error) {
        console.log(`[Otus] VSock attempt ${attempts + 1}/5 failed: ${error instanceof Error ? error.message : error}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    
    vsockFailed = true;
    console.log("[Otus] VSock connection failed, trying network connection...");
    
    // Get guest IP from TAP device
    const tapDevice = this.vm?.getTapDevice();
    if (!tapDevice) {
      throw new Error("No TAP device available for network fallback");
    }
    
    this.guestIp = tapDevice.guestIp;
    console.log(`[Otus] Guest IP: ${this.guestIp}`);
    
    // Try network connection
    for (let attempts = 0; attempts < 15; attempts++) {
      try {
        this.agentClient = new NetworkAgentClient(this.guestIp);
        await this.agentClient.connect();
        
        // Verify with health check
        await this.agentClient.health();
        console.log("[Otus] Connected via network");
        return;
      } catch (error) {
        console.log(`[Otus] Network attempt ${attempts + 1}/15: ${error instanceof Error ? error.message : error}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    
    throw new Error("Failed to connect to agent via both VSock and network");
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    console.log("\n[Otus] Cleaning up...");

    if (this.agentClient) {
      try {
        await this.agentClient.close();
      } catch {}
    }

    if (this.vm) {
      try {
        await this.vm.destroy();
      } catch {}
    }

    console.log("[Otus] ✓ Cleanup complete");
  }

  /**
   * Shutdown the daemon
   */
  async shutdown(): Promise<void> {
    console.log("\n[Otus] Shutting down daemon...");

    if (this.semanticMemory) {
      this.semanticMemory.stopWatching();
      await this.semanticMemory.close();
    }

    if (this.episodicMemory) {
      this.episodicMemory.close();
    }

    await this.cleanup();

    console.log("[Otus] Goodbye!");
  }

  /**
   * Sync workspace files to the guest VM
   */
  private async syncWorkspaceToGuest(): Promise<void> {
    if (!this.agentClient) {
      throw new Error("Agent client not connected");
    }

    const files: Array<{ path: string; content: string; mode?: number }> = [];
    
    // Collect all files from workspace
    await this.collectWorkspaceFiles(this.config.workspacePath, files);
    
    if (files.length === 0) {
      console.log("[Otus] No files to sync");
      return;
    }

    console.log(`[Otus] Syncing ${files.length} files to VM...`);
    
    // Sync in batches to avoid overwhelming the connection
    const batchSize = 50;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const result = await this.agentClient.syncToGuest(batch);
      
      if (result.errors.length > 0) {
        console.warn(`[Otus] Sync errors:`, result.errors);
      }
    }
  }

  /**
   * Collect files from workspace directory
   */
  private async collectWorkspaceFiles(
    dirPath: string,
    files: Array<{ path: string; content: string; mode?: number }>,
    basePath = this.config.workspacePath
  ): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      // Skip hidden files, node_modules, and .otus directory
      if (entry.name.startsWith('.') || 
          entry.name === 'node_modules' ||
          entry.name === '__pycache__' ||
          entry.name === '.git' ||
          entry.name === WORKSPACE.OTUS_DIR) {
        continue;
      }
      
      const fullPath = join(dirPath, entry.name);
      const relativePath = relative(basePath, fullPath);
      
      if (entry.isDirectory()) {
        await this.collectWorkspaceFiles(fullPath, files, basePath);
      } else {
        try {
          const stats = await stat(fullPath);
          
          // Skip large files (> 5MB)
          if (stats.size > 5 * 1024 * 1024) {
            console.log(`[Otus] Skipping large file: ${relativePath} (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
            continue;
          }
          
          const content = await readFile(fullPath);
          files.push({
            path: relativePath,
            content: content.toString('base64'),
          });
        } catch (error) {
          console.warn(`[Otus] Failed to read file ${relativePath}:`, error);
        }
      }
    }
  }

  /**
   * Sync workspace files from the guest VM back to host
   */
  private async syncWorkspaceFromGuest(since?: number): Promise<void> {
    if (!this.agentClient) {
      throw new Error("Agent client not connected");
    }

    const result = await this.agentClient.syncFromGuest("/workspace", since);
    
    if (result.files.length === 0) {
      console.log("[Otus] No files changed in VM");
      return;
    }

    console.log(`[Otus] Syncing ${result.files.length} files from VM...`);
    
    for (const file of result.files) {
      const targetPath = join(this.config.workspacePath, file.path);
      
      try {
        // Ensure directory exists
        const dir = targetPath.substring(0, targetPath.lastIndexOf('/'));
        if (dir && !existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
        
        // Decode and write file
        const content = Buffer.from(file.content, 'base64');
        await writeFile(targetPath, content);
        
        console.log(`[Otus] Updated: ${file.path}`);
      } catch (error) {
        console.warn(`[Otus] Failed to write file ${file.path}:`, error);
      }
    }
  }
}
