#!/usr/bin/env bun
/**
 * Otus CLI
 * Command-line interface for the Otus autonomous agent
 */

import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { readFile } from "fs/promises";
import prompts from "prompts";
import chalk from "chalk";
import { WORKSPACE, CREDENTIAL_KEYS, DAEMON, type CredentialKey } from "@shared/constants.ts";
import { DaemonClient } from "./client.ts";
import type { InferenceEvent } from "@daemon/inference.ts";
import { 
  readCredentials, 
  setCredential, 
  getCredential, 
  unsetCredential,
  hasCredential,
  getConfiguredKeys,
  getCredentialsPath,
} from "@shared/credentials.ts";
import { initLogger, type Logger } from "@shared/logger.ts";

const program = new Command();

/**
 * Get API keys from environment or config
 * Priority: environment variables > ~/.otus/credentials.json
 */
function getApiKeys(workspacePath: string): {
  anthropicApiKey: string;
  voyageApiKey: string;
} {
  // Try environment variables first
  let anthropicApiKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_KEY;
  
  let voyageApiKey =
    process.env.VOYAGE_API_KEY ||
    process.env.VOYAGE_KEY;

  // Fall back to credentials file
  if (!anthropicApiKey || !voyageApiKey) {
    const credentials = readCredentials();
    
    if (!anthropicApiKey && credentials.anthropic_api_key) {
      anthropicApiKey = credentials.anthropic_api_key;
    }
    
    if (!voyageApiKey && credentials.voyage_api_key) {
      voyageApiKey = credentials.voyage_api_key;
    }
  }

  // Validate that we have both keys
  if (!anthropicApiKey) {
    console.error(chalk.red("Error: ANTHROPIC_API_KEY not configured"));
    console.error("\nSet it using one of:");
    console.error("  • otus config set anthropic_api_key");
    console.error("  • export ANTHROPIC_API_KEY='your-key'");
    process.exit(1);
  }

  if (!voyageApiKey) {
    console.error(chalk.red("Error: VOYAGE_API_KEY not configured"));
    console.error("\nSet it using one of:");
    console.error("  • otus config set voyage_api_key");
    console.error("  • export VOYAGE_API_KEY='your-key'");
    process.exit(1);
  }

  return { anthropicApiKey, voyageApiKey };
}

/**
 * Check if workspace is initialized
 */
function isInitialized(workspacePath: string): boolean {
  const otusPath = resolve(workspacePath, WORKSPACE.OTUS_DIR);
  return existsSync(otusPath);
}

/**
 * Check if daemon is running
 */
