/**
 * Tool handlers for executing agent tools
 */

import type { SandboxManager } from "../sandbox.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { SemanticMemory } from "../memory/semantic.ts";
import type { Logger } from "@shared/logger.ts";
import { LLM } from "@shared/constants.ts";
import type { ToolName } from "./tools.ts";
import { isAbsolute, normalize } from "node:path";
import { readFile } from "node:fs/promises";

export interface ToolHandlersConfig {
  sandboxManager: SandboxManager;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  workspacePath: string;
  logger: Logger;
}

/**
 * Handles execution of agent tools
 */
export class ToolHandlers {
  private readonly sandboxManager: SandboxManager;
  private readonly episodicMemory: EpisodicMemory;
  private readonly semanticMemory: SemanticMemory;
  private readonly workspacePath: string;
  private readonly logger: Logger;

  // Per-(sandbox, terminal) read state to support incremental reads.
  // Stores a snapshot of the last observed capture-pane output.
  private readonly terminalReadState = new Map<
    string,
    {
      lastOutput: string;
      lastReadAt: number;
    }
  >();

  // Auto-sync state: keep host reasonably up-to-date without requiring the model
  // to remember to sync after every workspace change.
  private autoSyncDirty = false;
  private autoSyncInFlight = false;
  private lastAutoSyncAt = 0;
  private autoSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ToolHandlersConfig) {
    this.sandboxManager = config.sandboxManager;
    this.episodicMemory = config.episodicMemory;
    this.semanticMemory = config.semanticMemory;
    this.workspacePath = config.workspacePath;
    this.logger = config.logger;
  }

  private markWorkspaceDirty(): void {
    this.autoSyncDirty = true;
  }

  private scheduleAutoSync(delayMs: number, reason: string): void {
    if (this.autoSyncTimer) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }

    this.autoSyncTimer = setTimeout(() => {
      this.autoSyncTimer = null;
      void this.tryAutoSync(reason);
    }, delayMs);
  }

  private async tryAutoSync(reason: string): Promise<void> {
    if (this.autoSyncInFlight) return;
    if (!this.autoSyncDirty) return;

    // Don’t auto-sync too frequently.
    const MIN_INTERVAL_MS = 15_000;
    if (Date.now() - this.lastAutoSyncAt < MIN_INTERVAL_MS) return;

    const active = this.sandboxManager.getActiveSandbox();
    if (!active) return;

    this.autoSyncInFlight = true;
    try {
      // Overlay-only: avoids deleting host files while a command is mid-flight.
      await this.sandboxManager.syncFromSandbox(undefined, { mirror: false });
      this.lastAutoSyncAt = Date.now();
      this.autoSyncDirty = false;
      this.logger.debug(`Auto-synced workspace from sandbox (${reason})`);
    } catch (err) {
      // Keep dirty so we can retry later.
      this.logger.debug(`Auto-sync failed (${reason}): ${String(err)}`);
    } finally {
      this.autoSyncInFlight = false;
    }
  }

  private terminalStateKey(sandboxId: string, terminalName: string): string {
    return `${sandboxId}:${terminalName}`;
  }

  private computeIncrementalDelta(current: string, previous: string): string | null {
    if (!previous) return current;
    if (current === previous) return "";
    if (current.startsWith(previous)) {
      return current.slice(previous.length);
    }

    // Fall back to overlap search (handles tmux history shifts or snapshot truncation).
    const OVERLAP_CHARS = 4000;
    const needle = previous.length > OVERLAP_CHARS ? previous.slice(-OVERLAP_CHARS) : previous;
    if (!needle) return current;

    const idx = current.lastIndexOf(needle);
    if (idx === -1) return null;
    return current.slice(idx + needle.length);
  }

  /**
   * Execute a tool by name
   */
  async execute(
    toolName: ToolName,
    input: unknown,
    taskId: string
  ): Promise<string> {
    switch (toolName) {
      case "start_sandbox":
        return await this.startSandbox(input as StartSandboxInput);

      case "stop_sandbox":
        return await this.stopSandbox(input as StopSandboxInput);

      case "sync_workspace":
        return await this.syncWorkspace(input as SyncWorkspaceInput);

      case "get_otusignore":
        return await this.getOtusIgnore();

      case "start_terminal":
        return await this.startTerminal(input as StartTerminalInput);

      case "send_to_terminal":
        return await this.sendToTerminal(input as SendToTerminalInput);

      case "read_terminal":
        return await this.readTerminal(input as ReadTerminalInput);

      case "list_terminals":
        return await this.listTerminals(input as ListTerminalsInput);

      case "kill_terminal":
        return await this.killTerminal(input as KillTerminalInput);

      case "wait":
        return await this.wait(input as WaitInput);

      case "search_code":
        return await this.searchCode(input as SearchCodeInput);

      case "plan":
        return await this.plan(input as PlanInput);

      case "docker":
        return await this.docker(input as DockerInput);

      case "task_complete":
        return await this.completeTask(taskId, input as TaskCompleteInput);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  private async getOtusIgnore(): Promise<string> {
    // .otusignore lives in the HOST workspace; it controls what is excluded from sync
    // in BOTH directions.
    const ignorePath = `${this.workspacePath}/.otusignore`;

    let patterns: string[] = [];
    try {
      const content = await readFile(ignorePath, "utf-8");
      patterns = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    } catch {
      patterns = [];
    }

    const lines: string[] = [];
    lines.push(".otusignore exclude patterns (applied during sync to/from sandbox):");
    if (patterns.length === 0) {
      lines.push("- (none)");
    } else {
      for (const p of patterns) lines.push(`- ${p}`);
    }

    lines.push("");
    lines.push("Notes:");
    lines.push("- These patterns exclude paths from BOTH sync directions.");
    lines.push("- The .otus/ directory is protected and never synced.");
    lines.push("- The .otusignore file itself is always included in sync.");
    lines.push("- If a file is excluded, host and sandbox can diverge for that path.");

    return lines.join("\n");
  }

  /**
   * Start a new sandbox VM
   */
  private async startSandbox(input: StartSandboxInput): Promise<string> {
    const sandbox = await this.sandboxManager.startSandbox(input.name);

    // Sync workspace by default unless explicitly disabled
    if (input.sync_workspace !== false) {
      const syncResult = await this.sandboxManager.syncToSandbox();
      return `Sandbox started successfully.
ID: ${sandbox.id}
${sandbox.name ? `Name: ${sandbox.name}` : ""}
IP: ${sandbox.guestIp}
Workspace synced: ${syncResult.filesWritten} files`;
    }

    return `Sandbox started successfully.
ID: ${sandbox.id}
${sandbox.name ? `Name: ${sandbox.name}` : ""}
IP: ${sandbox.guestIp}
Workspace not synced (use sync_workspace to push files)`;
  }

  /**
   * Stop a sandbox VM
   */
  private async stopSandbox(input: StopSandboxInput): Promise<string> {
    const syncBack = input.sync_back !== false; // Default to true

    const activeSandbox = this.sandboxManager.getActiveSandbox();
    if (!activeSandbox) {
      return "No sandbox is running.";
    }

    await this.sandboxManager.stopSandbox(activeSandbox.id, syncBack);
    // Drop any incremental terminal read state: terminals are sandbox-scoped.
    this.terminalReadState.clear();
    return `Sandbox stopped. Workspace ${syncBack ? "synced back" : "not synced"}.`;
  }

  /**
   * Sync workspace between host and sandbox
   */
  private async syncWorkspace(input: SyncWorkspaceInput): Promise<string> {
    if (input.direction === "to_sandbox") {
      const result = await this.sandboxManager.syncToSandbox();
      return `Synced ${result.filesWritten} files to sandbox.`;
    } else {
      // Explicit sync should mirror (including deletion of stale host paths).
      const result = await this.sandboxManager.syncFromSandbox(undefined, { mirror: true });
      this.lastAutoSyncAt = Date.now();
      this.autoSyncDirty = false;
      return `Synced ${(result.size / 1024).toFixed(1)}KB from sandbox to host.`;
    }
  }

  /**
   * Search the codebase
   */
  private async searchCode(input: SearchCodeInput): Promise<string> {
    const results = await this.semanticMemory.search(
      input.query,
      input.limit || LLM.RAG_RESULTS
    );

    if (results.length === 0) {
      return "No relevant code found.";
    }

    // Format results
    return results
      .map((result, i) => {
        return `
[Result ${i + 1}] ${result.filepath} (lines ${result.startLine}-${result.endLine})
${result.content}
`.trim();
      })
      .join("\n\n");
  }

  /**
   * Create a plan by breaking down a complex task into steps
   */
  private async plan(input: PlanInput): Promise<string> {
    if (!input.steps || input.steps.length === 0) {
      throw new Error("Plan must contain at least one step");
    }

    this.logger.toolResult("plan", `Created plan with ${input.steps.length} steps`);
    
    // Return minimal acknowledgment - the engine handles step injection
    return `Plan accepted with ${input.steps.length} steps. Focus on the next step instruction.`;
  }

  /**
   * Complete the task
   */
  private async completeTask(
    taskId: string,
    input: TaskCompleteInput
  ): Promise<string> {
    this.episodicMemory.updateTaskStatus(taskId, "completed");
    this.episodicMemory.saveReflection(taskId, input.summary, input.lessons || []);

    return "Task marked as complete";
  }

  // ========== Terminal handlers ==========

  /**
   * Start a terminal session in the sandbox
   */
  private async startTerminal(input: StartTerminalInput): Promise<string> {
    const sandbox = this.getSandbox();
    const result = await sandbox.agentClient.startSession(input.name);

    if (!result.success) {
      return `Failed to start terminal: ${result.error}`;
    }

    this.logger.toolResult("start_terminal", `Started terminal: ${input.name}`);
    return `Terminal '${input.name}' started successfully.\nUse send_to_terminal to run commands in this terminal.`;
  }

  /**
   * Send a command to a terminal session
   */
  private async sendToTerminal(input: SendToTerminalInput): Promise<string> {
    const sandbox = this.getSandbox();
    const result = await sandbox.agentClient.sendToSession(input.name, input.command);

    if (!result.success) {
      return `Failed to send to terminal: ${result.error}`;
    }

    // Any terminal command might touch the workspace.
    this.markWorkspaceDirty();
    // Debounced: give the command a moment to run before syncing.
    this.scheduleAutoSync(10_000, "send_to_terminal");

    this.logger.toolResult("send_to_terminal", `Sent to ${input.name}: ${input.command.substring(0, 50)}...`);
    return `Command sent to terminal '${input.name}'.\nUse read_terminal to check output.`;
  }

  /**
   * Read output from a terminal session
   */
  private async readTerminal(input: ReadTerminalInput): Promise<string> {
    const sandbox = this.getSandbox();
    const result = await sandbox.agentClient.readSession(input.name, input.lines);

    if (!result.success) {
      return `Failed to read terminal: ${result.error}`;
    }

    // If we’ve recently run commands, reading output is a good point to sync back.
    if (this.autoSyncDirty) {
      this.scheduleAutoSync(2_000, "read_terminal");
    }

    const linesRequested = input.lines ?? 1000;
    const rawOutput = result.output ?? "";
    // Normalize CRLF to LF for consistency. This keeps the output semantically the same,
    // while avoiding confusing \r artifacts in model inputs.
    const output = rawOutput.replace(/\r\n/g, "\n");

    const preview = output.substring(0, 200);
    this.logger.toolResult(
      "read_terminal",
      `${preview}${output.length > 200 ? "..." : ""}`
    );

    // Keep output as close as possible to a real terminal: return captured pane text verbatim,
    // with minimal, easy-to-parse delimiters. Support incremental reads by default.
    const incremental = input.incremental !== false;
    const key = this.terminalStateKey(sandbox.id, input.name);
    const prev = this.terminalReadState.get(key);

    // Avoid unbounded memory growth: store at most the last N chars.
    const STATE_MAX_CHARS = 100_000;
    const snapshot = output.length > STATE_MAX_CHARS ? output.slice(-STATE_MAX_CHARS) : output;

    let mode: "full" | "delta" | "none" = "full";
    let payload = output;

    if (incremental && prev) {
      const delta = this.computeIncrementalDelta(output, prev.lastOutput);
      if (delta === "") {
        mode = "none";
        payload = "";
      } else if (delta === null) {
        mode = "full";
        payload = output;
      } else {
        mode = "delta";
        payload = delta;
      }
    }

    this.terminalReadState.set(key, {
      lastOutput: snapshot,
      lastReadAt: Date.now(),
    });

    const header = `# read_terminal terminal=${input.name} lines_requested=${linesRequested} chars=${output.length} mode=${mode}`;
    const begin =
      mode === "delta"
        ? "----- BEGIN TERMINAL NEW OUTPUT (delta) -----"
        : "----- BEGIN TERMINAL OUTPUT -----";
    const end =
      mode === "delta"
        ? "----- END TERMINAL NEW OUTPUT (delta) -----"
        : "----- END TERMINAL OUTPUT -----";

    if (!payload.trim()) {
      return `${header}\n${begin}\n${end}`;
    }

    const maybeNewline = payload.endsWith("\n") ? "" : "\n";
    return `${header}\n${begin}\n${payload}${maybeNewline}${end}`;
  }

  /**
   * List active terminal sessions
   */
  private async listTerminals(input: ListTerminalsInput): Promise<string> {
    const sandbox = this.getSandbox();
    const result = await sandbox.agentClient.listSessions();

    if (result.sessions.length === 0) {
      return "No active terminals. Use start_terminal to create one.";
    }

    const lines = result.sessions.map((s) => 
      `- ${s.name} (${s.windows} window${s.windows !== 1 ? "s" : ""})`
    );

    return `Active terminals:\n${lines.join("\n")}`;
  }

  /**
   * Kill a terminal session
   */
  private async killTerminal(input: KillTerminalInput): Promise<string> {
    const sandbox = this.getSandbox();
    const result = await sandbox.agentClient.killSession(input.name);

    if (!result.success) {
      return `Failed to kill terminal: ${result.error}`;
    }

    // Clear incremental read state for this terminal.
    this.terminalReadState.delete(this.terminalStateKey(sandbox.id, input.name));

    // Terminal stop often signals work is done.
    this.markWorkspaceDirty();
    this.scheduleAutoSync(1_000, "kill_terminal");

    this.logger.toolResult("kill_terminal", `Killed terminal: ${input.name}`);
    return `Terminal '${input.name}' terminated.`;
  }

  /**
   * Wait for a specified duration
   */
  private async wait(input: WaitInput): Promise<string> {
    this.logger.toolResult("wait", `Waiting ${input.duration}s: ${input.reason}`);
    
    await new Promise((resolve) => setTimeout(resolve, input.duration * 1000));
    
    return `Waited ${input.duration} seconds for: ${input.reason}`;
  }

  // ========== Docker handler ==========

  /**
   * Execute a Docker command in the project workspace
   */
  private async docker(input: DockerInput): Promise<string> {
    // Parse command into array of arguments
    const args = typeof input.command === "string"
      ? input.command.trim().split(/\s+/).filter(Boolean)
      : input.command;

    if (args.length === 0) {
      throw new Error("Docker command cannot be empty");
    }

    // Validate that it's a docker command (basic sanity check)
    const subcommand = args[0];
    if (!subcommand) {
      throw new Error("Docker command cannot be empty");
    }

    const validSubcommands = [
      "build", "run", "exec", "ps", "images", "logs", "stop", "start",
      "restart", "rm", "rmi", "pull", "push", "tag", "inspect", "network",
      "volume", "compose", "cp", "create", "kill", "pause", "unpause",
      "port", "stats", "top", "wait", "commit", "diff", "export", "import",
      "load", "save", "login", "logout", "search", "version", "info"
    ];

    if (!validSubcommands.includes(subcommand)) {
      throw new Error(`Invalid docker subcommand: ${subcommand}`);
    }

    // Auto-sync workspace from sandbox before build commands
    let syncMessage = "";
    if (subcommand === "build") {
      const activeSandbox = this.sandboxManager.getActiveSandbox();
      if (activeSandbox) {
        // For docker builds, we want the host build context to mirror the sandbox.
        const syncResult = await this.sandboxManager.syncFromSandbox(undefined, { mirror: true });
        this.lastAutoSyncAt = Date.now();
        this.autoSyncDirty = false;
        syncMessage = `[Auto-synced ${(syncResult.size / 1024).toFixed(1)}KB from sandbox to host]\n`;
        this.logger.debug("Auto-synced workspace before docker build");
      }
    }

    const result = await this.executeDockerCommand(args);
    this.logger.toolResult("docker", `docker ${args.join(" ").substring(0, 60)}`);
    return syncMessage + result;
  }

  /**
   * Execute a Docker command on the host
   */
  private async executeDockerCommand(args: string[]): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    try {
      const { stdout, stderr } = await execFileAsync("docker", args, {
        cwd: this.workspacePath,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 300000, // 5 minute timeout
      });

      const output = (stdout + (stderr || "")).trim();
      return output || "Command completed successfully.";
    } catch (error: any) {
      const errorMsg = error.stderr || error.message || "Unknown error";
      throw new Error(`Docker command failed: ${errorMsg}`);
    }
  }

  /**
   * Helper to get sandbox by ID or active sandbox
   */
  private getSandbox(sandboxId?: string) {
    const active = this.sandboxManager.getActiveSandbox();
    if (!active) {
      throw new Error("No active sandbox. Start one with start_sandbox first.");
    }
    return active;
  }

  /**
   * Ensure a path is a workspace-relative path.
   * Rejects absolute paths and any path that attempts directory traversal.
   */
  private sanitizeWorkspaceRelativePath(value: string, fieldName: string): string {
    const trimmed = value.trim();

    if (!trimmed) {
      throw new Error(`Invalid ${fieldName}: empty string`);
    }

    if (isAbsolute(trimmed)) {
      throw new Error(`Invalid ${fieldName}: absolute paths are not allowed`);
    }

    // Normalize and block traversal outside workspace.
    // We only allow paths that stay within the workspace root when resolved.
    const normalized = normalize(trimmed).replace(/\\/g, "/");
    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
      throw new Error(`Invalid ${fieldName}: path traversal is not allowed`);
    }

    return normalized;
  }
}

// Tool input types
interface StartSandboxInput {
  name?: string;
  sync_workspace?: boolean;
}

interface StopSandboxInput {
  sync_back?: boolean;
}

interface SyncWorkspaceInput {
  direction: "to_sandbox" | "from_sandbox";
}

interface SearchCodeInput {
  query: string;
  limit?: number;
}

interface PlanInput {
  steps: string[];
}

interface TaskCompleteInput {
  summary: string;
  lessons?: string[];
}

interface StartTerminalInput {
  name: string;
}

interface SendToTerminalInput {
  name: string;
  command: string;
}

interface ReadTerminalInput {
  name: string;
  lines?: number;
  /** When true (default), return only new output since last read for this terminal. */
  incremental?: boolean;
}

interface ListTerminalsInput {}

interface KillTerminalInput {
  name: string;
}

interface WaitInput {
  duration: number;
  reason: string;
}

interface DockerInput {
  command: string | string[];
}
