/**
 * Tool definitions for OpenAI-compatible API (via OpenRouter)
 */

import type OpenAI from "openai";

/**
 * Available tool names
 */
export type ToolName =
  | "start_sandbox"
  | "stop_sandbox"
  | "sync_workspace"
  | "get_otusignore"
  | "start_terminal"
  | "send_to_terminal"
  | "read_terminal"
  | "list_terminals"
  | "kill_terminal"
  | "wait"
  | "search_code"
  | "docker"
  | "plan"
  | "task_complete";

/**
 * Tool definitions for the OpenAI-compatible API
 */
export const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "start_sandbox",
      description:
        "Start the isolated VM sandbox environment. The sandbox provides a safe Linux environment for executing commands. You must start the sandbox before running commands. Only one sandbox is supported at a time; calling start_sandbox again returns the existing sandbox.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "stop_sandbox",
      description:
        "Stop and destroy a sandbox VM. Any unsaved changes in the sandbox will be lost unless you sync back first.",
      parameters: {
        type: "object",
        properties: {
          sync_back: {
            type: "boolean",
            description:
              "Whether to sync workspace changes back to host before stopping (default: true)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sync_workspace",
      description:
        "Sync workspace files between host and sandbox. Uses patterns from .otusignore to EXCLUDE files/paths from sync in BOTH directions. Use 'to_sandbox' to push files to the VM, or 'from_sandbox' to pull changes back to host.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["to_sandbox", "from_sandbox"],
            description:
              "Direction of sync: 'to_sandbox' pushes host files to VM, 'from_sandbox' pulls VM changes to host",
          },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_otusignore",
      description:
        "Show the active .otusignore exclude patterns used during workspace sync (to/from sandbox). Use this when you are unsure why a file didn’t sync.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_terminal",
      description:
        "Start a new persistent terminal session in the sandbox. Use this to run long-running processes, interactive commands, or servers. Each terminal persists until explicitly killed.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Unique name for this terminal (e.g., 'server', 'build', 'tests')",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_to_terminal",
      description:
        "Send a command to an existing terminal session. The command executes in that terminal's shell context. Great for starting servers, running builds, or any long-running process.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the terminal to send the command to",
          },
          command: {
            type: "string",
            description: "The command to execute in the terminal",
          },
        },
        required: ["name", "command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_terminal",
      description:
        "Read output/history from a terminal session (tmux capture-pane). By default, returns only NEW output since the last read for that terminal (incremental). Set incremental=false to return the full captured output.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the terminal to read from",
          },
          lines: {
            type: "number",
            description: "Number of lines of output to capture (default: 1000)",
          },
          incremental: {
            type: "boolean",
            description:
              "When true (default), return only output appended since last read for this terminal. When false, return the full capture-pane output.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_terminals",
      description:
        "List all active terminal sessions in the sandbox. Shows terminal names and status.",
      parameters: {
        type: "object",
        properties: {
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_terminal",
      description:
        "Terminate a terminal session and all processes running in it. Use this to stop servers or clean up background processes when done.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the terminal to kill",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description:
        "Wait for a specified duration. Use this to give processes time to complete (installations, server startup, builds, etc.) instead of immediately checking results. Shows the user what you're waiting for.",
      parameters: {
        type: "object",
        properties: {
          duration: {
            type: "number",
            description: "How many seconds to wait (e.g., 5 for installs, 10 for server startup)",
          },
          reason: {
            type: "string",
            description: "What you're waiting for (shown to user, e.g., 'npm install to complete', 'server to start')",
          },
        },
        required: ["duration", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description:
        "Semantically search the codebase for relevant code snippets. Use this to find existing implementations, understand architecture, or locate relevant files.",
      parameters: {
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
  },
  {
    type: "function",
    function: {
      name: "docker",
      description:
        "Execute Docker commands on the HOST machine within the project workspace context (not inside the sandbox VM). All commands run with the workspace as the working directory. Use this for building images, running containers, managing Docker resources, etc.",
      parameters: {
        type: "object",
        properties: {
          command: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } }
            ],
            description:
              "Docker command to execute. Can be a string (e.g., 'build -t myapp:latest .') or array (e.g., ['build', '-t', 'myapp:latest', '.']). Common commands: build, run, push, pull, logs, ps, stop, rm, exec, compose. The workspace directory is automatically set as the working directory.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "plan",
      description:
        "Break down a complex task into clear, sequential steps. Use this when the user's request requires multiple distinct actions or phases. Each step should be focused and actionable. After calling this tool, you'll work through each step one at a time.",
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of step descriptions. Each step should be clear and actionable, representing one focused task to complete.",
          },
        },
        required: ["steps"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_complete",
      description:
        "Signal that the current task/request has been completed. Include a summary of what was accomplished. This ends the current turn and returns control to the user.",
      parameters: {
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
  },
];
