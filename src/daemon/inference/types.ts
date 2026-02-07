/**
 * Types for the inference engine
 */

import type { SandboxManager } from "../sandbox.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { SemanticMemory } from "../memory/semantic.ts";
import type { Logger } from "@shared/logger.ts";
import type { ContextBuilderConfig } from "./context-builder.ts";

/**
 * Stream event types for inference
 */
export type InferenceEvent =
  | { type: "iteration"; current: number; max: number }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown; isError?: boolean }
  | { type: "plan_created"; steps: string[]; currentStep: number }
  | { type: "plan_step_complete"; completedStep: number; nextStep: number; totalSteps: number }
  | { type: "complete"; summary?: string }
  | { type: "error"; message: string }
  | { type: "max_iterations_reached"; current: number }
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
  /** OpenRouter model identifier */
  model?: string;
  /** Context builder configuration (optional, uses defaults if not provided) */
  contextConfig?: Partial<ContextBuilderConfig>;
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
