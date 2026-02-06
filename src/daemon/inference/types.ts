/**
 * Types for the inference engine
 */

import type { SandboxManager } from "../sandbox.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { SemanticMemory } from "../memory/semantic.ts";
import type { Logger } from "@shared/logger.ts";

/**
 * Stream event types for inference
 */
export type InferenceEvent =
  | { type: "iteration"; current: number; max: number }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown; isError?: boolean }
  | { type: "complete"; summary?: string }
  | { type: "error"; message: string }
  | { type: "stream_end" }; // Internal signal for SSE stream completion

/**
 * Configuration for the inference engine
 */
export interface InferenceEngineConfig {
  apiKey: string;
  sandboxManager: SandboxManager;
  episodicMemory: EpisodicMemory;
  semanticMemory: SemanticMemory;
  workspacePath: string;
  logger: Logger;
}

/**
 * Result of processing a single iteration
 */
export interface IterationResult {
  complete: boolean;
  summary?: string;
}

/**
 * Tool result for OpenAI API format
 */
export interface ToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/**
 * Result of executing a single tool call
 */
export interface ToolCallResult {
  toolResult: ToolResultMessage;
  isTaskComplete: boolean;
  summary?: string;
}
