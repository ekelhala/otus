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
} from "./types.ts";
import { tools } from "./tools.ts";
import { ToolHandlers } from "./tool-handlers.ts";
import { SYSTEM_PROMPT } from "./prompts.ts";
import { ContextBuilder } from "./context-builder.ts";
import { Conversation, parseAssistantResponse } from "./conversation.ts";
import { PlanState } from "./plan-state.ts";
import { callModel } from "./model-caller.ts";
import { executeToolCalls } from "./tool-execution.ts";
import { runPlanningPass } from "./planner.ts";

/**
 * Inference Engine implementing the ReAct loop
 */
export class InferenceEngine {
  private readonly client: OpenAI;
  private readonly toolHandlers: ToolHandlers;
  private readonly episodicMemory: InferenceEngineConfig["episodicMemory"];
  private readonly logger: InferenceEngineConfig["logger"];
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly contextBuilder: ContextBuilder;
  private readonly conversation: Conversation;
  private readonly plan: PlanState;

  /** Current top-level user task (used to seed each subtask) */
  private taskGoal: string = "";
  /** Compact handoff from previous step to next step */
  private previousStepResult: string = "";

  /** Current session ID */
  private sessionId: string = "";
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
    this.maxIterations = this.normalizeMaxIterations(config.maxIterations);
    this.contextBuilder = new ContextBuilder(config.contextConfig);
    this.conversation = new Conversation(config.logger);
    this.plan = new PlanState();

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
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.conversation.reset();
    this.plan.reset();
    this.awaitingContinuation = false;
    this.paused = false;
    this.currentIteration = 0;
    this.consecutiveNoToolCalls = 0;
    this.contextBuilder.clearSummary();
    this.taskGoal = "";
    this.previousStepResult = "";

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
      // New top-level request: planning pass + step-by-step execution.
      this.taskGoal = userMessage;
      this.previousStepResult = "";
      this.plan.reset();
      this.conversation.reset();

      // Reset flags and iteration count for new requests
      this.awaitingContinuation = false;
      this.paused = false;
      this.currentIteration = 0;
      this.consecutiveNoToolCalls = 0;

      // Planning pass (separate system prompt)
      const steps = await runPlanningPass({
        client: this.client,
        model: this.model,
        goal: this.taskGoal,
        tools,
        timeoutMs: EXECUTION.API_TIMEOUT_MS,
        logger: this.logger,
      });

      const planSummary = this.plan.activate(steps);
      this.updateSessionSummary(planSummary);

      yield {
        type: "plan_created",
        steps,
        currentStep: 1,
      };