async function isDaemonRunning(): Promise<boolean> {
  try {
    const client = new DaemonClient();
    await client.health();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a user-friendly description for a tool call
 */
function getToolCallDescription(name: string, input: any): string {
  switch (name) {
    case "start_sandbox":
      const sandboxName = input?.name ? ` (${input.name})` : "";
      return `Starting sandbox environment${sandboxName}`;
    
    case "stop_sandbox":
      const sandboxId = input?.sandbox_id ? ` ${input.sandbox_id}` : "";
      return `Stopping sandbox${sandboxId}`;
    
    case "list_sandboxes":
      return "Listing active sandboxes";
    
    case "sync_workspace":
      if (input?.direction === "to_sandbox") {
        return "Syncing workspace files to sandbox";
      } else if (input?.direction === "from_sandbox") {
        return "Syncing changes from sandbox to host";
      }
      return "Syncing workspace";
    
    case "run_cmd":
      const cmd = input?.command || "";
      // Truncate very long commands
      const displayCmd = cmd.length > 60 ? cmd.substring(0, 57) + "..." : cmd;
      return `Running command: ${chalk.cyan(displayCmd)}`;
    
    case "search_code":
      const query = input?.query || "";
      return `Searching code for: ${chalk.cyan(query)}`;
    
    case "task_complete":
      return "Task complete";
    
    default:
      return `${name}`;
  }
}

/**
 * Render inference events to the console
 */
function renderEvent(event: InferenceEvent, logger: Logger): void {
  switch (event.type) {
    case "iteration":
      logger.debug(`Iteration ${event.current}/${event.max}`);
      break;
    case "thinking":
      console.log(chalk.gray(event.text));
      break;
    case "tool_call":
      const description = getToolCallDescription(event.name, event.input);
      console.log(chalk.blue("→"), description);
      if (logger.isVerbose() && event.input) {
        logger.debug(`  Input: ${JSON.stringify(event.input)}`);
      }
      break;
    case "tool_result":
      if (event.isError) {
        logger.error(`  Error: ${event.result}`);
      } else if (logger.isVerbose()) {
        logger.debug(`  Result: ${JSON.stringify(event.result)}`);
      }
      break;
    case "complete":
      if (event.summary) {
        logger.success(event.summary);
      }
      break;
    case "error":
      logger.error(event.message);
      break;
  }
}

program
  .name("otus")
  .description("Otus - An autonomous, local-first system engineering agent")
  .version("0.1.0");

/**
 * otus daemon
 */
const daemonCmd = program
  .command("daemon")
  .description("Manage the Otus daemon");

/**
 * otus daemon start
 */
daemonCmd
  .command("start")
  .description("Start the Otus daemon")
  .action(async () => {
    const logger = initLogger(false);

    // Check if already running
    if (await isDaemonRunning()) {
      logger.success("Daemon is already running");
      return;
    }

    logger.info("Starting Otus daemon...");

    // Get the path to the daemon entry point
    const daemonPath = new URL("../daemon/main.ts", import.meta.url).pathname;

    // Spawn daemon process in background
    const daemon = spawn("bun", ["run", daemonPath], {
      detached: true,
      stdio: "ignore",
    });

    daemon.unref();

    // Wait for daemon to start
    let retries = 10;
    while (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      
      if (await isDaemonRunning()) {
        // Read PID
        try {
          const pid = await readFile(DAEMON.PID_FILE, "utf-8");
          logger.success(`Daemon started (PID: ${pid.trim()})`);
        } catch {
          logger.success("Daemon started");
        }
        return;
      }
      
      retries--;
    }

    logger.error("Daemon failed to start within 5 seconds");
    process.exit(1);
  });

/**
 * otus daemon stop
 */
daemonCmd
  .command("stop")
  .description("Stop the Otus daemon")
  .action(async () => {
    const logger = initLogger(false);

    if (!(await isDaemonRunning())) {
      logger.warn("Daemon is not running");
      return;
    }

    logger.info("Stopping daemon...");

    try {
      const client = new DaemonClient();
      await client.shutdownDaemon();
      logger.success("Daemon stopped");
    } catch (error) {
      logger.error(`Failed to stop daemon: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  });

/**
 * otus daemon status
 */
daemonCmd
  .command("status")
  .description("Check daemon status")
  .action(async () => {
    const logger = initLogger(false);

    if (await isDaemonRunning()) {
      logger.success("Daemon is running");
      console.log(chalk.gray(`Socket: ${DAEMON.SOCKET_PATH}`));
      
      // Try to read PID
      try {
        const pid = await readFile(DAEMON.PID_FILE, "utf-8");
        console.log(chalk.gray(`PID: ${pid.trim()}`));
      } catch {
        // PID file doesn't exist
      }

      // Get VM pool stats
      try {
        const client = new DaemonClient();
        const health = await client.health();
        if (health.vmPool) {
          console.log(chalk.gray(`VM Pool: ${health.vmPool.available}/${health.vmPool.target} ready`));
        }
      } catch {
        // Ignore if we can't get stats
      }
    } else {
      logger.warn("Daemon is not running");
      console.log(chalk.gray('Run "otus daemon start" to start it'));
    }
  });

/**
 * otus init
 */
program
  .command("init")
  .description("Initialize Otus in the current workspace")
  .option("-d, --dir <path>", "Workspace directory", process.cwd())
  .option("-v, --verbose", "Show detailed debug output")
  .option("--skip-checks", "Skip prerequisite checks (not recommended)")
  .action(async (options) => {
    const logger = initLogger(options.verbose);
    const workspacePath = resolve(options.dir);
    logger.info(`Initializing Otus in ${workspacePath}`);

    if (isInitialized(workspacePath)) {
      logger.success("Workspace already initialized");
      return;
    }

    // Check if daemon is running
    if (!(await isDaemonRunning())) {
      logger.error("Daemon is not running");
      console.error('Run "otus daemon start" first');
      process.exit(1);
    }

    const apiKeys = getApiKeys(workspacePath);
    const client = new DaemonClient();

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        logger.startSpinner("Checking prerequisites...");
        const check = await client.checkPrerequisites(workspacePath);
        
        if (!check.ok) {
          logger.failSpinner("Missing prerequisites");
          for (const issue of check.issues) {
            logger.error(`  ${issue}`);
          }
          console.error("\nPlease resolve these issues before initializing Otus.");
          console.error("Or run with --skip-checks to initialize anyway (not recommended).");
          process.exit(1);
        }
        logger.succeedSpinner("All prerequisites met");
      }

      logger.startSpinner("Initializing workspace...");
      await client.init({
        workspacePath,
        ...apiKeys,
        verbose: options.verbose,
      });
      logger.succeedSpinner("Otus initialized successfully!");
      
      console.log("\nNext steps:");
      console.log('  otus chat         # Start an interactive session');
      console.log('  otus do "task"    # Execute a single task');
    } catch (error) {
      logger.failSpinner("Initialization failed");
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

/**
 * otus chat
 * Interactive chat session with the agent
 */
program
  .command("chat")
  .description("Start an interactive chat session with Otus")
  .option("-d, --dir <path>", "Workspace directory", process.cwd())
  .option("-v, --verbose", "Show detailed debug output")
  .option("--skip-checks", "Skip prerequisite checks (not recommended)")
  .action(async (options) => {
    const logger = initLogger(options.verbose);
    const workspacePath = resolve(options.dir);

    if (!isInitialized(workspacePath)) {
      logger.error("Workspace not initialized");
      console.error('Run "otus init" first');
      process.exit(1);
    }

    // Check if daemon is running
    if (!(await isDaemonRunning())) {
      logger.error("Daemon is not running");
      console.error('Run "otus daemon start" first');
      process.exit(1);
    }

    const apiKeys = getApiKeys(workspacePath);
    const client = new DaemonClient();

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        logger.startSpinner("Checking prerequisites...");
        const check = await client.checkPrerequisites(workspacePath);
        
        if (!check.ok) {
          logger.failSpinner("Missing prerequisites");
          for (const issue of check.issues) {
            logger.error(`  ${issue}`);
          }
          console.error("\nPlease resolve these issues before running.");
          process.exit(1);
        }
        logger.succeedSpinner("Prerequisites OK");
      }

      // Initialize workspace in daemon
      logger.startSpinner("Initializing...");
      await client.init({
        workspacePath,
        ...apiKeys,
        verbose: options.verbose,
      });
      logger.succeedSpinner("Ready");

      // Start chat session
      logger.startSpinner("Creating session...");
      const sessionId = await client.createSession({ workspacePath });
      logger.succeedSpinner("Session created");

      console.log("\n" + chalk.cyan("═".repeat(60)));
      console.log(chalk.bold.cyan("Otus Interactive Session"));
      console.log(chalk.gray("Type your requests. Press Ctrl+C to exit."));
      console.log(chalk.cyan("═".repeat(60)) + "\n");

      // Interactive loop using prompts
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const askQuestion = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
          rl.question(prompt, (answer) => {
            resolve(answer);
          });
        });
      };

      // Handle graceful shutdown
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        
        console.log("\n\nExiting...");
        rl.close();
        try {
          await client.endSession(sessionId);
        } catch {
          // Ignore errors during cleanup
        }
        process.exit(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      while (true) {
        try {
          const userInput = await askQuestion("\n> ");
          
          if (!userInput.trim()) {
            continue;
          }

          // Special commands
          if (userInput.toLowerCase() === "/quit" || userInput.toLowerCase() === "/exit") {
            console.log("\nGoodbye!");
            await client.endSession(sessionId);
            break;
          }

          if (userInput.toLowerCase() === "/help") {
            console.log("\nCommands:");
            console.log("  /quit, /exit  - Exit the session");
            console.log("  /help         - Show this help");
            console.log("\nJust type your request and press Enter to chat with Otus.");
            continue;
          }

          // Process with agent
          console.log("");
          for await (const event of client.sendMessage(sessionId, userInput)) {
            renderEvent(event, logger);
          }
        } catch (error) {
          if ((error as any).code === "ERR_USE_AFTER_CLOSE") {
            break;
          }
          console.error("\nError:", error instanceof Error ? error.message : error);
        }
      }

      rl.close();
      process.exit(0);
    } catch (error) {
      console.error("\n✗ Fatal error:", error);
      process.exit(1);
    }
  });

/**
 * otus do "<task>"
 * Single task execution (non-interactive)
 */
program
  .command("do")
  .description("Execute a single task autonomously (non-interactive)")
  .argument("<goal>", "Task description or goal")
  .option("-d, --dir <path>", "Workspace directory", process.cwd())
  .option("-v, --verbose", "Show detailed debug output")
  .option("--skip-checks", "Skip prerequisite checks (not recommended)")
  .action(async (goal, options) => {
    const logger = initLogger(options.verbose);
    const workspacePath = resolve(options.dir);

    if (!isInitialized(workspacePath)) {
      logger.error("Workspace not initialized");
      console.error('Run "otus init" first');
      process.exit(1);
    }

    // Check if daemon is running
    if (!(await isDaemonRunning())) {
      logger.error("Daemon is not running");
      console.error('Run "otus daemon start" first');
      process.exit(1);
    }

    const apiKeys = getApiKeys(workspacePath);
    const client = new DaemonClient();

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        logger.startSpinner("Checking prerequisites...");
        const check = await client.checkPrerequisites(workspacePath);
        
        if (!check.ok) {
          logger.failSpinner("Missing prerequisites");
          for (const issue of check.issues) {
            logger.error(`  ${issue}`);
          }
          console.error("\nPlease resolve these issues before running tasks.");
          console.error("\nSetup steps:");
          console.error("  1. ./infra/setup-firecracker.sh");
          console.error("  2. ./infra/build-kernel.sh");
          console.error("  3. ./infra/build-rootfs.sh");
          process.exit(1);
        }
        logger.succeedSpinner("Prerequisites OK");
      }

      // Execute task
      logger.info(`\nGoal: ${chalk.bold(goal)}\n`);
      const startTime = Date.now();
      let completed = false;
      let summary: string | undefined;

      for await (const event of client.runTask({
        workspacePath,
        goal,
        ...apiKeys,
        verbose: options.verbose,
      })) {
        renderEvent(event, logger);
        
        if (event.type === "complete") {
          completed = true;
          summary = event.summary;
        }
      }

      const duration = Date.now() - startTime;

      // Display result
      console.log("\n" + chalk.cyan("═".repeat(60)));
      if (completed) {
        logger.success("Task completed successfully");
      } else {
        logger.error("Task incomplete");
      }
      logger.info(`Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(chalk.cyan("═".repeat(60)));

      process.exit(completed ? 0 : 1);
    } catch (error) {
      console.error("\n✗ Fatal error:", error);
      process.exit(1);
    }
  });

/**
 * otus status
 */
program
  .command("status")
  .description("Show Otus workspace status")
  .option("-d, --dir <path>", "Workspace directory", process.cwd())
  .action(async (options) => {
    const workspacePath = resolve(options.dir);

    if (!isInitialized(workspacePath)) {
      console.log(chalk.yellow("Status: Not initialized"));
      console.log('Run "otus init" to get started');
      return;
    }

    console.log(chalk.green("Status: Initialized"));
    console.log(chalk.gray(`Workspace: ${workspacePath}`));

    const otusPath = resolve(workspacePath, WORKSPACE.OTUS_DIR);
    console.log(chalk.gray(`Otus data: ${otusPath}`));

    // TODO: Could add more status info:
    // - Recent tasks
    // - Indexed files count
    // - Last activity
  });

/**
 * otus check
 */
program
  .command("check")
  .description("Check system prerequisites for running Otus")
  .action(async () => {
    console.log(chalk.bold("Checking Otus prerequisites...\n"));

    // Check if daemon is running
    if (!(await isDaemonRunning())) {
      console.log(chalk.yellow("Note: Daemon is not running. Starting temporarily for checks..."));
      console.log(chalk.gray('(Run "otus daemon start" to start the daemon)\n'));
    }

    const client = new DaemonClient();
    
    try {
      const check = await client.checkPrerequisites(process.cwd());

      if (check.ok) {
        console.log(chalk.green("✓ All prerequisites met! You're ready to use Otus.\n"));
        console.log(chalk.bold("Next steps:"));
        console.log("  1. Set API keys:");
        console.log(chalk.gray("     otus config set anthropic_api_key"));
        console.log(chalk.gray("     otus config set voyage_api_key"));
        console.log("  2. Start daemon: " + chalk.cyan("otus daemon start"));
        console.log("  3. Initialize workspace: " + chalk.cyan("otus init"));
        console.log("  4. Run a task: " + chalk.cyan('otus do "your task"'));
      } else {
        console.log(chalk.red("✗ Missing prerequisites:\n"));
        for (const issue of check.issues) {
          console.log(chalk.yellow(`  • ${issue}`));
        }
        console.log(chalk.bold("\nSetup steps:"));
        console.log(chalk.gray("  1. ./infra/setup-firecracker.sh    # Install Firecracker"));
        console.log(chalk.gray("  2. ./infra/build-kernel.sh          # Download Linux kernel"));
        console.log(chalk.gray("  3. ./infra/build-rootfs.sh          # Build guest filesystem"));
        console.log(chalk.bold("\nFor KVM access issues:"));
        console.log(chalk.gray("  sudo usermod -aG kvm $USER"));
        console.log(chalk.gray("  # Then log out and log back in"));
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Daemon not running")) {
        console.log(chalk.red("✗ Could not connect to daemon"));
        console.log(chalk.gray('Run "otus daemon start" first'));
        process.exit(1);
      }
      throw error;
    }
  });

/**
 * otus config
 */
const configCmd = program
  .command("config")
  .description("Manage Otus configuration and API keys");

/**
 * otus config set <key> [value]
 */
configCmd
  .command("set")
  .description("Set an API key")
  .argument("<key>", `Key name (${CREDENTIAL_KEYS.join(", ")})`)
  .argument("[value]", "Key value (will prompt if not provided)")
  .action(async (key: string, value?: string) => {
    // Validate key name
    if (!CREDENTIAL_KEYS.includes(key as CredentialKey)) {
      console.error(chalk.red(`Error: Invalid key '${key}'`));
      console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
      process.exit(1);
    }

    // Get value interactively if not provided
    let apiKey = value;
    if (!apiKey) {
      try {
        const response = await prompts({
          type: 'password',
          name: 'value',
          message: `Enter ${key}:`,
        });
        
        if (!response.value) {
          console.error(chalk.yellow("\nCancelled"));
          process.exit(1);
        }
        
        apiKey = response.value;
      } catch (error) {
        console.error(chalk.red("\nError reading input"));
        process.exit(1);
      }
    }

    if (!apiKey || apiKey.trim() === "") {
      console.error(chalk.red("Error: Value cannot be empty"));
      process.exit(1);
    }

    // Save credential
    setCredential(key as CredentialKey, apiKey.trim());
    console.log(chalk.green(`✓ Set ${key}`));
  });

/**
 * otus config get <key>
 */
configCmd
  .command("get")
  .description("Check if an API key is configured (does not reveal value)")
  .argument("<key>", `Key name (${CREDENTIAL_KEYS.join(", ")})`)
  .action((key: string) => {
    // Validate key name
    if (!CREDENTIAL_KEYS.includes(key as CredentialKey)) {
      console.error(chalk.red(`Error: Invalid key '${key}'`));
      console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
      process.exit(1);
    }

    if (hasCredential(key as CredentialKey)) {
      console.log(`${key}: ${chalk.green("***configured***")}`);
    } else {
      console.log(`${key}: ${chalk.yellow("not set")}`);
    }
  });

/**
 * otus config list
 */
configCmd
  .command("list")
  .description("List all API keys and their configuration status")
  .action(() => {
    console.log(chalk.bold("API Key Configuration:\n"));
    
    for (const key of CREDENTIAL_KEYS) {
      const status = hasCredential(key) ? chalk.green("✓ configured") : chalk.yellow("✗ not set");
      console.log(`  ${key.padEnd(20)} ${status}`);
    }
    
    console.log(chalk.gray(`\nConfig file: ${getCredentialsPath()}`));
  });

/**
 * otus config unset <key>
 */
configCmd
  .command("unset")
  .description("Remove an API key from configuration")
  .argument("<key>", `Key name (${CREDENTIAL_KEYS.join(", ")})`)
  .action((key: string) => {
    // Validate key name
    if (!CREDENTIAL_KEYS.includes(key as CredentialKey)) {
      console.error(chalk.red(`Error: Invalid key '${key}'`));
      console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
      process.exit(1);
    }

    unsetCredential(key as CredentialKey);
    console.log(chalk.green(`✓ Removed ${key}`));
  });

/**
 * otus config path
 */
configCmd
  .command("path")
  .description("Show path to credentials file")
  .action(() => {
    console.log(getCredentialsPath());
  });

// Parse and execute
program.parse();
