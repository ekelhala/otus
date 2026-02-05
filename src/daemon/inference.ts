/**
 * Inference Engine
 * Manages the ReAct loop with Claude and tool execution
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LLM, EXECUTION } from "@shared/constants.ts";
import type { SandboxManager } from "./sandbox.ts";
import type { EpisodicMemory } from "./memory/episodic.ts";
import type { SemanticMemory } from "./memory/semantic.ts";

/**
 * Track executed actions for repetition detection
 */
interface ActionRecord {
  tool: string;
  inputHash: string;
  iteration: number;
}

/** Max times same action can repeat before intervention */
const MAX_REPETITIONS = 3;
/** Window of recent actions to consider for stuck detection */
const REPETITION_WINDOW = 10;

export interface InferenceEngineConfig {
  apiKey: string;
  sandboxManager: SandboxManager;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  workspacePath: string;
}

/**
 * Tool definitions for Claude
 */
const tools: Anthropic.Tool[] = [
  {
    name: "start_sandbox",
    description:
      "Start a new isolated VM sandbox environment. The sandbox provides a safe Linux environment for executing commands. You must start a sandbox before running commands. You can have multiple sandboxes running simultaneously for testing different configurations.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Optional human-readable name for this sandbox (e.g., 'testing', 'build-env')",
        },
        sync_workspace: {
          type: "boolean",
          description: "Whether to sync the workspace files to the sandbox immediately (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "stop_sandbox",
    description:
      "Stop and destroy a sandbox VM. Any unsaved changes in the sandbox will be lost unless you sync back first.",
    input_schema: {
      type: "object",
      properties: {
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox to stop. If not provided, stops the active sandbox.",
        },
        sync_back: {
          type: "boolean",
          description: "Whether to sync workspace changes back to host before stopping (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_sandboxes",
    description:
      "List all running sandboxes with their status, uptime, and IP addresses.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "sync_workspace",
    description:
      "Sync workspace files between host and sandbox. Use 'to_sandbox' to push files to the VM, or 'from_sandbox' to pull changes back to host.",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["to_sandbox", "from_sandbox"],
          description: "Direction of sync: 'to_sandbox' pushes host files to VM, 'from_sandbox' pulls VM changes to host",
        },
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox to sync with. If not provided, uses the active sandbox.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "run_cmd",
    description:
      "Execute a shell command in a sandbox VM. The shell is PERSISTENT within each sandbox - environment changes (cd, export, source) persist between calls. You must start a sandbox first. Commands BLOCK until completion or timeout. For long-running processes (servers, watch modes), use & to background them. Working directory starts at /workspace (contains project files) but persists if you cd elsewhere.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute. Environment persists between calls. Use & to background long-running processes.",
        },
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox to run in. If not provided, uses the active sandbox.",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 300). Command is killed if exceeded.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "search_code",
    description:
      "Semantically search the codebase for relevant code snippets. Use this to find existing implementations, understand architecture, or locate relevant files.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query describing what code you're looking for",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "task_complete",
    description:
      "Signal that the current task/request has been completed. Include a summary of what was accomplished. This ends the current turn and returns control to the user.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "A brief summary of what was accomplished",
        },
        lessons: {
          type: "array",
          items: { type: "string" },
          description: "Key lessons learned or important notes",
        },
      },
      required: ["summary"],
    },
  },
];

/**
 * Inference Engine implementing the ReAct loop
 */
export class InferenceEngine {
  private readonly client: Anthropic;
  private readonly sandboxManager: SandboxManager;
  private readonly episodicMemory: EpisodicMemory;
  private readonly semanticMemory: SemanticMemory;
  private readonly workspacePath: string;
  private actionHistory: ActionRecord[] = [];
  /** Conversation history for interactive mode */
  private messages: Anthropic.MessageParam[] = [];
  /** Current session ID */
  private sessionId: string = "";

  constructor(config: InferenceEngineConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.sandboxManager = config.sandboxManager;
    this.episodicMemory = config.episodicMemory;
    this.semanticMemory = config.semanticMemory;
    this.workspacePath = config.workspacePath;
  }

