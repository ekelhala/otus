import OpenAI from "openai";
import type { ChatCompletionMessageFunctionToolCall } from "openai/resources/chat/completions";
import type { Logger } from "@shared/logger.ts";
import type { ToolResultMessage } from "./types.ts";
import { ACTION_PROMPT, buildInitialPrompt } from "./prompts.ts";

/**
 * Conversation state and message hygiene utilities.
 * Keeps message ordering valid when tool calls are interrupted.
 */
export class Conversation {
  private messages: OpenAI.ChatCompletionMessageParam[] = [];

  constructor(private readonly logger: Logger) {}

  reset(): void {
    this.messages = [];
  }

  getAll(): OpenAI.ChatCompletionMessageParam[] {
    return this.messages;
  }

  push(message: OpenAI.ChatCompletionMessageParam): void {
    this.messages.push(message);
  }

  /**
   * Add a user message.
   * If the last assistant message contains tool_calls without tool results,
   * inserts placeholder tool results first to keep conversation structure valid.
   */
  addUserMessage(message: string): void {
    const fullMessage = this.messages.length === 0 ? buildInitialPrompt(message) : message;

    const pendingToolResults = getPendingToolResults(this.messages);
    if (pendingToolResults.length > 0) {
      for (const toolResult of pendingToolResults) {
        this.messages.push(toolResult);
      }
      this.logger.debug(
        `Completed ${pendingToolResults.length} pending tool call(s) due to user interruption`
      );
    }

    this.messages.push({
      role: "user",
      content: fullMessage,
    });
  }

  promptForAction(): void {
    this.logger.debug("No tool calls made, prompting for action");
    this.messages.push({
      role: "user",
      content: ACTION_PROMPT,
    });
  }

  addAssistantMessage(message: OpenAI.ChatCompletionMessage): void {
    this.messages.push(sanitizeAssistantMessage(message));
  }
}

/**
 * Parse model response into text and tool calls.
 */
export function parseAssistantResponse(message: OpenAI.ChatCompletionMessage): {
  toolCalls: ChatCompletionMessageFunctionToolCall[];
  textContent: string;
} {
  const toolCalls = (message.tool_calls || []).filter(
    (tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function"
  );
  const textContent = message.content || "";
  return { toolCalls, textContent: textContent.trim() };
}

/**
 * Sanitize an assistant response message into a clean request param.
 * Strips response-only fields and avoids sending tool_calls: null/[] which some providers reject.
 */
export function sanitizeAssistantMessage(
  message: OpenAI.ChatCompletionMessage
): OpenAI.ChatCompletionAssistantMessageParam {
  const clean: OpenAI.ChatCompletionAssistantMessageParam = {
    role: "assistant",
  };

  if (message.content && message.content.trim().length > 0) {
    clean.content = message.content;
  } else {
    clean.content = null;
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    clean.tool_calls = message.tool_calls
      .filter((tc): tc is ChatCompletionMessageFunctionToolCall => tc.type === "function")
      .map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));

    if (clean.tool_calls.length === 0) {
      delete clean.tool_calls;
    }
  }

  return clean;
}

/**
 * If the last assistant message has tool_calls without corresponding tool results,
 * return placeholder tool results to maintain valid conversation structure.
 */
export function getPendingToolResults(
  messages: OpenAI.ChatCompletionMessageParam[]
): ToolResultMessage[] {
  if (messages.length === 0) return [];

  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "assistant") return [];

  const assistantMsg = lastMessage as OpenAI.ChatCompletionAssistantMessageParam;
  if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) return [];

  return assistantMsg.tool_calls.map((toolCall) => ({
    role: "tool" as const,
    tool_call_id: toolCall.id,
    content: "Operation interrupted by user",
  }));
}
