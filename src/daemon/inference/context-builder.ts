/**
 * Context Builder
 * Builds LLM prompts with budget constraints and manages conversation history
 */

import type OpenAI from "openai";

export interface ContextBuilderConfig {
  /** Maximum characters for the session summary (conservative token estimate: chars/4) */
  maxSummaryChars: number;
  /** Maximum number of recent messages to keep */
  maxRecentMessages: number;
  /** Maximum total characters for all recent messages */
  maxRecentMessagesChars: number;
  /** Maximum characters per tool result message */
  maxToolResultChars: number;
  /** Maximum total characters for the entire context (excluding system prompt) */
  maxTotalContextChars: number;
}

export interface BuiltContext {
  /** Messages to send to the model (system prompt + session summary + recent messages) */
  messages: OpenAI.ChatCompletionMessageParam[];
  /** Metadata about the built context */
  metadata: {
    summaryChars: number;
    messagesChars: number;
    totalChars: number;
    messageCount: number;
    truncatedMessages: number;
  };
}

/**
 * Default configuration for context building
 */
export const DEFAULT_CONTEXT_CONFIG: ContextBuilderConfig = {
  maxSummaryChars: 4000, // ~1000 tokens
  maxRecentMessages: 40,
  maxRecentMessagesChars: 80000, // ~20k tokens
  maxToolResultChars: 8000, // ~2k tokens per tool result
  maxTotalContextChars: 120000, // ~30k tokens total (excluding system prompt)
};

/**
 * Context Builder for managing LLM prompt construction with budgets
 */
export class ContextBuilder {
  private config: ContextBuilderConfig;
  private sessionSummary: string = "";

  constructor(config: Partial<ContextBuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
  }

  /**
   * Update the rolling session summary
   */
  updateSummary(summary: string): void {
    // Truncate summary if it exceeds the limit
    if (summary.length > this.config.maxSummaryChars) {
      this.sessionSummary = summary.substring(0, this.config.maxSummaryChars) + "...";
    } else {
      this.sessionSummary = summary;
    }
  }

  /**
   * Get the current session summary
   */
  getSummary(): string {
    return this.sessionSummary;
  }

  /**
   * Build context for the model with budget constraints
   * @param systemPrompt The system prompt to use
   * @param messages The full conversation history
   * @param currentStepDirective Optional directive for the current plan step
   * @returns Built context with messages and metadata
   */
  buildContext(
    systemPrompt: string,
    messages: OpenAI.ChatCompletionMessageParam[],
    currentStepDirective?: string
  ): BuiltContext {
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    
    // Always include system prompt (not counted in budget)
    result.push({
      role: "system",
      content: systemPrompt,
    });

    let budgetUsed = 0;
    let truncatedCount = 0;

    // Add session summary if present
    if (this.sessionSummary) {
      const summaryMessage: OpenAI.ChatCompletionMessageParam = {
        role: "system",
        content: `## Session Summary\n${this.sessionSummary}`,
      };
      result.push(summaryMessage);
      budgetUsed += this.sessionSummary.length;
    }

    // Add current step directive if present
    if (currentStepDirective) {
      const stepMessage: OpenAI.ChatCompletionMessageParam = {
        role: "system",
        content: `## Current Objective\n${currentStepDirective}`,
      };
      result.push(stepMessage);
      budgetUsed += currentStepDirective.length;
    }

    // Build recent messages window with budget constraints
    const recentMessages = this.buildRecentMessagesWindow(
      messages,
      this.config.maxTotalContextChars - budgetUsed
    );

    // Add recent messages to result
    result.push(...recentMessages.messages);
    budgetUsed += recentMessages.totalChars;
    truncatedCount += recentMessages.truncatedCount;

    return {
      messages: result,
      metadata: {
        summaryChars: this.sessionSummary.length,
        messagesChars: recentMessages.totalChars,
        totalChars: budgetUsed,
        messageCount: recentMessages.messages.length,
        truncatedMessages: truncatedCount,
      },
    };
  }

