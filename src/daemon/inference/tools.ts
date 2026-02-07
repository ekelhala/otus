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
  | "list_sandboxes"
  | "sync_workspace"
  | "start_terminal"
  | "send_to_terminal"
  | "read_terminal"
  | "list_terminals"
  | "kill_terminal"
  | "wait"
  | "search_code"
  | "docker-build"
  | "docker-run"
  | "docker-push"
  | "docker-stop"
  | "docker-logs"
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
        "Start a new isolated VM sandbox environment. The sandbox provides a safe Linux environment for executing commands. You must start a sandbox before running commands. You can have multiple sandboxes running simultaneously for testing different configurations.",
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
  },
  {
    type: "function",
    function: {
      name: "list_sandboxes",
      description:
        "List all running sandboxes with their status, uptime, and IP addresses.",
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
      name: "sync_workspace",
      description:
        "Sync workspace files between host and sandbox. Use 'to_sandbox' to push files to the VM, or 'from_sandbox' to pull changes back to host.",
      parameters: {
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
          sandbox_id: {
            type: "string",
            description: "ID of the sandbox. If not provided, uses the active sandbox.",
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
          sandbox_id: {
            type: "string",
            description: "ID of the sandbox. If not provided, uses the active sandbox.",
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
        "Read the current output/history from a terminal session. Shows what's currently visible in the terminal. Use this to check command results, see server logs, or check for errors.",
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
          sandbox_id: {
            type: "string",
            description: "ID of the sandbox. If not provided, uses the active sandbox.",
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
          sandbox_id: {
            type: "string",
            description: "ID of the sandbox. If not provided, uses the active sandbox.",
          },
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
          sandbox_id: {
            type: "string",
            description: "ID of the sandbox. If not provided, uses the active sandbox.",
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
      name: "docker-build",
      description:
        "Build a Docker image on the HOST from a Dockerfile in the user's workspace root (not inside the sandbox VM).",
      parameters: {
        type: "object",
        properties: {
          dockerfile: {
            type: "string",
            description:
              "Path to Dockerfile relative to the workspace root (default: 'Dockerfile')",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Image tags to apply (e.g., ['myapp:latest', 'myapp:v1.0'])",
          },
          build_args: {
            type: "object",
            description:
              "Build-time variables as key-value pairs (e.g., {'NODE_VERSION': '18'})",
          },
        },
        required: ["tags"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker-run",
      description:
        "Run a Docker container on the HOST (not inside the sandbox VM).",
      parameters: {
        type: "object",
        properties: {
          image: {
            type: "string",
            description: "Docker image to run (e.g., 'nginx:latest', 'myapp:v1')",
          },
          name: {
            type: "string",
            description: "Container name for easy reference",
          },
          ports: {
            type: "array",
            items: { type: "string" },
            description:
              "Port mappings in format 'host:container' (e.g., ['8080:80', '3000:3000'])",
          },
          environment: {
            type: "object",
            description:
              "Environment variables as key-value pairs (e.g., {'NODE_ENV': 'production'})",
          },
          detach: {
            type: "boolean",
            description:
              "Run container in background (default: true)",
          },
          command: {
            type: "string",
            description:
              "Command to run in container (overrides image CMD)",
          },
        },
        required: ["image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker-push",
      description:
        "Push a Docker image to a container registry from the HOST environment (not inside the sandbox VM).",
      parameters: {
        type: "object",
        properties: {
          image: {
            type: "string",
            description:
              "Image name and tag to push (e.g., 'username/myapp:latest', 'ghcr.io/user/app:v1')",
          },
        },
        required: ["image"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker-stop",
      description:
        "Stop one or more running Docker containers on the HOST environment.",
      parameters: {
        type: "object",
        properties: {
          containers: {
            type: "array",
            items: { type: "string" },
            description:
              "Container names or IDs to stop (e.g., ['web-server', 'db'])",
          },
          timeout: {
            type: "number",
            description:
              "Seconds to wait before killing container (default: 10)",
          },
        },
        required: ["containers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker-logs",
      description:
        "Fetch logs from a Docker container on the HOST environment.",
      parameters: {
        type: "object",
        properties: {
          container: {
            type: "string",
            description: "Container name or ID to get logs from",
          },
          follow: {
            type: "boolean",
            description:
              "Follow log output in real-time (default: false)",
          },
          tail: {
            type: "number",
            description:
              "Number of lines to show from end of logs (default: all)",
          },
          since: {
            type: "string",
            description:
              "Show logs since timestamp or relative (e.g., '2023-01-01T00:00:00', '10m')",
          },
          timestamps: {
            type: "boolean",
            description:
              "Show timestamps with log entries (default: false)",
          },
        },
        required: ["container"],
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
