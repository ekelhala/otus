/**
 * Otus Daemon
 * Main orchestrator that coordinates all components
 */

import { mkdir, readFile, writeFile, mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WORKSPACE, resolveVMAssets, getVMAssetInstructions } from "@shared/constants.ts";
import { findFirecrackerBinary } from "./firecracker.ts";
import { EpisodicMemory } from "./memory/episodic.ts";
import { SemanticMemory } from "./memory/semantic.ts";
import { VoyageClient } from "./embeddings.ts";
import { InferenceEngine } from "./inference.ts";
import { SandboxManager } from "./sandbox.ts";
import { initLogger, getLogger, type Logger } from "@shared/logger.ts";

export interface DaemonConfig {
  workspacePath: string;
  anthropicApiKey: string;
  voyageApiKey: string;
  otusIgnoreFile?: string;
  verbose?: boolean;
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
  private readonly otusIgnoreFile: string;
  private readonly logger: Logger;
  
  private episodicMemory: EpisodicMemory | null = null;
  private semanticMemory: SemanticMemory | null = null;
  private voyageClient: VoyageClient | null = null;
  private sandboxManager: SandboxManager | null = null;
  private inferenceEngine: InferenceEngine | null = null;

  constructor(config: DaemonConfig) {
    this.config = config;
    this.otusPath = join(config.workspacePath, WORKSPACE.OTUS_DIR);
    // Default to .otusignore in workspace root if not specified
    this.otusIgnoreFile = config.otusIgnoreFile || join(config.workspacePath, ".otusignore");
    // Initialize logger with verbose setting
    this.logger = initLogger(config.verbose || false);
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

    // Check for kernel and rootfs
    const vmAssets = resolveVMAssets();
    if (!vmAssets) {
      issues.push(getVMAssetInstructions());
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
    this.logger.debug("Initializing workspace...");

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

    // Create default .otusignore file if it doesn't exist
    const otusignorePath = join(this.config.workspacePath, ".otusignore");
    if (!existsSync(otusignorePath)) {
      const defaultIgnore = `# Otus Ignore File
# This file is the single source of truth for excluding files/directories from
# workspace sync between host and guest VM. Uses tar's pattern matching syntax.
#
# Pattern rules:
# - Patterns match paths relative to workspace root
# - Use wildcards: *.log, test_*.py
# - Match directories without trailing slash: node_modules, build
# - Comments start with #
# - One pattern per line
#
# Note: This file (.otusignore) is always synced and never excluded.

# Otus internal directory (memory, indexes, etc.)
.otus

# Version control
.git
.svn
.hg

# Dependencies
node_modules
.venv
venv
vendor
Pods

# Environment files
.env
.env.local
.env.*.local

# Python
__pycache__
*.pyc
*.pyo
.pytest_cache
.mypy_cache
.tox
.nox
*.egg-info
.eggs

# Build outputs
dist
build
target
.next
.nuxt
.cache
.parcel-cache

# IDE and editors
.DS_Store
Thumbs.db
.idea
.vscode
*.swp
*.swo
*~

# Logs and temporary files
*.log
*.tmp
*.temp
*.bak

# Test coverage
.coverage
htmlcov
coverage

# Terraform
.terraform
*.tfstate
*.tfstate.backup

# Java/Gradle
*.class
.gradle

# Custom directories (uncomment if needed)
# scratch
# experiments
`;
      await Bun.write(otusignorePath, defaultIgnore);
      this.logger.debug("Created default .otusignore");
    }

    // Initialize episodic memory
    this.episodicMemory = new EpisodicMemory(this.config.workspacePath);
    this.logger.debug("Episodic memory initialized");

    // Initialize semantic memory
    this.voyageClient = new VoyageClient(this.config.voyageApiKey);
    this.semanticMemory = new SemanticMemory(
      this.config.workspacePath,
      this.voyageClient
    );
    await this.semanticMemory.initialize();
    this.logger.debug("Semantic memory initialized");

    // Index the workspace
    this.logger.debug("Indexing workspace (this may take a moment)...");
    await this.semanticMemory.indexWorkspace();
    this.logger.debug("Workspace indexed");

    // Start file watcher
    this.semanticMemory.startWatching();
    this.logger.debug("File watcher started");

    // Initialize sandbox manager (VMs are started on-demand by the agent)
    this.sandboxManager = new SandboxManager({
      workspacePath: this.config.workspacePath,
      otusIgnoreFile: this.otusIgnoreFile,
    });
    this.logger.debug("Sandbox manager initialized");

    // Initialize inference engine
    this.inferenceEngine = new InferenceEngine({
      apiKey: this.config.anthropicApiKey,
      sandboxManager: this.sandboxManager,
      episodicMemory: this.episodicMemory,
      semanticMemory: this.semanticMemory,
      workspacePath: this.config.workspacePath,
      logger: this.logger,
    });
    this.logger.debug("Inference engine initialized");

    this.logger.debug("Initialization complete!");
    this.logger.debug(`Workspace: ${this.config.workspacePath}`);
    this.logger.debug(`Otus data: ${this.otusPath}`);
  }

  /**
   * Start an interactive chat session
   * Returns the inference engine for the caller to run the chat loop
   */
  startChat(): { sessionId: string; chat: (message: string) => Promise<{ complete: boolean; summary?: string }> } {
    if (!this.inferenceEngine) {
      throw new Error("Daemon not initialized. Run init() first.");
    }

    const sessionId = this.inferenceEngine.startSession();
    
    return {
      sessionId,
      chat: (message: string) => this.inferenceEngine!.chat(message),
    };
  }

  /**
   * Execute a single task (legacy mode, wraps chat)
   */
  async do(goal: string): Promise<TaskResult> {
    if (!this.inferenceEngine) {
      throw new Error("Daemon not initialized. Run init() first.");
    }

    const startTime = Date.now();
    const chat = this.startChat();

    this.logger.debug(`Starting task ${chat.sessionId}`);
    this.logger.debug(`Goal: ${goal}`);

    try {
      const result = await chat.chat(goal);

      const duration = Date.now() - startTime;
      this.logger.debug(`Task ${result.complete ? "completed" : "ended"} in ${(duration / 1000).toFixed(1)}s`);

      return {
        taskId: chat.sessionId,
        goal,
        status: result.complete ? "completed" : "failed",
        duration,
      };
    } catch (error) {
      this.logger.debug("Task failed");
      this.logger.debug(error instanceof Error ? error.message : String(error));

      const duration = Date.now() - startTime;
      return {
        taskId: chat.sessionId,
        goal,
        status: "failed",
        duration,
      };
    }
  }

  /**
   * Shutdown the daemon
   */
  async shutdown(): Promise<void> {
    this.logger.debug("Shutting down daemon...");

    // Stop all sandboxes
    if (this.sandboxManager && this.sandboxManager.hasSandboxes()) {
      this.logger.debug("Stopping all sandboxes...");
      await this.sandboxManager.stopAll();
    }

    if (this.semanticMemory) {
      this.semanticMemory.stopWatching();
      await this.semanticMemory.close();
    }

    if (this.episodicMemory) {
      this.episodicMemory.close();
    }

    this.logger.debug("Goodbye!");
  }
}