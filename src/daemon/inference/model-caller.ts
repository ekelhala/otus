import type OpenAI from "openai";
import type { Logger } from "@shared/logger.ts";
import type { ContextBuilder } from "./context-builder.ts";

export interface CallModelArgs {
  client: OpenAI;
  model: string;
  maxTokens: number;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools: OpenAI.ChatCompletionTool[];
  toolChoice: "auto";
  systemPrompt: string;
  currentStepDirective?: string;
  contextBuilder: ContextBuilder;
  timeoutMs: number;
  logger: Logger;
}

/**
 * Call the model API using ContextBuilder budgeting and structured debug logs.
 */
export async function callModel(args: CallModelArgs): Promise<OpenAI.ChatCompletion> {
  const {
    client,
    model,
    maxTokens,
    messages,
    tools,
    toolChoice,
    systemPrompt,
    currentStepDirective,
    contextBuilder,
    timeoutMs,
    logger,
  } = args;

  logger.debug(`Calling model API with ${messages.length} messages`);

  const builtContext = contextBuilder.buildContext(systemPrompt, messages, currentStepDirective);

  logger.debug(
    `Built context: ${builtContext.metadata.messageCount} messages, ` +
      `${builtContext.metadata.totalChars} chars, ` +
      `${builtContext.metadata.truncatedMessages} truncated`
  );

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
  logger.debug(`Context message sequence: [${roleSequence.join(", ")}]`);

  const response = await client.chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      messages: builtContext.messages,
      tools,
      tool_choice: toolChoice,
    },
    { timeout: timeoutMs }
  );

  if (response.usage) {
    logger.debug(
      `Model API response: finish_reason=${response.choices[0]?.finish_reason}, ` +
        `prompt_tokens=${response.usage.prompt_tokens}, completion_tokens=${response.usage.completion_tokens}`
    );
  } else {
    logger.debug(`Model API response: finish_reason=${response.choices[0]?.finish_reason}`);
  }

  return response;
}
