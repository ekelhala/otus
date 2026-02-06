/**
 * Inference module - ReAct loop and tool execution
 */

// Re-export types
export type {
  InferenceEvent,
  InferenceEngineConfig,
  IterationResult,
  ToolCallResult,
} from "./types.ts";

// Re-export engine
export { InferenceEngine } from "./engine.ts";

// Re-export tools for reference
export { tools, type ToolName } from "./tools.ts";

// Re-export prompts for customization
export { buildInitialPrompt, ACTION_PROMPT } from "./prompts.ts";

// Re-export tool handlers for extension
export { ToolHandlers, type ToolHandlersConfig } from "./tool-handlers.ts";
