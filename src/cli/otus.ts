#!/usr/bin/env bun
/**
 * Otus CLI
 * Command-line interface for the Otus autonomous agent
 */

import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import { WORKSPACE } from "@shared/constants.ts";
import { OtusDaemon } from "@daemon/index.ts";

const program = new Command();

/**
 * Get API keys from environment or config
 */
function getApiKeys(workspacePath: string): {
  anthropicApiKey: string;
  voyageApiKey: string;
} {
  // Try environment variables first
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_KEY;
  
  const voyageApiKey =
    process.env.VOYAGE_API_KEY ||
    process.env.VOYAGE_KEY;

  // TODO: Could also read from .otus/config.json if we want to support that

  if (!anthropicApiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable not set");
    process.exit(1);
  }

  if (!voyageApiKey) {
    console.error("Error: VOYAGE_API_KEY environment variable not set");
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
      console.log("     export ANTHROPIC_API_KEY='your-key'");
      console.log("     export VOYAGE_API_KEY='your-key'");
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

// Parse and execute
program.parse();