      // Initialize step conversation for step 1
      this.initializeCurrentStepConversation();
    }

    let iteration = 0;
    let turnComplete = false;
    let completionSummary: string | undefined;

    try {
      while (iteration < this.maxIterations && !turnComplete) {
        iteration++;
        this.currentIteration++;
        yield { type: "iteration", current: this.currentIteration, max: this.maxIterations };

        const result = yield* this.processIteration(iteration);

        if (result.complete) {
          // Subtask finished.
          completionSummary = result.summary;
          this.previousStepResult = completionSummary || "";

          if (this.plan.hasMoreSteps()) {
            // Advance to next plan step and start a fresh, decoupled subtask execution.
            const progress = this.plan.advance();
            this.updateSessionSummary(progress.summary);
            yield {
              type: "plan_step_complete",
              completedStep: progress.completedStep,
              nextStep: progress.nextStep,
              totalSteps: progress.totalSteps,
            };

            // Reset per-step counters and initialize a new per-step conversation
            this.conversation.reset();
            this.consecutiveNoToolCalls = 0;
            iteration = 0;
            this.currentIteration = 0;
            this.initializeCurrentStepConversation();
            continue;
          }

          // Final step completed
          turnComplete = true;
        }
      }

      if (iteration >= this.maxIterations) {
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
   * Initializes a fresh per-step conversation.
   * Each step only sees: the top-level task, current subtask, and a compact handoff summary.
   */
  private initializeCurrentStepConversation(): void {
    const currentStepDirective = this.plan.getCurrentStepDirective();
    const parts: string[] = [];
    parts.push(`Task: ${this.taskGoal}`);
    if (currentStepDirective) {
      // Keep directive text stable and short.
      parts.push(`Subtask: ${currentStepDirective}`);
    }
    if (this.previousStepResult.trim().length > 0) {
      parts.push(`Previous step result:\n${this.previousStepResult}`);
    }
    parts.push(
      "Work only on this subtask. Use tools to make progress. When the subtask is done, call task_complete with a concise summary of what was achieved in this subtask."
    );

    this.conversation.addUserMessage(parts.join("\n\n"));
  }

  /**
   * Process a single iteration of the agent loop
   */
  private async *processIteration(
    iteration: number
  ): AsyncGenerator<InferenceEvent, IterationResult> {
    this.logger.iteration(iteration, this.maxIterations);

    // Log thinking phase
    this.episodicMemory.logEvent(this.sessionId, "think", {
      iteration,
      context: this.plan.isActive()
        ? `Executing plan step ${this.plan.getCurrentStepNumber()}/${this.plan.getTotalSteps()}`
        : "Processing user request",
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
    const { toolCalls, textContent } = parseAssistantResponse(choice.message);
    this.logger.debug(`Parsed response: ${toolCalls.length} tool calls, text length: ${textContent.length}`);

    // Persist a sanitized copy of the assistant message.
    // We must always persist so the model sees proper turn-taking, but the raw
    // response object can contain fields (tool_calls: null, refusal: null, etc.)
    // that trip strict API validators when sent back as request params.
    this.conversation.addAssistantMessage(choice.message);

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
    this.logger.debug(`No tool calls (${this.consecutiveNoToolCalls} consecutive), finish_reason=${response.choices[0]?.finish_reason}`);

    if (this.consecutiveNoToolCalls >= 4) {
      // Model is stuck in a loop - force completion to break out
      this.logger.debug("Model stuck: 4 consecutive iterations without tool calls, forcing completion");
      this.consecutiveNoToolCalls = 0;
      return { complete: true, summary: textContent || "Agent could not determine next action" };
    }

    // Escalate prompts progressively
    if (this.consecutiveNoToolCalls >= 3) {
      this.conversation.push({
        role: "user",
        content: "You MUST call a tool NOW or call task_complete if finished. Responding with only text is not allowed.",
      });
    } else if (this.consecutiveNoToolCalls === 2) {
      this.conversation.push({
        role: "user",
        content: "You must call a tool. If the task is done, call task_complete. If you need to act, pick the most appropriate tool.",
      });
    } else {
      this.conversation.promptForAction();
    }
    return { complete: false };
  }

  private normalizeMaxIterations(value: unknown): number {
    const fallback = EXECUTION.MAX_ITERATIONS;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    const normalized = Math.floor(value);
    if (normalized < 1) {
      return fallback;
    }
    return normalized;
  }

  /**
   * Call model API with current messages
   */
  private async callModel(): Promise<OpenAI.ChatCompletion> {
    // During subtask execution we don't want nested replanning.
    const executionTools = tools.filter(
      (t) => !(t.type === "function" && t.function.name === "plan")
    );

    return await callModel({
      client: this.client,
      model: this.model,
      maxTokens: LLM.MAX_TOKENS,
      messages: this.conversation.getAll(),
      tools: executionTools,
      toolChoice: "auto",
      systemPrompt: SYSTEM_PROMPT,
      currentStepDirective: this.plan.getCurrentStepDirective(),
      contextBuilder: this.contextBuilder,
      timeoutMs: EXECUTION.API_TIMEOUT_MS,
      logger: this.logger,
    });
  }

  /**
   * Execute tool calls and add results to messages
   */
  private async *executeToolCalls(
    toolCalls: ChatCompletionMessageFunctionToolCall[],
    iteration: number
  ): AsyncGenerator<InferenceEvent, IterationResult> {
    const result = yield* executeToolCalls({
      toolCalls,
      iteration,
      sessionId: this.sessionId,
      toolHandlers: this.toolHandlers,
      episodicMemory: this.episodicMemory,
      logger: this.logger,
      // Step execution should be decoupled; task_complete ends the current subtask.
      plan: undefined,
      handlePlanTool: false,
    });

    for (const toolResult of result.toolResults) {
      this.conversation.push(toolResult);
    }

    return result.iterationResult;
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
