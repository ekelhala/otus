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
import { ContextBuilder } from "./context-builder.ts";

/**
 * Inference Engine implementing the ReAct loop
 */
export class InferenceEngine {
  private readonly client: OpenAI;
  private readonly toolHandlers: ToolHandlers;
  private readonly episodicMemory: InferenceEngineConfig["episodicMemory"];
  private readonly logger: InferenceEngineConfig["logger"];
  private readonly model: string;
  private readonly contextBuilder: ContextBuilder;

  /** Conversation history for interactive mode */
  private messages: OpenAI.ChatCompletionMessageParam[] = [];
  /** Current session ID */
  private sessionId: string = "";
  /** Current plan steps and progress */
  private planSteps: string[] = [];
  private currentStepIndex: number = 0;
  /** Track if we hit max iterations and are awaiting continuation */
  private awaitingContinuation: boolean = false;
  /** Track if execution was paused */
  private paused: boolean = false;
  /** Current iteration count (preserved during pause, reset on new request) */
  private currentIteration: number = 0;
  /** Consecutive iterations where model returned no tool calls */
  private consecutiveNoToolCalls: number = 0;

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
    this.contextBuilder = new ContextBuilder(config.contextConfig);

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
    this.planSteps = [];
    this.currentStepIndex = 0;
    this.awaitingContinuation = false;
    this.paused = false;
    this.currentIteration = 0;
    this.consecutiveNoToolCalls = 0;
    this.contextBuilder.clearSummary();

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

    // Check if this is a pause signal (user pressed Ctrl+C)
    if (userMessage.toLowerCase() === "pause") {
      this.logger.debug("Pause signal received");
      this.paused = true;
      // Don't process, just set the flag and return
      return;
    }

    // Check if this is resuming from pause
    const isResumingFromPause = this.paused && 
      (userMessage.toLowerCase() === "continue" || 
       userMessage.toLowerCase() === "yes" || 
       userMessage.toLowerCase() === "y");
    
    // Check if this is a continuation from max iterations
    const isMaxIterationsContinuation = this.awaitingContinuation && 
      (userMessage.toLowerCase() === "continue" || 
       userMessage.toLowerCase() === "yes" || 
       userMessage.toLowerCase() === "y");
    
    if (isResumingFromPause) {
      this.logger.debug("Resuming from pause...");
      this.paused = false;
      // Keep current iteration count when resuming from pause
      // Don't add the "continue" message to history, just resume
    } else if (isMaxIterationsContinuation) {
      this.logger.debug("Continuing from max iterations...");
      this.awaitingContinuation = false;
      // Reset iteration count for max iterations continuation (fresh 50)
      this.currentIteration = 0;
      // Don't add the "continue" message to history, just resume
    } else {
      // Add user message to conversation
      this.addUserMessage(userMessage);
      // Reset flags and iteration count for new requests
      this.awaitingContinuation = false;
      this.paused = false;
      this.currentIteration = 0;
      this.consecutiveNoToolCalls = 0;
    }

    let iteration = 0;
    let turnComplete = false;
    let completionSummary: string | undefined;

