/**
 * Inference Engine
 * Manages the ReAct loop with Claude and tool execution
 */

import Anthropic from "@anthropic-ai/sdk";
import { LLM, EXECUTION } from "@shared/constants.ts";
import type {
  InferenceEvent,
  InferenceEngineConfig,
  IterationResult,
  ToolCallResult,
} from "./types.ts";
import { tools } from "./tools.ts";
import type { ToolName } from "./tools.ts";
import { ToolHandlers } from "./tool-handlers.ts";
import { buildInitialPrompt, ACTION_PROMPT } from "./prompts.ts";

/**
 * Inference Engine implementing the ReAct loop
 */
export class InferenceEngine {
  private readonly client: Anthropic;
  private readonly toolHandlers: ToolHandlers;
  private readonly episodicMemory: InferenceEngineConfig["episodicMemory"];
  private readonly logger: InferenceEngineConfig["logger"];

  /** Conversation history for interactive mode */
  private messages: Anthropic.MessageParam[] = [];
  /** Current session ID */
  private sessionId: string = "";

  constructor(config: InferenceEngineConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.episodicMemory = config.episodicMemory;
    this.logger = config.logger;

    this.toolHandlers = new ToolHandlers({
      sandboxManager: config.sandboxManager,
      episodicMemory: config.episodicMemory,
      semanticMemory: config.semanticMemory,
      logger: config.logger,
    });
  }

