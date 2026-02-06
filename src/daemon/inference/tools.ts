/**
 * Tool definitions for Claude
 */

import type Anthropic from "@anthropic-ai/sdk";

/**
 * Available tool names
 */
export type ToolName =
  | "start_sandbox"
  | "stop_sandbox"
  | "list_sandboxes"
  | "sync_workspace"
  | "start_session"
  | "send_to_session"
  | "read_session"
  | "list_sessions"
  | "kill_session"
  | "search_code"
  | "task_complete";

/**
 * Tool definitions for the Anthropic API
 */
export const tools: Anthropic.Tool[] = [
  {
    name: "start_sandbox",
    description:
      "Start a new isolated VM sandbox environment. The sandbox provides a safe Linux environment for executing commands. You must start a sandbox before running commands. You can have multiple sandboxes running simultaneously for testing different configurations.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Optional human-readable name for this sandbox (e.g., 'testing', 'build-env')",
        },
        sync_workspace: {
          type: "boolean",
          description:
            "Whether to sync the workspace files to the sandbox immediately (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "stop_sandbox",
    description:
      "Stop and destroy a sandbox VM. Any unsaved changes in the sandbox will be lost unless you sync back first.",
    input_schema: {
      type: "object",
      properties: {
        sandbox_id: {
          type: "string",
          description:
            "ID of the sandbox to stop. If not provided, stops the active sandbox.",
        },
        sync_back: {
          type: "boolean",
          description:
            "Whether to sync workspace changes back to host before stopping (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "list_sandboxes",
    description:
      "List all running sandboxes with their status, uptime, and IP addresses.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "sync_workspace",
    description:
      "Sync workspace files between host and sandbox. Use 'to_sandbox' to push files to the VM, or 'from_sandbox' to pull changes back to host.",
    input_schema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["to_sandbox", "from_sandbox"],
          description:
            "Direction of sync: 'to_sandbox' pushes host files to VM, 'from_sandbox' pulls VM changes to host",
        },
        sandbox_id: {
          type: "string",
          description:
            "ID of the sandbox to sync with. If not provided, uses the active sandbox.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "start_session",
    description:
      "Start a persistent tmux session for running long-lived processes (servers, watch modes, etc.). Sessions persist across tool calls and can capture output. Use this instead of backgrounding commands with &.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Unique name for the session (e.g., 'dev-server', 'tests')",
        },
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox. If not provided, uses the active sandbox.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "send_to_session",
    description:
      "Send a command to an existing tmux session. The command runs in the session's persistent shell. Great for starting servers, running watch modes, or any long-running process.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the session to send to",
        },
        command: {
          type: "string",
          description: "The command to send to the session",
        },
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox. If not provided, uses the active sandbox.",
        },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "read_session",
    description:
      "Read the current output from a tmux session. Use this to check on the status of a running process, see server logs, or check for errors.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the session to read from",
        },
        lines: {
          type: "number",
          description: "Number of lines of output to capture (default: 1000)",
        },
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox. If not provided, uses the active sandbox.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List all active tmux sessions in a sandbox. Shows session names, creation time, and number of windows.",
    input_schema: {
      type: "object",
      properties: {
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox. If not provided, uses the active sandbox.",
        },
      },
      required: [],
    },
  },
  {
    name: "kill_session",
    description:
      "Terminate a tmux session and its running processes. Use this to stop servers or clean up background processes when done.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the session to kill",
        },
        sandbox_id: {
          type: "string",
          description: "ID of the sandbox. If not provided, uses the active sandbox.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "search_code",
    description:
      "Semantically search the codebase for relevant code snippets. Use this to find existing implementations, understand architecture, or locate relevant files.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query describing what code you're looking for",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "task_complete",
    description:
      "Signal that the current task/request has been completed. Include a summary of what was accomplished. This ends the current turn and returns control to the user.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "A brief summary of what was accomplished",
        },
        lessons: {
          type: "array",
          items: { type: "string" },
          description: "Key lessons learned or important notes",
        },
      },
      required: ["summary"],
    },
  },
];
