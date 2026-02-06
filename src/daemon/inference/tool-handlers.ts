/**
 * Tool handlers for executing agent tools
 */

import type { SandboxManager } from "../sandbox.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { SemanticMemory } from "../memory/semantic.ts";
import type { Logger } from "@shared/logger.ts";
import { LLM } from "@shared/constants.ts";
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

      case "start_session":
        return await this.startSession(input as StartSessionInput);

      case "send_to_session":
        return await this.sendToSession(input as SendToSessionInput);

      case "read_session":
        return await this.readSession(input as ReadSessionInput);

      case "list_sessions":
        return await this.listSessions(input as ListSessionsInput);

      case "kill_session":
        return await this.killSession(input as KillSessionInput);

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

  // ========== Session handlers ==========

  /**
   * Start a tmux session in the sandbox
   */
  private async startSession(input: StartSessionInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.startSession(input.name);

    if (!result.success) {
      return `Failed to start session: ${result.error}`;
    }

    this.logger.toolResult("start_session", `Started session: ${input.name}`);
    return `Session '${input.name}' started successfully.\nUse send_to_session to run commands in this session.`;
  }

  /**
   * Send a command to a tmux session
   */
  private async sendToSession(input: SendToSessionInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.sendToSession(input.name, input.command);

    if (!result.success) {
      return `Failed to send to session: ${result.error}`;
    }

    this.logger.toolResult("send_to_session", `Sent to ${input.name}: ${input.command.substring(0, 50)}...`);
    return `Command sent to session '${input.name}'.\nUse read_session to check output.`;
  }

  /**
   * Read output from a tmux session
   */
  private async readSession(input: ReadSessionInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.readSession(input.name, input.lines);

    if (!result.success) {
      return `Failed to read session: ${result.error}`;
    }

    const preview = result.output.substring(0, 200);
    this.logger.toolResult("read_session", `${preview}${result.output.length > 200 ? "..." : ""}`);
    return result.output || "[no output]";
  }

  /**
   * List active tmux sessions
   */
  private async listSessions(input: ListSessionsInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.listSessions();

    if (result.sessions.length === 0) {
      return "No active sessions. Use start_session to create one.";
    }

    const lines = result.sessions.map((s) => 
      `- ${s.name} (${s.windows} window${s.windows !== 1 ? "s" : ""})`
    );

    return `Active sessions:\n${lines.join("\n")}`;
  }

  /**
   * Kill a tmux session
   */
  private async killSession(input: KillSessionInput): Promise<string> {
    const sandbox = this.getSandbox(input.sandbox_id);
    const result = await sandbox.agentClient.killSession(input.name);

    if (!result.success) {
      return `Failed to kill session: ${result.error}`;
    }

    this.logger.toolResult("kill_session", `Killed session: ${input.name}`);
    return `Session '${input.name}' terminated.`;
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

interface StartSessionInput {
  name: string;
  sandbox_id?: string;
}

interface SendToSessionInput {
  name: string;
  command: string;
  sandbox_id?: string;
}

interface ReadSessionInput {
  name: string;
  lines?: number;
  sandbox_id?: string;
}

interface ListSessionsInput {
  sandbox_id?: string;
}

interface KillSessionInput {
  name: string;
  sandbox_id?: string;
}
