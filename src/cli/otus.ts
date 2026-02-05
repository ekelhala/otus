#!/usr/bin/env bun
/**
 * Otus CLI
 * Command-line interface for the Otus autonomous agent
 */

import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import prompts from "prompts";
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
    console.error("Error: ANTHROPIC_API_KEY not configured");
    console.error("\nSet it using one of:");
    console.error("  • otus config set anthropic_api_key");
    console.error("  • export ANTHROPIC_API_KEY='your-key'");
    process.exit(1);
  }

  if (!voyageApiKey) {
    console.error("Error: VOYAGE_API_KEY not configured");
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
  .option("--skip-checks", "Skip prerequisite checks (not recommended)")
  .action(async (options) => {
    const workspacePath = resolve(options.dir);
    console.log(`Initializing Otus in ${workspacePath}`);

    if (isInitialized(workspacePath)) {
      console.log("✓ Workspace already initialized");
      return;
    }

    const apiKeys = getApiKeys(workspacePath);

    const daemon = new OtusDaemon({
      workspacePath,
      ...apiKeys,
    });

    try {
      // Check prerequisites (unless skipped)
      if (!options.skipChecks) {
        console.log("\n[Checking prerequisites...]");
        const check = await daemon.checkPrerequisites();
        
        if (!check.ok) {
          console.error("\n✗ Missing prerequisites:");
          for (const issue of check.issues) {
            console.error(`  • ${issue}`);
          }
          console.error("\nPlease resolve these issues before initializing Otus.");
          console.error("Or run with --skip-checks to initialize anyway (not recommended).");
          process.exit(1);
        }
        console.log("✓ All prerequisites met");
      }

      await daemon.init();
      console.log("\n✓ Otus initialized successfully!");
      console.log("\nNext step:");
      console.log('  otus do "your task description"');
    } catch (error) {
      console.error("\n✗ Initialization failed:", error);
      process.exit(1);
    }
  });

/**
 * otus do "<task>"
 */
program
  .command("do")
  .description("Execute a task autonomously")
  .argument("<goal>", "Task description or goal")
  .option("-d, --dir <path>", "Workspace directory", process.cwd())
  .option("--otusignore-file <path>", "Path to .otusignore file (defaults to .otusignore in workspace root)")
  .option("--skip-checks", "Skip prerequisite checks (not recommended)")
  .action(async (goal, options) => {
    const workspacePath = resolve(options.dir);

    if (!isInitialized(workspacePath)) {
      console.error("Error: Workspace not initialized");
      console.error('Run "otus init" first');
      process.exit(1);
    }

    const apiKeys = getApiKeys(workspacePath);

    const daemon = new OtusDaemon({
      workspacePath,
      ...apiKeys,
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
        console.log("[Checking prerequisites...]");
        const check = await daemon.checkPrerequisites();
        
        if (!check.ok) {
          console.error("\n✗ Missing prerequisites:");
          for (const issue of check.issues) {
            console.error(`  • ${issue}`);
          }
          console.error("\nPlease resolve these issues before running tasks.");
          console.error("\nSetup steps:");
          console.error("  1. ./infra/setup-firecracker.sh");
          console.error("  2. ./infra/build-kernel.sh");
          console.error("  3. ./infra/build-rootfs.sh");
          process.exit(1);
        }
        console.log("✓ Prerequisites OK\n");
      }
      // Initialize (loads existing indexes)
      await daemon.init();

      // Execute task
      const result = await daemon.do(goal);

      // Display result
      console.log("\n" + "=".repeat(60));
      if (result.status === "completed") {
        console.log("✓ Task completed successfully");
      } else {
        console.log("✗ Task failed");
      }
      console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
      console.log("=".repeat(60));

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
      console.log("Status: Not initialized");
      console.log('Run "otus init" to get started');
      return;
    }

    console.log("Status: Initialized");
    console.log(`Workspace: ${workspacePath}`);

    const otusPath = resolve(workspacePath, WORKSPACE.OTUS_DIR);
    console.log(`Otus data: ${otusPath}`);

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
    console.log("Checking Otus prerequisites...\n");

    // We need minimal config to run checks
    // Use empty API keys since we're not actually running inference
    const daemon = new OtusDaemon({
      workspacePath: process.cwd(),
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || "check-mode",
      voyageApiKey: process.env.VOYAGE_API_KEY || "check-mode",
    });

    const check = await daemon.checkPrerequisites();

    if (check.ok) {
      console.log("✓ All prerequisites met! You're ready to use Otus.\n");
      console.log("Next steps:");
      console.log("  1. Set API keys:");
      console.log("     otus config set anthropic_api_key");
      console.log("     otus config set voyage_api_key");
      console.log("  2. Initialize workspace: otus init");
      console.log("  3. Run a task: otus do \"your task\"");
    } else {
      console.log("✗ Missing prerequisites:\n");
      for (const issue of check.issues) {
        console.log(`  • ${issue}`);
      }
      console.log("\nSetup steps:");
      console.log("  1. ./infra/setup-firecracker.sh    # Install Firecracker");
      console.log("  2. ./infra/build-kernel.sh          # Download Linux kernel");
      console.log("  3. ./infra/build-rootfs.sh          # Build guest filesystem");
      console.log("\nFor KVM access issues:");
      console.log("  sudo usermod -aG kvm $USER");
      console.log("  # Then log out and log back in");
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
      console.error(`Error: Invalid key '${key}'`);
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
          console.error("\nCancelled");
          process.exit(1);
        }
        
        apiKey = response.value;
      } catch (error) {
        console.error("\nError reading input");
        process.exit(1);
      }
    }

    if (!apiKey || apiKey.trim() === "") {
      console.error("Error: Value cannot be empty");
      process.exit(1);
    }

    // Save credential
    setCredential(key as CredentialKey, apiKey.trim());
    console.log(`✓ Set ${key}`);
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
      console.error(`Error: Invalid key '${key}'`);
      console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
      process.exit(1);
    }

    if (hasCredential(key as CredentialKey)) {
      console.log(`${key}: ***configured***`);
    } else {
      console.log(`${key}: not set`);
    }
  });

/**
 * otus config list
 */
configCmd
  .command("list")
  .description("List all API keys and their configuration status")
  .action(() => {
    console.log("API Key Configuration:\n");
    
    for (const key of CREDENTIAL_KEYS) {
      const status = hasCredential(key) ? "✓ configured" : "✗ not set";
      console.log(`  ${key.padEnd(20)} ${status}`);
    }
    
    console.log(`\nConfig file: ${getCredentialsPath()}`);
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
      console.error(`Error: Invalid key '${key}'`);
      console.error(`Valid keys: ${CREDENTIAL_KEYS.join(", ")}`);
      process.exit(1);
    }

    unsetCredential(key as CredentialKey);
    console.log(`✓ Removed ${key}`);
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
