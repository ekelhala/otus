#!/usr/bin/env bun
/**
 * Otus CLI
 * Command-line interface for the Otus autonomous agent
 */

import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import prompts from "prompts";
import chalk from "chalk";
import { WORKSPACE, CREDENTIAL_KEYS, type CredentialKey } from "@shared/constants.ts";
import { OtusDaemon } from "@daemon/index.ts";
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

program
  .name("otus")
  .description("Otus - An autonomous, local-first system engineering agent")
  .version("0.1.0");

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

    const apiKeys = getApiKeys(workspacePath);

    const daemon = new OtusDaemon({
      workspacePath,
      ...apiKeys,
      verbose: options.verbose,
    });

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        logger.startSpinner("Checking prerequisites...");
        const check = await daemon.checkPrerequisites();
        
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
      await daemon.init();
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

    const apiKeys = getApiKeys(workspacePath);

    const daemon = new OtusDaemon({
      workspacePath,
      ...apiKeys,
      verbose: options.verbose,
    });

    // Handle graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      
      console.log("\n\nReceived interrupt signal, shutting down...");
      await daemon.shutdown();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        logger.startSpinner("Checking prerequisites...");
        const check = await daemon.checkPrerequisites();
        
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

      // Initialize
      logger.startSpinner("Initializing...");
      await daemon.init();
      logger.succeedSpinner("Ready");

      // Start chat session
      const session = daemon.startChat();
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

      while (true) {
        try {
          const userInput = await askQuestion("\n> ");
          
          if (!userInput.trim()) {
            continue;
          }

          // Special commands
          if (userInput.toLowerCase() === "/quit" || userInput.toLowerCase() === "/exit") {
            console.log("\nGoodbye!");
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
          logger.startSpinner("Processing...");
          const result = await session.chat(userInput);
          logger.stopSpinner();
          
          if (result.summary) {
            logger.success(result.summary);
          }
        } catch (error) {
          if ((error as any).code === "ERR_USE_AFTER_CLOSE") {
            break;
          }
          console.error("\nError:", error instanceof Error ? error.message : error);
        }
      }

      rl.close();
      await daemon.shutdown();
      process.exit(0);
    } catch (error) {
      console.error("\n✗ Fatal error:", error);
      await daemon.shutdown();
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

    const apiKeys = getApiKeys(workspacePath);

    const daemon = new OtusDaemon({
      workspacePath,
      ...apiKeys,
      verbose: options.verbose,
    });

    // Handle graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      
      console.log("\n\nReceived interrupt signal, shutting down...");
      await daemon.shutdown();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        logger.startSpinner("Checking prerequisites...");
        const check = await daemon.checkPrerequisites();
        
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
      // Initialize (loads existing indexes)
      logger.startSpinner("Initializing...");
      await daemon.init();
      logger.succeedSpinner("Ready");

      // Execute task
      logger.info(`\nGoal: ${chalk.bold(goal)}\n`);
      logger.startSpinner("Working on task...");
      const result = await daemon.do(goal);
      logger.stopSpinner();

      // Display result
      console.log("\n" + chalk.cyan("═".repeat(60)));
      if (result.status === "completed") {
        logger.success("Task completed successfully");
      } else {
        logger.error("Task failed");
      }
      logger.info(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
      console.log(chalk.cyan("═".repeat(60)));

      await daemon.shutdown();
      process.exit(result.status === "completed" ? 0 : 1);
    } catch (error) {
      console.error("\n✗ Fatal error:", error);
      await daemon.shutdown();
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

    // We need minimal config to run checks
    // Use empty API keys since we're not actually running inference
    const daemon = new OtusDaemon({
      workspacePath: process.cwd(),
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || "check-mode",
      voyageApiKey: process.env.VOYAGE_API_KEY || "check-mode",
    });

    const check = await daemon.checkPrerequisites();

    if (check.ok) {
      console.log(chalk.green("✓ All prerequisites met! You're ready to use Otus.\n"));
      console.log(chalk.bold("Next steps:"));
      console.log("  1. Set API keys:");
      console.log(chalk.gray("     otus config set anthropic_api_key"));
      console.log(chalk.gray("     otus config set voyage_api_key"));
      console.log("  2. Initialize workspace: " + chalk.cyan("otus init"));
      console.log("  3. Run a task: " + chalk.cyan('otus do "your task"'));
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