    try {
      while (iteration < EXECUTION.MAX_ITERATIONS && !turnComplete) {
        iteration++;
        this.currentIteration++;
        yield { type: "iteration", current: this.currentIteration, max: EXECUTION.MAX_ITERATIONS };

        const result = yield* this.processIteration(iteration);

        if (result.complete) {
          turnComplete = true;
          completionSummary = result.summary;
        }
      }

      if (iteration >= EXECUTION.MAX_ITERATIONS) {
        this.logger.debug("Max iterations reached, prompting for continuation");
        this.awaitingContinuation = true;
        
        this.episodicMemory.logEvent(this.sessionId, "reflect", {
          status: "max_iterations",
          reason: "awaiting_continuation",
          iterations: this.currentIteration,
        });
        
        yield { type: "max_iterations_reached", current: this.currentIteration };
        // Don't yield complete - we're paused, not done
        return;
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

      // Log detailed error information for HTTP/API errors
      if (error && typeof error === "object") {
        const apiError = error as any;
        if (apiError.status) {
          this.logger.debug(`API HTTP status: ${apiError.status}`);
        }
        if (apiError.error) {
          this.logger.debug(`API error body: ${JSON.stringify(apiError.error, null, 2)}`);
        }
        if (apiError.code) {
          this.logger.debug(`API error code: ${apiError.code}`);
        }
        if (apiError.headers) {
          // Log rate-limit / retry headers if present
          const h = apiError.headers;
          const relevant = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"];
          for (const key of relevant) {
            if (h[key] || h.get?.(key)) {
              this.logger.debug(`API header ${key}: ${h[key] ?? h.get(key)}`);
            }
          }
        }
      }

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
    const { toolCalls, textContent } = this.parseResponse(choice.message);
    this.logger.debug(`Parsed response: ${toolCalls.length} tool calls, text length: ${textContent.length}`);

    // Persist a sanitized copy of the assistant message.
    // We must always persist so the model sees proper turn-taking, but the raw
    // response object can contain fields (tool_calls: null, refusal: null, etc.)
    // that trip strict API validators when sent back as request params.
    this.messages.push(this.sanitizeAssistantMessage(choice.message));

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
      this.consecutiveNoToolCalls = 0; // Reset counter when tool calls are made
      this.logger.debug(`Executing ${toolCalls.length} tool calls`);
      const result = yield* this.executeToolCalls(toolCalls, iteration);
      this.logger.debug(`Tool calls completed, turnComplete=${result.complete}`);
      return result;
    }

    // No tool calls - track consecutive misses and escalate prompts
    this.consecutiveNoToolCalls++;
    this.logger.debug(`No tool calls (${this.consecutiveNoToolCalls} consecutive)`);

    if (this.consecutiveNoToolCalls >= 3) {
      // Model is stuck in a loop - force completion to break out
      this.logger.debug("Model stuck: 3 consecutive iterations without tool calls, forcing completion");
      this.consecutiveNoToolCalls = 0;
      return { complete: true, summary: textContent || "Agent could not determine next action" };
    }

    // Escalate the prompt on the second miss
    if (this.consecutiveNoToolCalls === 2) {
      this.messages.push({
        role: "user",
        content: "You MUST call a tool now. If the task is done, call task_complete. Do not reply with text only.",
      });
    } else {
      this.promptForAction();
    }
    return { complete: false };
  }