  /**
   * Start a new interactive session
   */
  startSession(): string {
    this.sessionId = `session-${Date.now()}`;
    this.messages = [];
    this.actionHistory = [];
    
    // Create session in episodic memory
    this.episodicMemory.createTask(this.sessionId, "Interactive session");
    
    console.log(`[InferenceEngine] Started session: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * Process a user message in interactive mode
   * Returns when the agent completes its turn (calls task_complete or needs user input)
   */
  async chat(userMessage: string): Promise<{ complete: boolean; summary?: string }> {
    if (!this.sessionId) {
      this.startSession();
    }

    console.log(`\n[InferenceEngine] Processing: ${userMessage.substring(0, 100)}${userMessage.length > 100 ? "..." : ""}`);

    // Add user message to conversation
    const fullMessage = this.messages.length === 0
      ? this.buildInitialPrompt(userMessage)
      : userMessage;

    this.messages.push({
      role: "user",
      content: fullMessage,
    });

    let iteration = 0;
    let turnComplete = false;
    let completionSummary: string | undefined;
    let consecutiveStuckCount = 0;

    while (iteration < EXECUTION.MAX_ITERATIONS && !turnComplete) {
      iteration++;
      console.log(`\n[InferenceEngine] Iteration ${iteration}/${EXECUTION.MAX_ITERATIONS}`);

      // Log thinking phase
      this.episodicMemory.logEvent(this.sessionId, "think", {
        iteration,
        context: "Processing user request",
      });

      // Call Claude
      const response = await this.client.messages.create({
        model: LLM.MODEL,
        max_tokens: LLM.MAX_TOKENS,
        messages: this.messages,
        tools,
      });

      // Add assistant response to messages
      this.messages.push({
        role: "assistant",
        content: response.content,
      });

      // Process response
      const { toolCalls, textContent } = this.parseResponse(response);

      // Log any text output (thinking)
      if (textContent) {
        console.log(`\n[Claude] ${textContent}`);
        this.episodicMemory.logEvent(this.sessionId, "think", {
          iteration,
          thought: textContent,
        });
      }

      // Check if Claude wants to stop (no tool calls and end_turn)
      if (toolCalls.length === 0 && response.stop_reason === "end_turn") {
        // Claude is done with its turn
        turnComplete = true;
        continue;
      }

      // Execute tool calls
      if (toolCalls.length > 0) {
        const toolResults: Anthropic.MessageParam = {
          role: "user",
          content: [],
        };

        // Check for repetition before executing
        const repetitionWarning = this.checkForRepetition(toolCalls, iteration);
        if (repetitionWarning) {
          consecutiveStuckCount++;
          console.log(`\n[InferenceEngine] Repetition detected (${consecutiveStuckCount}x)`);
          
          if (consecutiveStuckCount >= 3) {
            // Force a reflection break
            console.log(`\n[InferenceEngine] Forcing reflection due to repeated stuck state`);
            this.messages.push({
              role: "user",
              content: this.buildStuckRecoveryPrompt(repetitionWarning),
            });
            continue; // Skip execution, get new response
          }
        } else {
          consecutiveStuckCount = 0;
        }

        for (const toolCall of toolCalls) {
          console.log(`\n[Tool] ${toolCall.name}(${JSON.stringify(toolCall.input)})`);

          // Track this action
          this.recordAction(toolCall, iteration);

          // Log action
          this.episodicMemory.logEvent(this.sessionId, "act", {
            iteration,
            tool: toolCall.name,
            input: toolCall.input,
          });

          try {
            const result = await this.executeTool(this.sessionId, toolCall);

            // Check if task is complete
            if (toolCall.name === "task_complete") {
              turnComplete = true;
              completionSummary = (toolCall.input as any).summary;
              console.log(`\n[InferenceEngine] Turn complete: ${completionSummary}`);
            }

            // Add tool result
            (toolResults.content as Anthropic.ToolResultBlockParam[]).push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: typeof result === "string" ? result : JSON.stringify(result),
            });

            // Log observation
            this.episodicMemory.logEvent(this.sessionId, "observe", {
              iteration,
              tool: toolCall.name,
              result,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`\n[Tool Error] ${errorMessage}`);

            (toolResults.content as Anthropic.ToolResultBlockParam[]).push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: `Error: ${errorMessage}`,
              is_error: true,
            });

            this.episodicMemory.logEvent(this.sessionId, "observe", {
              iteration,
              tool: toolCall.name,
              error: errorMessage,
            });
          }
        }

        this.messages.push(toolResults);

        // Inject action summary periodically to help Claude track progress
        if (iteration % 5 === 0 && iteration > 0) {
          const summary = this.summarizeRecentActions();
          if (summary) {
            this.messages.push({
              role: "user",
              content: `[Progress Check] You've completed ${iteration} iterations. Recent actions:\n${summary}\n\nContinue working toward the goal.`,
            });
          }
        }
      } else {
        // No tool calls and didn't end turn, prompt for action
        consecutiveStuckCount++;
        console.log(`\n[InferenceEngine] No tool calls made (${consecutiveStuckCount}x), prompting for action`);
        
        const actionSummary = this.summarizeRecentActions();
        this.messages.push({
          role: "user",
          content: `Please take an action using one of the available tools to make progress, or call task_complete if you're done.${actionSummary ? `\n\nHere's what you've already tried:\n${actionSummary}` : ""}`,
        });
      }
    }

    if (iteration >= EXECUTION.MAX_ITERATIONS) {
      console.log("\n[InferenceEngine] Max iterations reached");
      this.episodicMemory.logEvent(this.sessionId, "reflect", {
        status: "incomplete",
        reason: "max_iterations_reached",
        iterations: iteration,
      });
    }

    return { complete: turnComplete, summary: completionSummary };
  }

  /**
   * Legacy method for single-task execution (wraps chat)
   */
  async executeTask(taskId: string, goal: string): Promise<void> {
    this.sessionId = taskId;
    this.messages = [];
    this.actionHistory = [];
    
    this.episodicMemory.createTask(taskId, goal);
    
    await this.chat(goal);
  }

  /**
   * Execute a tool call
   */
  private async executeTool(
    taskId: string,
    toolCall: Anthropic.ToolUseBlock
  ): Promise<any> {
    switch (toolCall.name) {
      case "start_sandbox":
        return await this.startSandbox(toolCall.input as any);

      case "stop_sandbox":
        return await this.stopSandbox(toolCall.input as any);

      case "list_sandboxes":
        return await this.listSandboxes();

      case "sync_workspace":
        return await this.syncWorkspace(toolCall.input as any);

      case "run_cmd":
        return await this.executeCommand(toolCall.input as any);

      case "search_code":
        return await this.searchCode(toolCall.input as any);

      case "task_complete":
        return await this.completeTask(taskId, toolCall.input as any);

      default:
        throw new Error(`Unknown tool: ${toolCall.name}`);
    }
  }

  /**
   * Start a new sandbox VM
   */
  private async startSandbox(input: {
    name?: string;
    sync_workspace?: boolean;
  }): Promise<string> {
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
  private async stopSandbox(input: {
    sandbox_id?: string;
    sync_back?: boolean;
  }): Promise<string> {
    const syncBack = input.sync_back !== false; // Default true
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
  private async syncWorkspace(input: {
    direction: "to_sandbox" | "from_sandbox";
    sandbox_id?: string;
  }): Promise<string> {
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
  private async executeCommand(input: {
    command: string;
    sandbox_id?: string;
    timeout?: number;
  }): Promise<string> {
    const result = await this.sandboxManager.executeInSandbox(input.command, {
      sandboxId: input.sandbox_id,
      timeout: input.timeout || EXECUTION.DEFAULT_TIMEOUT,
    });
    console.log(`\n[Command Result] stdout: ${result.stdout.substring(0, 200)}${result.stdout.length > 200 ? "..." : ""}`);

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
  private async searchCode(input: { query: string; limit?: number }): Promise<string> {
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
    input: { summary: string; lessons?: string[] }
  ): Promise<string> {
    this.episodicMemory.updateTaskStatus(taskId, "completed");
    this.episodicMemory.saveReflection(
      taskId,
      input.summary,
      input.lessons || []
    );

    return "Task marked as complete";
  }

  /**
   * Build the initial prompt with context
   */
  private buildInitialPrompt(goal: string): string {
    return `You are Otus, an autonomous system engineering agent. You can create isolated Linux VM sandboxes to safely execute commands.

Your request: ${goal}

Available tools:
1. start_sandbox: Start a new VM sandbox (required before running commands)
2. stop_sandbox: Stop a sandbox VM
3. list_sandboxes: List running sandboxes
4. sync_workspace: Sync files between host and sandbox
5. run_cmd: Execute shell commands in a sandbox. The shell is persistent, so environment changes persist between calls. Use & to background long-running processes.
6. search_code: Semantically search the codebase
7. task_complete: Signal when you're done (returns control to user)

Workflow:
1. Start a sandbox with start_sandbox (this boots a VM and syncs workspace)
2. Execute commands with run_cmd to implement, test, or investigate. Run commands in sequence to build on previous results. Use the persistent shell to maintain state.
3. Search the codebase with search_code if needed
4. Use sync_workspace to push/pull file changes
5. When done, call task_complete with a summary

You can have multiple sandboxes for different purposes (e.g., testing different configurations).

Think carefully about each action. Be methodical and verify your work.

Begin by analyzing the request and deciding on your first action.`;
  }

  /**
   * Parse Claude's response into text and tool calls
   */
  private parseResponse(response: Anthropic.Message): {
    toolCalls: Anthropic.ToolUseBlock[];
    textContent: string;
  } {
    const toolCalls: Anthropic.ToolUseBlock[] = [];
    let textContent = "";

    for (const content of response.content) {
      if (content.type === "text") {
        textContent += content.text;
      } else if (content.type === "tool_use") {
        toolCalls.push(content);
      }
    }

    return { toolCalls, textContent: textContent.trim() };
  }

  /**
   * Create a hash of tool input for comparison
   */
  private hashInput(input: unknown): string {
    return JSON.stringify(input);
  }

  /**
   * Record an action in the history
   */
  private recordAction(toolCall: Anthropic.ToolUseBlock, iteration: number): void {
    this.actionHistory.push({
      tool: toolCall.name,
      inputHash: this.hashInput(toolCall.input),
      iteration,
    });

    // Keep history bounded
    if (this.actionHistory.length > 100) {
      this.actionHistory = this.actionHistory.slice(-50);
    }
  }

  /**
   * Check if the proposed tool calls are repetitive
   * Returns a warning message if repetition detected, null otherwise
   */
  private checkForRepetition(
    toolCalls: Anthropic.ToolUseBlock[],
    currentIteration: number
  ): string | null {
    const recentActions = this.actionHistory.slice(-REPETITION_WINDOW);
    
    for (const toolCall of toolCalls) {
      const inputHash = this.hashInput(toolCall.input);
      const matchingActions = recentActions.filter(
        (a) => a.tool === toolCall.name && a.inputHash === inputHash
      );

      if (matchingActions.length >= MAX_REPETITIONS) {
        const inputStr = JSON.stringify(toolCall.input);
        const truncatedInput = inputStr.length > 100 
          ? inputStr.substring(0, 100) + "..." 
          : inputStr;
        return `You've already called ${toolCall.name}(${truncatedInput}) ${matchingActions.length} times with the same input. This suggests you might be stuck in a loop.`;
      }
    }

    return null;
  }

  /**
   * Summarize recent actions for context
   */
  private summarizeRecentActions(): string {
    if (this.actionHistory.length === 0) return "";

    const recent = this.actionHistory.slice(-10);
    const grouped = new Map<string, number>();

    for (const action of recent) {
      const key = action.tool;
      grouped.set(key, (grouped.get(key) || 0) + 1);
    }

    const lines: string[] = [];
    for (const [tool, count] of grouped) {
      lines.push(`- ${tool}: called ${count}x`);
    }

    // Show last 3 unique commands if run_cmd was used
    const cmdActions = recent
      .filter((a) => a.tool === "run_cmd")
      .map((a) => {
        try {
          const input = JSON.parse(a.inputHash);
          return input.command;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const uniqueCmds = [...new Set(cmdActions)].slice(-3);
    if (uniqueCmds.length > 0) {
      lines.push(`\nRecent commands: ${uniqueCmds.join(", ")}`);
    }

    return lines.join("\n");
  }

  /**
   * Build a prompt to help break out of stuck state
   */
  private buildStuckRecoveryPrompt(repetitionWarning: string): string {
    const actionSummary = this.summarizeRecentActions();
    
    return `IMPORTANT: ${repetitionWarning}

You appear to be stuck in a loop. Please:
1. STOP and reflect on why previous attempts didn't work
2. Try a DIFFERENT approach or command
3. If a command keeps failing, investigate WHY before retrying
4. Consider if there's a prerequisite step you're missing

${actionSummary ? `Your recent actions:\n${actionSummary}` : ""}

What alternative approach can you try?`;
  }
}
