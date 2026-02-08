import type OpenAI from "openai";
import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";
import type { Logger } from "@shared/logger.ts";
import { PLANNING_SYSTEM_PROMPT } from "./prompts.ts";
import type { ToolName } from "./tools.ts";

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.trim().length > 0)
  );
}

function filterToolsByName(
  tools: OpenAI.ChatCompletionTool[],
  allowedNames: Set<ToolName>
): OpenAI.ChatCompletionTool[] {
  return tools.filter((t) => {
    if (t.type !== "function") return false;
    return allowedNames.has(t.function.name as ToolName);
  });
}

export interface PlanningPassArgs {
  client: OpenAI;
  model: string;
  goal: string;
  tools: OpenAI.ChatCompletionTool[];
  timeoutMs: number;
  logger: Logger;
}

/**
 * Runs a dedicated planning pass.
 * Forces a `plan` tool call and returns validated plan steps.
 */
export async function runPlanningPass(args: PlanningPassArgs): Promise<string[]> {
  const { client, model, goal, tools, timeoutMs, logger } = args;

  const planOnlyTools = filterToolsByName(tools, new Set(["plan"]));

  const response = await client.chat.completions.create(
    {
      model,
      max_tokens: 600,
      messages: [
        { role: "system", content: PLANNING_SYSTEM_PROMPT },
        { role: "user", content: goal },
      ],
      tools: planOnlyTools,
      // Force a plan tool call even if the model tries to answer with text.
      tool_choice: { type: "function", function: { name: "plan" } } as any,
    },
    { timeout: timeoutMs }
  );

  const message = response.choices[0]?.message;
  const toolCalls = message?.tool_calls || [];
  const planCall = toolCalls.find(
    (tc): tc is ChatCompletionMessageFunctionToolCall =>
      tc.type === "function" && tc.function?.name === "plan"
  );

  if (!planCall) {
    logger.debug("Planning pass produced no plan tool call; falling back to single-step plan");
    return [goal];
  }

  try {
    const parsed = JSON.parse(planCall.function.arguments || "{}") as any;
    const steps = parsed?.steps;
    if (!isNonEmptyStringArray(steps)) {
      logger.debug("Planning pass returned invalid steps; falling back to single-step plan");
      return [goal];
    }

    // Normalize (trim) and bound size defensively.
    const normalized = steps.map((s) => s.trim()).filter(Boolean);
    return normalized.slice(0, 10);
  } catch {
    logger.debug("Planning pass plan arguments were not JSON; falling back to single-step plan");
    return [goal];
  }
}