  /**
   * Build a bounded recent messages window
   * Preserves tool-call ordering invariants:
   * - assistant message with tool_calls must be followed by its tool result messages
   * - do not include dangling tool calls without tool results
   *
   * Strategy: scan forward to identify atomic "message groups", then take the
   * most recent groups that fit within the budget.  A group is either:
   *   a) an assistant message with tool_calls + all of its tool result messages
   *   b) any other single message (user, system, plain assistant)
   */
  private buildRecentMessagesWindow(
    messages: OpenAI.ChatCompletionMessageParam[],
    remainingBudget: number
  ): {
    messages: OpenAI.ChatCompletionMessageParam[];
    totalChars: number;
    truncatedCount: number;
  } {
    if (messages.length === 0) {
      return { messages: [], totalChars: 0, truncatedCount: 0 };
    }

    // ── Pass 1: identify atomic message groups (forward scan) ──
    type MessageGroup = {
      messages: OpenAI.ChatCompletionMessageParam[];
      chars: number;
      truncated: number;
    };
    const groups: MessageGroup[] = [];
    const consumedIndices = new Set<number>();

    for (let i = 0; i < messages.length; i++) {
      if (consumedIndices.has(i)) continue;

      const msg = messages[i];
      if (!msg) continue;

      if (
        msg.role === "assistant" &&
        (msg as OpenAI.ChatCompletionAssistantMessageParam).tool_calls?.length
      ) {
        // Start a group: assistant + its tool results
        const assistantMsg = msg as OpenAI.ChatCompletionAssistantMessageParam;
        const toolCallIds = new Set(
          assistantMsg.tool_calls!.map((tc) => tc.id)
        );
        const groupMsgs: OpenAI.ChatCompletionMessageParam[] = [msg];
        let groupChars = this.estimateMessageChars(msg);
        let groupTruncated = 0;
        consumedIndices.add(i);

        // Collect subsequent tool results that belong to this assistant message
        for (let j = i + 1; j < messages.length && toolCallIds.size > 0; j++) {
          const candidate = messages[j];
          if (!candidate || candidate.role !== "tool") break;
          const toolMsg = candidate as OpenAI.ChatCompletionToolMessageParam;
          if (!toolCallIds.has(toolMsg.tool_call_id)) break;

          const normalized = this.normalizeToolResult(candidate);
          if (normalized.content !== toolMsg.content) groupTruncated++;
          groupMsgs.push(normalized);
          groupChars += this.estimateMessageChars(normalized);
          toolCallIds.delete(toolMsg.tool_call_id);
          consumedIndices.add(j);
        }

        groups.push({
          messages: groupMsgs,
          chars: groupChars,
          truncated: groupTruncated,
        });
      } else if (msg.role === "tool") {
        // Orphan tool result (its assistant was already consumed or missing).
        // Normalize and include as a standalone group; the model can still
        // make sense of it from context even without the assistant message.
        const normalized = this.normalizeToolResult(msg);
        const chars = this.estimateMessageChars(normalized);
        const trunc = normalized.content !== msg.content ? 1 : 0;
        consumedIndices.add(i);
        groups.push({ messages: [normalized], chars, truncated: trunc });
      } else {
        // Plain user / system / text-only assistant
        const chars = this.estimateMessageChars(msg);
        consumedIndices.add(i);
        groups.push({ messages: [msg], chars, truncated: 0 });
      }
    }

    // ── Pass 2: take the most recent groups that fit the budget ──
    const effectiveBudget = Math.min(
      remainingBudget,
      this.config.maxRecentMessagesChars
    );
    const selected: MessageGroup[] = [];
    let totalChars = 0;
    let totalMessages = 0;
    let truncatedCount = 0;

    for (let g = groups.length - 1; g >= 0; g--) {
      const group = groups[g]!;
      if (totalMessages + group.messages.length > this.config.maxRecentMessages) break;
      if (totalChars + group.chars > effectiveBudget && selected.length > 0) break;

      selected.unshift(group);
      totalChars += group.chars;
      totalMessages += group.messages.length;
      truncatedCount += group.truncated;
    }

    // Flatten selected groups back into a message array (already in order)
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    for (const group of selected) {
      result.push(...group.messages);
    }

    // ── Pass 3: ensure conversation starts with a user message ──
    // Most providers require the first non-system message to be from the user.
    // When budget trimming drops the original user message, inject a synthetic one.
    if (result.length > 0 && result[0]!.role !== "user") {
      const contextMsg: OpenAI.ChatCompletionMessageParam = {
        role: "user",
        content: "Continue working on the current task. Use tools to make progress.",
      };
      const contextChars = this.estimateMessageChars(contextMsg);
      result.unshift(contextMsg);
      totalChars += contextChars;
      totalMessages++;
    }

    return { messages: result, totalChars, truncatedCount };
  }

  /**
   * Normalize a tool result message by truncating large content
   */
  private normalizeToolResult(
    msg: OpenAI.ChatCompletionMessageParam
  ): OpenAI.ChatCompletionToolMessageParam {
    const toolMsg = msg as OpenAI.ChatCompletionToolMessageParam;
    const content = toolMsg.content;

    if (typeof content === "string" && content.length > this.config.maxToolResultChars) {
      const halfSize = Math.floor(this.config.maxToolResultChars / 2);
      const truncated = 
        content.substring(0, halfSize) +
        `\n\n... [truncated ${content.length - this.config.maxToolResultChars} characters] ...\n\n` +
        content.substring(content.length - halfSize);
      
      return {
        ...toolMsg,
        content: truncated,
      };
    }

    return toolMsg;
  }

  /**
   * Estimate the character count for a message
   * Uses a simple heuristic: content length + some overhead for structure
   */
  private estimateMessageChars(msg: OpenAI.ChatCompletionMessageParam): number {
    let chars = 0;

    if ("content" in msg && msg.content) {
      if (typeof msg.content === "string") {
        chars += msg.content.length;
      } else {
        // Array of content parts
        chars += JSON.stringify(msg.content).length;
      }
    }

    if ("tool_calls" in msg && msg.tool_calls) {
      chars += JSON.stringify(msg.tool_calls).length;
    }

    // Add some overhead for message structure (role, etc.)
    chars += 50;

    return chars;
  }

  /**
   * Clear the session summary (for new sessions)
   */
  clearSummary(): void {
    this.sessionSummary = "";
  }
}
