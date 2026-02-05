/**
 * Inference Engine
 * Manages the ReAct loop with Claude and tool execution
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { LLM, EXECUTION } from "@shared/constants.ts";
import type { GuestAgentClient } from "./vsock.ts";
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
  agentClient: GuestAgentClient;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  workspacePath: string;
}

/**
 * Tool definitions for Claude
 */
const tools: Anthropic.Tool[] = [
  {
    name: "run_cmd",
    description:
      "Execute a shell command in the isolated VM sandbox. Use this to run commands, install packages, test code, etc. The command runs in /workspace which contains the project files.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 300)",
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
      "Signal that the task has been completed successfully. Include a summary of what was accomplished and key takeaways.",
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
  private readonly agentClient: GuestAgentClient;
  private readonly episodicMemory: EpisodicMemory;
  private readonly semanticMemory: SemanticMemory;
  private readonly workspacePath: string;
  private actionHistory: ActionRecord[] = [];

  constructor(config: InferenceEngineConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.agentClient = config.agentClient;
    this.episodicMemory = config.episodicMemory;
    this.semanticMemory = config.semanticMemory;
    this.workspacePath = config.workspacePath;
  }

  /**
   * Execute a task using the ReAct loop
   */
  async executeTask(taskId: string, goal: string): Promise<void> {
    console.log(`\n[InferenceEngine] Starting task: ${goal}`);

    // Reset action history for new task
    this.actionHistory = [];

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: this.buildInitialPrompt(goal),
      },
    ];

    let iteration = 0;
    let taskComplete = false;
    let consecutiveStuckCount = 0;

    while (iteration < EXECUTION.MAX_ITERATIONS && !taskComplete) {
      iteration++;
      console.log(`\n[InferenceEngine] Iteration ${iteration}/${EXECUTION.MAX_ITERATIONS}`);

      // Log thinking phase
      this.episodicMemory.logEvent(taskId, "think", {
        iteration,
        context: "Starting iteration",
      });

      // Call Claude
      const response = await this.client.messages.create({
        model: LLM.MODEL,
        max_tokens: LLM.MAX_TOKENS,
        messages,
        tools,
      });

      // Add assistant response to messages
      messages.push({
        role: "assistant",
        content: response.content,
      });

      // Process response
      const { toolCalls, textContent } = this.parseResponse(response);

      // Log any text output (thinking)
      if (textContent) {
        console.log(`\n[Claude] ${textContent}`);
        this.episodicMemory.logEvent(taskId, "think", {
          iteration,
          thought: textContent,
        });
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
            messages.push({
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
          this.episodicMemory.logEvent(taskId, "act", {
            iteration,
            tool: toolCall.name,
            input: toolCall.input,
          });

          try {
            const result = await this.executeTool(taskId, toolCall);

            // Check if task is complete
            if (toolCall.name === "task_complete") {
              taskComplete = true;
              console.log(`\n[InferenceEngine] Task completed: ${result}`);
            }

            // Add tool result
            (toolResults.content as Anthropic.ToolResultBlockParam[]).push({
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: typeof result === "string" ? result : JSON.stringify(result),
            });

            // Log observation
            this.episodicMemory.logEvent(taskId, "observe", {
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

            this.episodicMemory.logEvent(taskId, "observe", {
              iteration,
              tool: toolCall.name,
              error: errorMessage,
            });
          }
        }

        messages.push(toolResults);

        // Inject action summary periodically to help Claude track progress
        if (iteration % 5 === 0 && iteration > 0) {
          const summary = this.summarizeRecentActions();
          if (summary) {
            messages.push({
              role: "user",
              content: `[Progress Check] You've completed ${iteration} iterations. Recent actions:\n${summary}\n\nContinue working toward the goal.`,
            });
          }
        }
      } else {
        // No tool calls, task might be stuck
        consecutiveStuckCount++;
        console.log(`\n[InferenceEngine] No tool calls made (${consecutiveStuckCount}x), prompting for action`);
        
        const actionSummary = this.summarizeRecentActions();
        messages.push({
          role: "user",
          content: `Please take an action using one of the available tools to make progress on the task.${actionSummary ? `\n\nHere's what you've already tried:\n${actionSummary}` : ""}`,
        });
      }
    }

    if (!taskComplete) {
      console.log("\n[InferenceEngine] Max iterations reached without completion");
      this.episodicMemory.logEvent(taskId, "reflect", {
        status: "incomplete",
        reason: "max_iterations_reached",
        iterations: iteration,
      });
    }
  }

  /**
   * Execute a tool call
   */
  private async executeTool(
    taskId: string,
    toolCall: Anthropic.ToolUseBlock
  ): Promise<any> {
    switch (toolCall.name) {
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
   * Execute a command in the VM
   */
  private async executeCommand(input: {
    command: string;
    timeout?: number;
  }): Promise<string> {
    const result = await this.agentClient.execute(input.command, {
      timeout: input.timeout || EXECUTION.DEFAULT_TIMEOUT,
    });

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
    return `You are Otus, an autonomous system engineering agent. You have access to an isolated Linux VM where you can safely execute commands.

Your goal: ${goal}

You have three tools available:
1. run_cmd: Execute shell commands in the VM
2. search_code: Semantically search the codebase
3. task_complete: Signal when the task is finished

Working directory: The VM has access to /workspace which contains the project files.

Approach:
1. Understand the goal and break it down into steps
2. Search the codebase to understand existing code
3. Execute commands to implement, test, or investigate
4. Iterate based on results
5. When complete, call task_complete with a summary

Think carefully about each action. Be methodical and verify your work.

Begin by analyzing the goal and deciding on your first action.`;
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