  /**
   * Start a new interactive session
   */
  startSession(): string {
    this.sessionId = `session-${Date.now()}`;
    this.messages = [];

    // Create session in episodic memory
    this.episodicMemory.createTask(this.sessionId, "Interactive session");

    this.logger.debug(`Started session: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * Process a user message in interactive mode
   * Yields events as the agent processes the request
   */
  async *chat(userMessage: string): AsyncGenerator<InferenceEvent> {
    if (!this.sessionId) {
      this.startSession();
    }

    this.logger.debug(
      `Processing: ${userMessage.substring(0, 100)}${userMessage.length > 100 ? "..." : ""}`
    );

    // Add user message to conversation
    this.addUserMessage(userMessage);

    let iteration = 0;
    let turnComplete = false;
    let completionSummary: string | undefined;

    try {
      while (iteration < EXECUTION.MAX_ITERATIONS && !turnComplete) {
        iteration++;
        yield { type: "iteration", current: iteration, max: EXECUTION.MAX_ITERATIONS };

        const result = yield* this.processIteration(iteration);

        if (result.complete) {
          turnComplete = true;
          completionSummary = result.summary;
        }
      }

      if (iteration >= EXECUTION.MAX_ITERATIONS) {
        this.logger.debug("Max iterations reached");
        this.episodicMemory.logEvent(this.sessionId, "reflect", {
          status: "incomplete",
          reason: "max_iterations_reached",
          iterations: iteration,
        });
      }

      yield { type: "complete", summary: completionSummary };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield { type: "error", message: errorMessage };
      throw error;
    }
  }

  /**
   * Add a user message to the conversation
   * Handles incomplete tool calls from previous turns
   */
  private addUserMessage(message: string): void {
    const fullMessage =
      this.messages.length === 0 ? buildInitialPrompt(message) : message;

    // Check for pending tool calls and combine with user message if needed
    const pendingToolResults = this.getPendingToolResults();

    if (pendingToolResults.length > 0) {
      // Combine tool results and user text in a single message
      this.messages.push({
        role: "user",
        content: [
          ...pendingToolResults,
          { type: "text", text: fullMessage },
        ],
      });
      this.logger.debug(
        `Completed ${pendingToolResults.length} pending tool call(s) due to user interruption`
      );
    } else {
      this.messages.push({
        role: "user",
        content: fullMessage,
      });
    }
  }

  /**
   * Check if the last assistant message has tool_use blocks without corresponding tool_results
   * Returns placeholder tool_results to maintain valid conversation structure
   */
  private getPendingToolResults(): Anthropic.ToolResultBlockParam[] {
    if (this.messages.length === 0) return [];

    const lastMessage = this.messages.at(-1);
    
    // Only check if last message is from assistant
    if (!lastMessage || lastMessage.role !== "assistant") return [];
    
    // Check if the assistant message contains tool_use blocks
    const content = lastMessage.content;
    if (!Array.isArray(content)) return [];

    const toolUseBlocks = content.filter(
      (block): block is Anthropic.ToolUseBlock => 
        typeof block === "object" && "type" in block && block.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) return [];

    // Return placeholder tool_results for each pending tool call
    return toolUseBlocks.map((toolUse) => ({
      type: "tool_result" as const,
      tool_use_id: toolUse.id,
      content: "Operation interrupted by user",
      is_error: true,
    }));
  }

  /**
   * Process a single iteration of the agent loop
   */
  private async *processIteration(
    iteration: number
  ): AsyncGenerator<InferenceEvent, IterationResult> {
    this.logger.iteration(iteration, EXECUTION.MAX_ITERATIONS);

    // Log thinking phase
    this.episodicMemory.logEvent(this.sessionId, "think", {
      iteration,
      context: "Processing user request",
    });

    // Call Claude and get response
    const response = await this.callClaude();

    // Add assistant response to messages
    this.messages.push({
      role: "assistant",
      content: response.content,
    });

    // Process response
    const { toolCalls, textContent } = this.parseResponse(response);

    // Yield thinking text if present
    if (textContent) {
      yield { type: "thinking", text: textContent };
      this.logger.thinking(textContent);
      this.episodicMemory.logEvent(this.sessionId, "think", {
        iteration,
        thought: textContent,
      });
    }

    // Execute tool calls if present
    if (toolCalls.length > 0) {
      const result = yield* this.executeToolCalls(toolCalls, iteration);
      return result;
    }

    // No tool calls - prompt Claude to take action or call task_complete
    // Only task_complete tool should signal actual completion
    this.promptForAction();
    return { complete: false };
  }

  /**
   * Call Claude API with current messages
   */
  private async callClaude(): Promise<Anthropic.Message> {
    return await this.client.messages.create({
      model: LLM.MODEL,
      max_tokens: LLM.MAX_TOKENS,
      messages: this.messages,
      tools,
    });
  }

  /**
   * Execute tool calls and add results to messages
   */
  private async *executeToolCalls(
    toolCalls: Anthropic.ToolUseBlock[],
    iteration: number
  ): AsyncGenerator<InferenceEvent, IterationResult> {
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let turnComplete = false;
    let completionSummary: string | undefined;

    for (const toolCall of toolCalls) {
      const result = yield* this.executeSingleToolCall(toolCall, iteration);
      toolResults.push(result.toolResult);

      if (result.isTaskComplete) {
        turnComplete = true;
        completionSummary = result.summary;
      }
    }

    // Add all tool results to messages
    this.messages.push({
      role: "user",
      content: toolResults,
    });

    return { complete: turnComplete, summary: completionSummary };
  }

  /**
   * Execute a single tool call
   */
  private async *executeSingleToolCall(
    toolCall: Anthropic.ToolUseBlock,
    iteration: number
  ): AsyncGenerator<InferenceEvent, ToolCallResult> {
    try {
      yield { type: "tool_call", name: toolCall.name, input: toolCall.input };
      this.logger.tool(toolCall.name, toolCall.input);

      // Log action
      this.episodicMemory.logEvent(this.sessionId, "act", {
        iteration,
        tool: toolCall.name,
        input: toolCall.input,
      });

      const result = await this.toolHandlers.execute(
        toolCall.name as ToolName,
        toolCall.input,
        this.sessionId
      );

      // Check if task is complete
      const isTaskComplete = toolCall.name === "task_complete";
      const summary = isTaskComplete ? (toolCall.input as any).summary : undefined;

      if (isTaskComplete) {
        this.logger.debug(`Turn complete: ${summary}`);
      }

      yield { type: "tool_result", name: toolCall.name, result, isError: false };

      // Log observation
      this.episodicMemory.logEvent(this.sessionId, "observe", {
        iteration,
        tool: toolCall.name,
        result,
      });

      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        },
        isTaskComplete,
        summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Tool Error: ${errorMessage}`);

      yield { type: "tool_result", name: toolCall.name, result: errorMessage, isError: true };

      this.episodicMemory.logEvent(this.sessionId, "observe", {
        iteration,
        tool: toolCall.name,
        error: errorMessage,
      });

      return {
        toolResult: {
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Error: ${errorMessage}`,
          is_error: true,
        },
        isTaskComplete: false,
      };
    }
  }

  /**
   * Prompt Claude to take an action when it didn't make tool calls
   */
  private promptForAction(): void {
    this.logger.debug("No tool calls made, prompting for action");
    this.messages.push({
      role: "user",
      content: ACTION_PROMPT,
    });
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
}
