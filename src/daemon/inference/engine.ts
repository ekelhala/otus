/**
 * Inference Engine
 * Manages the ReAct loop with LLM and tool execution via OpenRouter
 */

import OpenAI from "openai";
import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";
import { LLM, EXECUTION, OPENROUTER } from "@shared/constants.ts";
import type {
  InferenceEvent,
  InferenceEngineConfig,
  IterationResult,
  ToolCallResult,
  ToolResultMessage,
} from "./types.ts";
import { tools } from "./tools.ts";
import type { ToolName } from "./tools.ts";
import { ToolHandlers } from "./tool-handlers.ts";
import { buildInitialPrompt, ACTION_PROMPT, SYSTEM_PROMPT } from "./prompts.ts";

/**
 * Inference Engine implementing the ReAct loop
 */
export class InferenceEngine {
  private readonly client: OpenAI;
  private readonly toolHandlers: ToolHandlers;
  private readonly episodicMemory: InferenceEngineConfig["episodicMemory"];
  private readonly logger: InferenceEngineConfig["logger"];
  private readonly model: string;

  /** Conversation history for interactive mode */
  private messages: OpenAI.ChatCompletionMessageParam[] = [];
  /** Current session ID */
  private sessionId: string = "";

  constructor(config: InferenceEngineConfig) {
    // Configure OpenAI client to use OpenRouter
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: OPENROUTER.BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": OPENROUTER.APP_URL,
        "X-Title": OPENROUTER.APP_NAME,
      },
    });
    this.episodicMemory = config.episodicMemory;
    this.logger = config.logger;
    this.model = config.model || "google/gemini-2.5-flash";

    this.toolHandlers = new ToolHandlers({
      sandboxManager: config.sandboxManager,
      episodicMemory: config.episodicMemory,
      semanticMemory: config.semanticMemory,
      workspacePath: config.workspacePath,
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

    this.logger.debug(`Started session: ${this.sessionId} (model: ${this.model})`);
    return this.sessionId;
  }

  /**
   * Get the model identifier being used
   */
  getModel(): string {
    return this.model;
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
      this.logger.debug(`Error in chat loop: ${errorMessage}`);
      yield { type: "error", message: errorMessage };
      // Don't re-throw - error event is sufficient and re-throwing can cause generator issues
    }
  }

  /**
   * Add a user message to the conversation
   * Handles incomplete tool calls from previous turns
   */
  private addUserMessage(message: string): void {
    const fullMessage =
      this.messages.length === 0 ? buildInitialPrompt(message) : message;

    // Check for pending tool calls and add placeholder results first
    const pendingToolResults = this.getPendingToolResults();

    if (pendingToolResults.length > 0) {
      // Add tool results for incomplete tool calls
      for (const toolResult of pendingToolResults) {
        this.messages.push(toolResult);
      }
      this.logger.debug(
        `Completed ${pendingToolResults.length} pending tool call(s) due to user interruption`
      );
    }

    // Add the user message
    this.messages.push({
      role: "user",
      content: fullMessage,
    });
  }

  /**
   * Check if the last assistant message has tool_calls without corresponding tool results
   * Returns placeholder tool results to maintain valid conversation structure
   */
  private getPendingToolResults(): ToolResultMessage[] {
    if (this.messages.length === 0) return [];

    const lastMessage = this.messages.at(-1);
    
    // Only check if last message is from assistant
    if (!lastMessage || lastMessage.role !== "assistant") return [];
    
    // Check if the assistant message contains tool_calls
    const assistantMsg = lastMessage as OpenAI.ChatCompletionAssistantMessageParam;
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) return [];

    // Return placeholder tool results for each pending tool call
    return assistantMsg.tool_calls.map((toolCall) => ({
      role: "tool" as const,
      tool_call_id: toolCall.id,
      content: "Operation interrupted by user",
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

    // Call model and get response
    let response: OpenAI.ChatCompletion;
    try {
      response = await this.callModel();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(`API call failed: ${errorMessage}`);
      // Yield error event and stop gracefully instead of throwing
      yield { type: "error", message: `API error: ${errorMessage}` };
      return { complete: true, summary: `Error: ${errorMessage}` };
    }

    const choice = response.choices[0];
    if (!choice?.message) {
      yield { type: "error", message: "No response from model" };
      return { complete: true, summary: "Error: No response from model" };
    }

    // Process response before deciding what to persist.
    // Important: free-form assistant text (without tool calls) can self-steer later iterations.
    // We treat it as transient and do not add it to conversation history.
    const { toolCalls, textContent } = this.parseResponse(choice.message);
    this.logger.debug(`Parsed response: ${toolCalls.length} tool calls, text length: ${textContent.length}`);

    // Only persist assistant messages that actually contain tool calls.
    // This keeps the conversation grounded in user intent and tool observations.
    if (toolCalls.length > 0) {
      this.messages.push(choice.message);
    }

    // Yield thinking text if present
    if (textContent) {
      this.logger.debug(`About to yield thinking event (${textContent.length} chars)`);
      yield { type: "thinking", text: textContent };
      this.logger.debug(`Yielded thinking event successfully`);
      this.logger.thinking(textContent);
      this.episodicMemory.logEvent(this.sessionId, "think", {
        iteration,
        thought: textContent,
      });
    }

    // Execute tool calls if present
    if (toolCalls.length > 0) {
      this.logger.debug(`Executing ${toolCalls.length} tool calls`);
      const result = yield* this.executeToolCalls(toolCalls, iteration);
      this.logger.debug(`Tool calls completed, turnComplete=${result.complete}`);
      return result;
    }

    // No tool calls - prompt model to take action or call task_complete
    // Only task_complete tool should signal actual completion
    this.promptForAction();
    return { complete: false };
  }

  /**
   * Call model API with current messages
   */
  private async callModel(): Promise<OpenAI.ChatCompletion> {
    this.logger.debug(`Calling model API with ${this.messages.length} messages`);
    
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: LLM.MAX_TOKENS,
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT,
          },
          ...this.messages,
        ],
        tools: tools,
        tool_choice: "auto",
      },
      {
        timeout: EXECUTION.API_TIMEOUT_MS,
      }
    );
    
    // Log usage if available
    if (response.usage) {
      this.logger.debug(
        `Model API response: finish_reason=${response.choices[0]?.finish_reason}, ` +
        `prompt_tokens=${response.usage.prompt_tokens}, completion_tokens=${response.usage.completion_tokens}`
      );
    } else {
      this.logger.debug(`Model API response: finish_reason=${response.choices[0]?.finish_reason}`);
    }
    
    return response;
  }

  /**
   * Execute tool calls and add results to messages
   */
  private async *executeToolCalls(
    toolCalls: ChatCompletionMessageFunctionToolCall[],
    iteration: number
  ): AsyncGenerator<InferenceEvent, IterationResult> {
    this.logger.debug(`executeToolCalls started with ${toolCalls.length} calls`);
    const toolResults: ToolResultMessage[] = [];
    let turnComplete = false;
    let completionSummary: string | undefined;

    for (const toolCall of toolCalls) {
      this.logger.debug(`About to delegate to executeSingleToolCall for ${toolCall.function.name}`);
      const result = yield* this.executeSingleToolCall(toolCall, iteration);
      this.logger.debug(`executeSingleToolCall returned for ${toolCall.function.name}`);
      toolResults.push(result.toolResult);

      if (result.isTaskComplete) {
        turnComplete = true;
        completionSummary = result.summary;
      }
    }

    // Add all tool results to messages
    for (const toolResult of toolResults) {
      this.messages.push(toolResult);
    }

    return { complete: turnComplete, summary: completionSummary };
  }

  /**
   * Execute a single tool call
   */
  private async *executeSingleToolCall(
    toolCall: ChatCompletionMessageFunctionToolCall,
    iteration: number
  ): AsyncGenerator<InferenceEvent, ToolCallResult> {
    const toolName = toolCall.function.name;
    let toolInput: unknown;
    
    try {
      toolInput = JSON.parse(toolCall.function.arguments);
    } catch {
      toolInput = {};
    }

    this.logger.debug(`Executing tool: ${toolName}`);
    try {
      this.logger.debug(`Yielding tool_call event for ${toolName}`);
      yield { type: "tool_call", name: toolName, input: toolInput };
      this.logger.debug(`Yielded tool_call event, now logging`);
      this.logger.tool(toolName, toolInput);

      // Log action
      this.episodicMemory.logEvent(this.sessionId, "act", {
        iteration,
        tool: toolName,
        input: toolInput,
      });

      const result = await this.toolHandlers.execute(
        toolName as ToolName,
        toolInput,
        this.sessionId
      );

      // Check if task is complete
      const isTaskComplete = toolName === "task_complete";
      const summary = isTaskComplete ? (toolInput as any).summary : undefined;

      if (isTaskComplete) {
        this.logger.debug(`Turn complete: ${summary}`);
      }

      yield { type: "tool_result", name: toolName, result, isError: false };

      // Log observation
      this.episodicMemory.logEvent(this.sessionId, "observe", {
        iteration,
        tool: toolName,
        result,
      });

      return {
        toolResult: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        },
        isTaskComplete,
        summary,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(`Tool Error: ${errorMessage}`);

      yield { type: "tool_result", name: toolName, result: errorMessage, isError: true };

      this.episodicMemory.logEvent(this.sessionId, "observe", {
        iteration,
        tool: toolName,
        error: errorMessage,
      });

      return {
        toolResult: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: ${errorMessage}`,
        },
        isTaskComplete: false,
      };
    }
  }

  /**
   * Prompt model to take an action when it didn't make tool calls
   */
  private promptForAction(): void {
    this.logger.debug("No tool calls made, prompting for action");
    this.messages.push({
      role: "user",
      content: ACTION_PROMPT,
    });
  }

  /**
   * Parse model response into text and tool calls
   */
  private parseResponse(message: OpenAI.ChatCompletionMessage): {
    toolCalls: ChatCompletionMessageFunctionToolCall[];
    textContent: string;
  } {
    // Filter to only function tool calls (the standard type)
    const toolCalls = (message.tool_calls || []).filter(
      (tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function"
    );
    const textContent = message.content || "";

    return { toolCalls, textContent: textContent.trim() };
  }
}
