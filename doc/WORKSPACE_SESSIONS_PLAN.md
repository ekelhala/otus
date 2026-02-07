# Workspace-Scoped Sessions Plan

Date: 2026-02-07

## Goal
Persist chat sessions **per workspace** so that `otus chat` can:
- offer a picker of prior sessions for that workspace
- resume where it left off (summary-based resume)
- start a new session

This plan assumes:
- Resume uses **rolling summary + a bounded recent-messages window** (not full transcript replay).
- Only **one active session per workspace** at a time (no concurrency requirement).
- Old context is compacted via per-session caps (summary + recent-message window compaction).

## Non-goals
- Full transcript persistence / replay into `InferenceEngine.messages`.
- Cross-workspace sessions.
- Concurrent sessions within a workspace.

## Current Behavior (Summary)
- CLI:
  - resolves `workspacePath` (default cwd)
  - calls daemon `/init`
  - calls daemon `POST /sessions` to create a new session
  - streams events via `POST /sessions/:id/messages`
- Daemon:
  - keeps sessions in memory only (`Map`)
  - after restart, sessions are lost
- Engine:
  - stores session state (`sessionId`, `messages`, plan state) in memory

Per-workspace persistence already exists via SQLite at `<workspace>/.otus/memory.db` (episodic memory).

## Proposed Persistence Model
### Store sessions in the per-workspace SQLite DB
Extend `EpisodicMemory` schema to include `chat_sessions`:

Fields (proposed):
- `session_id` TEXT PRIMARY KEY
- `title` TEXT
- `model` TEXT
- `status` TEXT CHECK(status IN ('active', 'closed', 'archived'))
- `created_at` INTEGER
- `updated_at` INTEGER
- `summary` TEXT
- `recent_messages` TEXT (JSON)
- `plan_steps` TEXT (JSON)
- `current_step_index` INTEGER
- `awaiting_continuation` INTEGER (0/1)
- `paused` INTEGER (0/1)

Notes:
- Summary is engine-authored (not model-authored).
- Plan state is persisted to support step-by-step resume.
- `recent_messages` is a **bounded ring buffer** of the most recent conversation messages needed for good continuity.

### Recent-messages format (proposed)
Store `recent_messages` as JSON array of a restricted subset of `OpenAI.ChatCompletionMessageParam`:
- `role` is one of `system | user | assistant | tool`
- `content` is string (capped)
- tool-call metadata should be stored only if needed to preserve valid ordering. If stored:
  - assistant tool-call messages must be followed by their tool result messages.

Implementation constraints:
- Keep only the last **N messages** (e.g., 20–60), and also enforce a max total size in characters.
- Tool outputs should be truncated before being persisted into `recent_messages`.
- The rolling summary remains the primary long-term memory; `recent_messages` is for local continuity.

## Daemon API Changes
### List sessions for a workspace
Add:
- `GET /workspaces/:encodedPath/sessions`

Returns an array of session descriptors:
- `sessionId`
- `title`
- `model`
- `status`
- `updatedAt`

### Create or resume a session
Extend existing:
- `POST /sessions`

Request body:
- `workspacePath: string`
- optional `sessionId: string` (if provided, resume)

Behavior:
- If `sessionId` omitted → create new persisted session and start.
- If `sessionId` provided → load persisted state and resume.

### End session
Existing `DELETE /sessions/:id` should:
- remove in-memory mapping
- update persisted `chat_sessions.status` to `closed`
- update `updated_at`

## WorkspaceContext Changes
Add methods:
- `listSessions()` → queries episodic memory
- `startSession()` → creates persisted record and starts engine session
- `resumeSession(sessionId)` → loads persisted record and tells engine to resume

Enforce “one active session per workspace”:
- if a session is active and another is started/resumed, end/close the previous one first (or return a clear error).

## InferenceEngine Changes (Summary-based Resume)
Add:
- `resumeSession(sessionId, persistedState)`

Engine state to restore:
- `sessionId`
- plan steps and current step index
- `awaitingContinuation` and `paused`

How to seed context on resume:
- Restore `this.messages` from persisted `recent_messages` (sanitized + capped), then inject a single engine-authored message that provides:
  - saved rolling summary
  - current plan step (if any)
  - instruction to continue from here

Persist updates:
- On each user message, assistant tool-call message, and tool result message, update the in-memory recent-message window.
- Periodically (end of turn / step completion / session end), flush the window into `chat_sessions.recent_messages`.
- Always enforce caps when writing.
Also persist:
- on turn completion and/or tool milestones, update `chat_sessions.summary` and `updated_at`
- compact the summary when it grows beyond a cap

## CLI Changes (Session Picker)
In `otus chat`:
1. Call `/init` as today.
2. Call `GET /workspaces/:encodedPath/sessions`.
3. If sessions exist, prompt user to:
   - Resume one of them
   - Start new session

Optional flags (minimal):
- `--new` to skip the picker
- `--session <id>` to resume directly

## Retention / Compaction
Since full transcripts aren’t stored, growth is dominated by:
- `summary`
- `recent_messages`

Compaction rules:
- cap `summary` size (chars); when exceeded, rewrite into a shorter condensed form
- cap `recent_messages` count (N messages)
- cap per-message size (chars)
- cap total `recent_messages` JSON size (chars)

## Acceptance Criteria
- After daemon restart, `otus chat` can list prior sessions for a workspace.
- User can resume a session and the agent continues from the saved summary + recent-messages window + plan state.
- Starting a new session does not overwrite older sessions.
- Only one session is active per workspace at a time.

## Testing / Verification
- Unit test: create/list/get/update chat session records in episodic memory (including recent_messages JSON).
- Manual:
  - create session, exit, restart daemon, resume, verify continuity via summary

## Open Questions
- Where should “title” come from?
  - answer: Should be first user message (truncated)
- Should “closed” sessions be resumable by default?
  - answer: yes (resumable), with an archive/delete command later
