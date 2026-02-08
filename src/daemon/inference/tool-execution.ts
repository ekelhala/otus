import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";
import type { Logger } from "@shared/logger.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { InferenceEvent, IterationResult, ToolCallResult, ToolResultMessage } from "./types.ts";
import type { ToolName } from "./tools.ts";
import type { ToolHandlers } from "./tool-handlers.ts";
import type { PlanState } from "./plan-state.ts";

export interface ExecuteToolCallsArgs {
  toolCalls: ChatCompletionMessageFunctionToolCall[];
  iteration: number;
  sessionId: string;
  toolHandlers: ToolHandlers;
  episodicMemory: EpisodicMemory;
  logger: Logger;
  plan: PlanState;
  onSessionSummaryUpdate: (update: string) => void;
}

export interface ExecuteToolCallsResult {
  iterationResult: IterationResult;
  toolResults: ToolResultMessage[];
  pendingPlanSteps: string[] | null;
}

export async function* executeToolCalls(
  args: ExecuteToolCallsArgs
): AsyncGenerator<InferenceEvent, ExecuteToolCallsResult> {
  const {
    toolCalls,
    iteration,
    sessionId,
    toolHandlers,
    episodicMemory,
    logger,
    plan,
    onSessionSummaryUpdate,
  } = args;

  logger.debug(`executeToolCalls started with ${toolCalls.length} calls`);
  const toolResults: ToolResultMessage[] = [];
  let turnComplete = false;
  let completionSummary: string | undefined;
  let pendingPlanSteps: string[] | null = null;

  for (const toolCall of toolCalls) {
    logger.debug(`About to delegate to executeSingleToolCall for ${toolCall.function.name}`);
    const result = yield* executeSingleToolCall({
      toolCall,
      iteration,
      sessionId,
      toolHandlers,
      episodicMemory,
      logger,
    });
    logger.debug(`executeSingleToolCall returned for ${toolCall.function.name}`);
    toolResults.push(result.toolResult);

    if (toolCall.function.name === "plan") {
      try {
        const planInput = JSON.parse(toolCall.function.arguments);
        pendingPlanSteps = planInput.steps;
        yield {
          type: "plan_created",
          steps: planInput.steps,
          currentStep: 1,
        };
      } catch {
        logger.debug("Failed to parse plan input");
      }
    }

    if (result.isTaskComplete) {
      if (plan.hasMoreSteps()) {
        const progress = plan.advance();
        onSessionSummaryUpdate(progress.summary);
        turnComplete = false;
        logger.debug(
          `Step ${progress.completedStep} completed, moving to step ${progress.nextStep}`
        );
        yield {
          type: "plan_step_complete",
          completedStep: progress.completedStep,
          nextStep: progress.nextStep,
          totalSteps: progress.totalSteps,
        };
      } else {
        turnComplete = true;
        completionSummary = result.summary;
      }
    }
  }

  return {
    iterationResult: { complete: turnComplete, summary: completionSummary },
    toolResults,
    pendingPlanSteps,
  };
}

interface ExecuteSingleToolCallArgs {
  toolCall: ChatCompletionMessageFunctionToolCall;
  iteration: number;
  sessionId: string;
  toolHandlers: ToolHandlers;
  episodicMemory: EpisodicMemory;
  logger: Logger;
}

async function* executeSingleToolCall(
  args: ExecuteSingleToolCallArgs
): AsyncGenerator<InferenceEvent, ToolCallResult> {
  const { toolCall, iteration, sessionId, toolHandlers, episodicMemory, logger } = args;
  const toolName = toolCall.function.name;

  let toolInput: unknown;
  try {
    toolInput = JSON.parse(toolCall.function.arguments);
  } catch {
    toolInput = {};
  }

  logger.debug(`Executing tool: ${toolName}`);
  try {
    logger.debug(`Yielding tool_call event for ${toolName}`);
    yield { type: "tool_call", name: toolName, input: toolInput };
    logger.debug(`Yielded tool_call event, now logging`);
    logger.tool(toolName, toolInput);

    episodicMemory.logEvent(sessionId, "act", {
      iteration,
      tool: toolName,
      input: toolInput,
    });

    const result = await toolHandlers.execute(toolName as ToolName, toolInput, sessionId);

    const isTaskComplete = toolName === "task_complete";
    const summary = isTaskComplete ? (toolInput as any).summary : undefined;

    if (isTaskComplete) {
      logger.debug(`Turn complete: ${summary}`);
    }

    yield { type: "tool_result", name: toolName, result, isError: false };

    episodicMemory.logEvent(sessionId, "observe", {
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
    logger.debug(`Tool Error: ${errorMessage}`);

    yield { type: "tool_result", name: toolName, result: errorMessage, isError: true };

    episodicMemory.logEvent(sessionId, "observe", {
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
