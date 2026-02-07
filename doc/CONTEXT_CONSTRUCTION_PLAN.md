# Context Construction Plan

Date: 2026-02-07

## Goal
Improve the **quality and robustness** of the context passed to the LLM while keeping the system predictable and within a bounded prompt size.

This plan is scoped to the inference loop and prompt assembly (system prompt + conversation history + tool results).

## Non-goals
- Automatic retrieval (RAG) injected into every turn (we keep retrieval tool-driven for now).
- New UX features in the CLI beyond what is required to support the engine changes.
- Full transcript persistence (handled by the sessions plan).

## Current Behavior (Summary)
- Model input is built as:
  - `SYSTEM_PROMPT` (system)
  - `this.messages` (user + some assistant + tool messages)
- `this.messages` grows without bounds during a session.
- Tool outputs are injected verbatim into the conversation.
- Plan steps are injected as `role: "user"` messages (content originates from the model via the `plan` tool).
- Assistant messages are only persisted when they contain `tool_calls`. Otherwise, the engine appends `ACTION_PROMPT` as a new user message.

Key implementation: `src/daemon/inference/engine.ts`.

## Known Issues / Risks
### 1) Message ordering bug risk (tool calls)
When advancing plan steps, the engine can append the next step user message **before** tool results are appended, causing invalid ordering:

`assistant(tool_calls) → user(step) → tool(results)`

Correct ordering should be:

`assistant(tool_calls) → tool(results) → user(step)`

This can break tool-call semantics with providers.

### 2) Unbounded prompt growth
No pruning / summarization / budget enforcement.

### 3) Verbose tool outputs bloat context
Large terminal output / code snippets can overwhelm the prompt.

### 4) Authority channel risk in plan steps
Model-generated plan steps are injected as `role: "user"`, giving them the highest authority and enabling self-prompt-injection.

### 5) Repeated ACTION prompts
When the model returns text without tool calls, the engine appends `ACTION_PROMPT`; this can stack and waste tokens.

## Design Principles
- Keep context bounded with explicit budgets.
- Prefer engine-authored instructions over model-authored instructions in high-authority roles.
- Store large tool outputs out-of-band; keep only a compact summary in the prompt.
- Keep retrieval tool-driven (no automatic RAG injection in this plan).
- Prefer a bounded “recent messages window” over unbounded chat history.

## Proposed Changes
### A) Enforce valid tool-message ordering
- Defer plan step injection until after tool results are appended.
- Apply the same “defer until after tool results” approach for both:
  - plan activation
  - plan step advancement after `task_complete`

### B) Introduce a prompt context builder with budgets
Add an internal helper that builds the request messages under a budget.

Inputs:
- system prompt
- rolling session summary (engine-authored)
- recent messages window (bounded ring buffer)
- current step directive (engine-authored)

Budgeting approach:
- Use a conservative heuristic (e.g., chars/4) to estimate tokens.
- Prefer dropping / compressing oldest content first.

#### Recent messages window (definition)
Maintain an in-memory window of the most recent conversation messages needed for continuity.

Constraints:
- Keep last N messages (e.g., 20–60) AND enforce a max total character budget.
- Enforce per-message caps (especially for tool results).
- Preserve tool-call ordering invariants:
  - assistant message with `tool_calls` must be followed by its tool result messages.
  - do not persist “dangling” tool calls without tool results.

Notes:
- This window is what we include in model requests after the system prompt and session summary.
- This window is also what we persist in the workspace session record (see sessions plan) to support resume with better continuity than summary-only.

### C) Rolling session summary (engine-authored)
Maintain a compact “Session Summary” string updated after meaningful milestones:
- end of a turn
- after tool outputs that materially change state
- after plan step completion

Include this summary early in the prompt for continuity even when old turns are pruned.

On resume (sessions plan):
- Restore the recent messages window from the session record (sanitized + capped).
- Inject a single engine-authored “resume context” message derived from the rolling summary + current step.

### D) Tool output normalization
Before storing tool results as `role: "tool"` messages:
- cap size (max chars)
- redact obvious noise (e.g., repeated progress logs)
- store full output out-of-band (episodic memory or a workspace file) and include a pointer

### E) De-duplicate ACTION prompt
Avoid appending `ACTION_PROMPT` repeatedly.

### F) Safer plan step injection
Instead of injecting raw step text as a user message:
- store plan steps internally
- inject an engine-authored directive that references the current step
- validate plan size and step length limits before accepting

## Implementation Steps
1. Fix ordering: defer next-step injection until after tool results.
2. Add prompt builder and hook it into the model call.
3. Add rolling summary state and update logic.
4. Add tool output truncation + out-of-band storage.
5. De-duplicate ACTION prompt.
6. Refactor plan step injection to engine-authored directives + validation.

## Acceptance Criteria
- Tool-call ordering is always valid.
- Prompt size is bounded; long sessions remain stable.
- Large tool outputs do not dominate the prompt.
- Resuming after many turns still “remembers” key context via the rolling summary.
- Resuming restores a bounded recent-messages window for local continuity.
- Plan steps do not allow the model to escalate authority by self-injecting user instructions.

## Testing / Verification
- Add a regression test for plan progression ordering.
- Manual: run an interactive session, trigger large tool outputs, and confirm prompt stays bounded and tool calls keep working.

## Open Questions
- Where should out-of-band tool outputs be stored by default?
  - episodic DB reflections
  - files under `.otus/` (easier to inspect)
- How strict should truncation be for different tools (terminal vs code search vs file reads)?
