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

  constructor(config: ToolHandlersConfig) {
    this.sandboxManager = config.sandboxManager;
    this.episodicMemory = config.episodicMemory;
    this.semanticMemory = config.semanticMemory;
    this.workspacePath = config.workspacePath;
    this.logger = config.logger;
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

      case "list_sandboxes":
        return await this.listSandboxes();

      case "sync_workspace":
        return await this.syncWorkspace(input as SyncWorkspaceInput);

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

      case "docker-build":
        return await this.dockerBuild(input as DockerBuildInput);

      case "docker-run":
        return await this.dockerRun(input as DockerRunInput);

      case "docker-push":
        return await this.dockerPush(input as DockerPushInput);

      case "docker-stop":
        return await this.dockerStop(input as DockerStopInput);

      case "docker-logs":
        return await this.dockerLogs(input as DockerLogsInput);

      case "task_complete":
        return await this.completeTask(taskId, input as TaskCompleteInput);

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  /**
   * Start a new sandbox VM
   */
  private async startSandbox(input: StartSandboxInput): Promise<string> {
    const sandbox = await this.sandboxManager.startSandbox(input.name);

    // Sync workspace by default unless explicitly disabled
    if (input.sync_workspace !== false) {
      const syncResult = await this.sandboxManager.syncToSandbox(sandbox.id);
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
    const sandboxId = input.sandbox_id;

    if (sandboxId) {
      await this.sandboxManager.stopSandbox(sandboxId, syncBack);
      return `Sandbox ${sandboxId} stopped. Workspace ${syncBack ? "synced back" : "not synced"}.`;
    } else {
      const activeSandbox = this.sandboxManager.getActiveSandbox();
      if (!activeSandbox) {
        return "No active sandbox to stop.";
      }
      await this.sandboxManager.stopSandbox(activeSandbox.id, syncBack);
      return `Sandbox ${activeSandbox.id} stopped. Workspace ${syncBack ? "synced back" : "not synced"}.`;
    }
  }

  /**
   * List all running sandboxes
   */
  private async listSandboxes(): Promise<string> {
    const sandboxes = await this.sandboxManager.listSandboxes();

    if (sandboxes.length === 0) {
      return "No sandboxes running. Use start_sandbox to create one.";
    }

    const activeSandbox = this.sandboxManager.getActiveSandbox();
    const lines = sandboxes.map((sb) => {
      const isActive = activeSandbox?.id === sb.id ? " [ACTIVE]" : "";
      return `- ${sb.id}${sb.name ? ` (${sb.name})` : ""}${isActive}
  IP: ${sb.guestIp || "no network"}
  Uptime: ${sb.uptime.toFixed(0)}s
  Workspace: ${sb.workspaceSynced ? "synced" : "not synced"}`;
    });

    return `Running sandboxes:\n${lines.join("\n")}`;
  }

  /**
   * Sync workspace between host and sandbox
   */
  private async syncWorkspace(input: SyncWorkspaceInput): Promise<string> {
    if (input.direction === "to_sandbox") {
      const result = await this.sandboxManager.syncToSandbox(input.sandbox_id);
      return `Synced ${result.filesWritten} files to sandbox.`;
    } else {
      const result = await this.sandboxManager.syncFromSandbox(input.sandbox_id);
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
    const sandbox = this.getSandbox(input.sandbox_id);
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
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.sendToSession(input.name, input.command);

    if (!result.success) {
      return `Failed to send to terminal: ${result.error}`;
    }

    this.logger.toolResult("send_to_terminal", `Sent to ${input.name}: ${input.command.substring(0, 50)}...`);
    return `Command sent to terminal '${input.name}'.\nUse read_terminal to check output.`;
  }

  /**
   * Read output from a terminal session
   */
  private async readTerminal(input: ReadTerminalInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.readSession(input.name, input.lines);

    if (!result.success) {
      return `Failed to read terminal: ${result.error}`;
    }

    const preview = result.output.substring(0, 200);
    this.logger.toolResult("read_terminal", `${preview}${result.output.length > 200 ? "..." : ""}`);
    return result.output || "[no output]";
  }

  /**
   * List active terminal sessions
   */
  private async listTerminals(input: ListTerminalsInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
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
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.killSession(input.name);

    if (!result.success) {
      return `Failed to kill terminal: ${result.error}`;
    }

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

  // ========== Docker handlers ==========

  /**
   * Build a Docker image
   */
  private async dockerBuild(input: DockerBuildInput): Promise<string> {
    const args: string[] = ["build"];

    const notices: string[] = [];

    // Add dockerfile path
    if (input.dockerfile) {
      const dockerfile = this.sanitizeWorkspaceRelativePath(input.dockerfile, "dockerfile");
      args.push("-f", dockerfile);
    }

    // Add tags
    for (const tag of input.tags) {
      args.push("-t", tag);
    }

    // Add build args
    if (input.build_args) {
      for (const [key, value] of Object.entries(input.build_args)) {
        args.push("--build-arg", `${key}=${value}`);
      }
    }

    // Keep the surface area small: additional_args are ignored by design.
    if (input.additional_args) {
      notices.push("Ignored additional_args (not supported; use structured parameters only).");
    }

    // Always use workspace root as context
    args.push(".");

    const result = await this.executeDockerCommand(args);
    this.logger.toolResult("docker-build", `Built image(s): ${input.tags.join(", ")}`);
    return notices.length > 0 ? `${notices.join(" ")}\n${result}` : result;
  }

  /**
   * Run a Docker container
   */
  private async dockerRun(input: DockerRunInput): Promise<string> {
    const args: string[] = ["run"];

    const notices: string[] = [];

    // Add detach mode
    if (input.detach !== false) {
      args.push("-d");
    }

    // Add name
    if (input.name) {
      args.push("--name", input.name);
    }

    // Add port mappings
    if (input.ports) {
      for (const port of input.ports) {
        args.push("-p", port);
      }
    }

    // Volumes are intentionally not supported to keep docker tools constrained.
    if (input.volumes && input.volumes.length > 0) {
      notices.push("Ignored volumes (not supported by this tool).");
    }

    // Add environment variables
    if (input.environment) {
      for (const [key, value] of Object.entries(input.environment)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Keep the surface area small: additional_args are ignored by design.
    if (input.additional_args) {
      notices.push("Ignored additional_args (not supported; use structured parameters only).");
    }

    // Add image
    args.push(input.image);

    // Add command
    if (input.command) {
      args.push(...input.command.split(/\s+/).filter(Boolean));
    }

    const result = await this.executeDockerCommand(args);
    this.logger.toolResult("docker-run", `Started container${input.name ? " " + input.name : ""} from ${input.image}`);
    return notices.length > 0 ? `${notices.join(" ")}\n${result}` : result;
  }

  /**
   * Push a Docker image
   */
  private async dockerPush(input: DockerPushInput): Promise<string> {
    const args: string[] = ["push"];

    const notices: string[] = [];

    if (input.additional_args) {
      notices.push("Ignored additional_args (not supported; use structured parameters only).");
    }

    // Add image
    args.push(input.image);

    const result = await this.executeDockerCommand(args);
    this.logger.toolResult("docker-push", `Pushed image: ${input.image}`);
    return notices.length > 0 ? `${notices.join(" ")}\n${result}` : result;
  }

  /**
   * Stop Docker containers
   */
  private async dockerStop(input: DockerStopInput): Promise<string> {
    const args: string[] = ["stop"];

    const notices: string[] = [];

    // Add timeout
    if (input.timeout !== undefined) {
      args.push("-t", input.timeout.toString());
    }

    if (input.additional_args) {
      notices.push("Ignored additional_args (not supported; use structured parameters only).");
    }

    // Add containers
    args.push(...input.containers);

    const result = await this.executeDockerCommand(args);
    this.logger.toolResult("docker-stop", `Stopped container(s): ${input.containers.join(", ")}`);
    return notices.length > 0 ? `${notices.join(" ")}\n${result}` : result;
  }

  /**
   * Get Docker container logs
   */
  private async dockerLogs(input: DockerLogsInput): Promise<string> {
    const args: string[] = ["logs"];

    const notices: string[] = [];

    // Add follow
    if (input.follow) {
      args.push("-f");
    }

    // Add tail
    if (input.tail !== undefined) {
      args.push("--tail", input.tail.toString());
    }

    // Add since
    if (input.since) {
      args.push("--since", input.since);
    }

    // Add timestamps
    if (input.timestamps) {
      args.push("-t");
    }

    if (input.additional_args) {
      notices.push("Ignored additional_args (not supported; use structured parameters only).");
    }

    // Add container
    args.push(input.container);

    const result = await this.executeDockerCommand(args);
    this.logger.toolResult("docker-logs", `Retrieved logs from: ${input.container}`);
    return notices.length > 0 ? `${notices.join(" ")}\n${result}` : result;
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
    if (sandboxId) {
      const sandbox = this.sandboxManager.getSandbox(sandboxId);
      if (!sandbox) {
        throw new Error(`Sandbox not found: ${sandboxId}`);
      }
      return sandbox;
    }
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
  sandbox_id?: string;
  sync_back?: boolean;
}

interface SyncWorkspaceInput {
  direction: "to_sandbox" | "from_sandbox";
  sandbox_id?: string;
}

interface SearchCodeInput {
  query: string;
  limit?: number;
}

interface TaskCompleteInput {
  summary: string;
  lessons?: string[];
}

interface StartTerminalInput {
  name: string;
  sandbox_id?: string;
}

interface SendToTerminalInput {
  name: string;
  command: string;
  sandbox_id?: string;
}

interface ReadTerminalInput {
  name: string;
  lines?: number;
  sandbox_id?: string;
}

interface ListTerminalsInput {
  sandbox_id?: string;
}

interface KillTerminalInput {
  name: string;
  sandbox_id?: string;
}

interface WaitInput {
  duration: number;
  reason: string;
}

interface DockerBuildInput {
  dockerfile?: string;
  tags: string[];
  build_args?: Record<string, string>;
  /** Ignored: use structured parameters only */
  additional_args?: string;
}

interface DockerRunInput {
  image: string;
  name?: string;
  ports?: string[];
  /** Ignored: not supported */
  volumes?: string[];
  environment?: Record<string, string>;
  detach?: boolean;
  command?: string;
  /** Ignored: use structured parameters only */
  additional_args?: string;
}

interface DockerPushInput {
  image: string;
  /** Ignored: use structured parameters only */
  additional_args?: string;
}

interface DockerStopInput {
  containers: string[];
  timeout?: number;
  /** Ignored: use structured parameters only */
  additional_args?: string;
}

interface DockerLogsInput {
  container: string;
  follow?: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
  /** Ignored: use structured parameters only */
  additional_args?: string;
}
