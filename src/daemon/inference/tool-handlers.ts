/**
 * Tool handlers for executing agent tools
 */

import type { SandboxManager } from "../sandbox.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { SemanticMemory } from "../memory/semantic.ts";
import type { Logger } from "@shared/logger.ts";
import { EXECUTION, LLM } from "@shared/constants.ts";
import type { ToolName } from "./tools.ts";

export interface ToolHandlersConfig {
  sandboxManager: SandboxManager;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  logger: Logger;
}

/**
 * Handles execution of agent tools
 */
export class ToolHandlers {
  private readonly sandboxManager: SandboxManager;
  private readonly episodicMemory: EpisodicMemory;
  private readonly semanticMemory: SemanticMemory;
  private readonly logger: Logger;

  constructor(config: ToolHandlersConfig) {
    this.sandboxManager = config.sandboxManager;
    this.episodicMemory = config.episodicMemory;
    this.semanticMemory = config.semanticMemory;
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

      case "run_cmd":
        return await this.runCommand(input as RunCommandInput);

      case "search_code":
        return await this.searchCode(input as SearchCodeInput);

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
   * Execute a command in a sandbox
   */
  private async runCommand(input: RunCommandInput): Promise<string> {
    const result = await this.sandboxManager.executeInSandbox(input.command, {
      sandboxId: input.sandbox_id,
      timeout: input.timeout || EXECUTION.DEFAULT_TIMEOUT,
    });

    const preview = result.stdout.substring(0, 200);
    this.logger.toolResult(
      "run_cmd",
      `${preview}${result.stdout.length > 200 ? "..." : ""}`
    );

    // Format output
    let output = "";
    if (result.stdout) {
      output += result.stdout;
    }
    if (result.stderr) {
      output += `\n[stderr]\n${result.stderr}`;
    }
    output += `\n[exit code: ${result.exitCode}]`;
    if (result.timedOut) {
      output += "\n[TIMED OUT]";
    }

    return output;
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

interface RunCommandInput {
  command: string;
  sandbox_id?: string;
  timeout?: number;
}

interface SearchCodeInput {
  query: string;
  limit?: number;
}

interface TaskCompleteInput {
  summary: string;
  lessons?: string[];
}