  /**
   * Call model API with current messages
   */
  private async callModel(): Promise<OpenAI.ChatCompletion> {
    this.logger.debug(`Calling model API with ${this.messages.length} messages`);
    
    // Build current step directive if we have an active plan
    let currentStepDirective: string | undefined;
    if (this.planSteps.length > 0 && this.currentStepIndex < this.planSteps.length) {
      const stepNum = this.currentStepIndex + 1;
      const totalSteps = this.planSteps.length;
      const currentStep = this.planSteps[this.currentStepIndex];
      currentStepDirective = `[Step ${stepNum}/${totalSteps}] Focus ONLY on this step now: ${currentStep}\n\nComplete this step, then call task_complete. Do not work on any other steps.`;
    }
    
    // Build context with budget constraints
    const builtContext = this.contextBuilder.buildContext(
      SYSTEM_PROMPT,
      this.messages,
      currentStepDirective
    );
    
    this.logger.debug(
      `Built context: ${builtContext.metadata.messageCount} messages, ` +
      `${builtContext.metadata.totalChars} chars, ` +
      `${builtContext.metadata.truncatedMessages} truncated`
    );
    
    // Log message roles/structure for debugging ordering issues
    const roleSequence = builtContext.messages.map((m, idx) => {
      let desc = m.role;
      if (m.role === "assistant" && "tool_calls" in m && m.tool_calls?.length) {
        desc += `(${m.tool_calls.length} tool_calls)`;
      }
      if (m.role === "tool") {
        desc += `(${(m as any).tool_call_id?.substring(0, 8)}...)`;
      }
      if (m.role === "system" && typeof m.content === "string") {
        const preview = m.content.substring(0, 30).replace(/\n/g, " ");
        desc += `("${preview}...")`;
      }
      return `${idx}:${desc}`;
    });
    this.logger.debug(`Context message sequence: [${roleSequence.join(", ")}]`);
    
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        max_tokens: LLM.MAX_TOKENS,
        messages: builtContext.messages,
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
    let pendingPlanSteps: string[] | null = null;

    for (const toolCall of toolCalls) {
      this.logger.debug(`About to delegate to executeSingleToolCall for ${toolCall.function.name}`);
      const result = yield* this.executeSingleToolCall(toolCall, iteration);
      this.logger.debug(`executeSingleToolCall returned for ${toolCall.function.name}`);
      toolResults.push(result.toolResult);

      // Handle plan tool - defer activation until after tool results are in messages
      if (toolCall.function.name === "plan") {
        try {
          const planInput = JSON.parse(toolCall.function.arguments);
          pendingPlanSteps = planInput.steps;
          // Emit plan created event for CLI visualization
          yield {
            type: "plan_created",
            steps: planInput.steps,
            currentStep: 1,
          };
        } catch {
          this.logger.debug("Failed to parse plan input");
        }
      }

      // Handle task_complete - check if we should continue with next step
      if (result.isTaskComplete) {
        if (this.hasMoreSteps()) {
          // Don't actually complete - move to next step
          const completedStep = this.currentStepIndex + 1;
          this.moveToNextStep();
          turnComplete = false;
          this.logger.debug(`Step ${completedStep} completed, moving to step ${this.currentStepIndex + 1}`);
          // Emit step completion event
          yield {
            type: "plan_step_complete",
            completedStep,
            nextStep: this.currentStepIndex + 1,
            totalSteps: this.planSteps.length,
          };
        } else {
          // All steps done or no plan active - truly complete
          turnComplete = true;
          completionSummary = result.summary;
        }
      }
    }

    // Add all tool results to messages first (must follow assistant message)
    for (const toolResult of toolResults) {
      this.messages.push(toolResult);
    }

    // Now activate plan and inject step message AFTER tool results
    // This ensures valid message ordering: assistant -> tool results -> user (step)
    if (pendingPlanSteps) {
      this.activatePlan(pendingPlanSteps);
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

  /**
   * Sanitize an assistant response message into a clean request param.
   * Strips response-only fields (refusal, function_call, etc.) and avoids
   * sending tool_calls: null/[] which some providers reject.
   */
  private sanitizeAssistantMessage(
    message: OpenAI.ChatCompletionMessage
  ): OpenAI.ChatCompletionAssistantMessageParam {
    const clean: OpenAI.ChatCompletionAssistantMessageParam = {
      role: "assistant",
      content: message.content ?? "",
    };

    if (message.tool_calls && message.tool_calls.length > 0) {
      clean.tool_calls = message.tool_calls
        .filter((tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function")
        .map((tc) => ({
          id: tc.id,
          type: tc.type,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        }));
      // Drop tool_calls entirely if none survived the filter
      if (clean.tool_calls.length === 0) {
        delete clean.tool_calls;
      }
    }

    return clean;
  }

  /**
   * Activate a plan
   * Note: The step directive is now handled by the context builder via currentStepDirective
   * This ensures proper message ordering: assistant -> tool results -> (context with step)
   */
  private activatePlan(steps: string[]): void {
    this.planSteps = steps;
    this.currentStepIndex = 0;
    
    // Update session summary with the plan
    const planSummary = `Plan activated with ${steps.length} steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    this.updateSessionSummary(planSummary);
    
    this.logger.debug(`Plan activated with ${steps.length} steps. Starting step 1.`);
  }

  /**
   * Check if there are more steps in the current plan
   */
  private hasMoreSteps(): boolean {
    return this.planSteps.length > 0 && this.currentStepIndex < this.planSteps.length - 1;
  }

  /**
   * Move to the next step in the plan
   * Note: The step directive is now handled by the context builder via currentStepDirective
   * This ensures proper message ordering: assistant -> tool results -> (context with step)
   */
  private moveToNextStep(): void {
    this.currentStepIndex++;
    
    // Update session summary with progress
    const stepNum = this.currentStepIndex + 1;
    const summary = `Completed step ${stepNum - 1}/${this.planSteps.length}. Now on step ${stepNum}.`;
    this.updateSessionSummary(summary);
    
    this.logger.debug(`Moving to step ${this.currentStepIndex + 1}/${this.planSteps.length}`);
  }

  /**
   * Update the rolling session summary
   */
  private updateSessionSummary(update: string): void {
    const currentSummary = this.contextBuilder.getSummary();
    const newSummary = currentSummary 
      ? `${currentSummary}\n${update}`
      : update;
    this.contextBuilder.updateSummary(newSummary);
    this.logger.debug(`Session summary updated: ${update}`);
  }
}
