#!/usr/bin/env bun
/**
 * Otus Daemon Entry Point
 * Starts the daemon HTTP server on Unix socket
 */

import { mkdir, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { DaemonServer } from "./server.ts";
import { DAEMON } from "@shared/constants.ts";
import { initLogger } from "@shared/logger.ts";
import { cleanupOrphanedTempRootfs, cleanupAllTempRootfs } from "./firecracker.ts";

const logger = initLogger(false);

/**
 * Ensure the .otus directory exists
 */
async function ensureOtusDir(): Promise<void> {
  const otusDir = dirname(DAEMON.SOCKET_PATH);
  if (!existsSync(otusDir)) {
    await mkdir(otusDir, { recursive: true });
  }
}

/**
 * Write PID file
 */
async function writePidFile(): Promise<void> {
  await writeFile(DAEMON.PID_FILE, String(process.pid));
}

/**
 * Remove stale socket file if it exists
 */
async function cleanupStaleSocket(): Promise<void> {
  if (existsSync(DAEMON.SOCKET_PATH)) {
    logger.debug("Removing stale socket file...");
    await unlink(DAEMON.SOCKET_PATH);
  }
}

/**
 * Cleanup on shutdown
 */
async function cleanup(): Promise<void> {
  logger.debug("Cleaning up...");
  
  // Remove socket file
  if (existsSync(DAEMON.SOCKET_PATH)) {
    await unlink(DAEMON.SOCKET_PATH);
  }

  // Remove PID file
  if (existsSync(DAEMON.PID_FILE)) {
    await unlink(DAEMON.PID_FILE);
  }

  // Clean up any remaining temp rootfs files from this process
  await cleanupAllTempRootfs();
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log("🦉 Otus Daemon");
  console.log("═══════════════════════════════════════");

  try {
    // Clean up orphaned temp rootfs files from previous runs
    const cleanedCount = await cleanupOrphanedTempRootfs();
    if (cleanedCount > 0) {
      console.log(`✓ Cleaned up ${cleanedCount} orphaned temp rootfs file(s)`);
    }

    // Ensure .otus directory exists
    await ensureOtusDir();

    // Clean up stale socket
    await cleanupStaleSocket();

    // Write PID file
    await writePidFile();

    // Create and start server
    const server = new DaemonServer();
    await server.start();

    console.log(`✓ Daemon started`);
    console.log(`  Socket: ${DAEMON.SOCKET_PATH}`);
    console.log(`  PID: ${process.pid}`);
    console.log(`\nPress Ctrl+C to stop\n`);

    // Handle graceful shutdown
    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;

      console.log(`\n\nReceived ${signal}, shutting down...`);
      
      try {
        await server.stop();
        await cleanup();
        console.log("Goodbye!");
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        process.exit(1);
      }
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Handle uncaught errors - try to cleanup before exit
    process.on("uncaughtException", async (error) => {
      console.error("Uncaught exception:", error);
      await shutdown("uncaughtException");
    });

    process.on("unhandledRejection", async (reason) => {
      console.error("Unhandled rejection:", reason);
      await shutdown("unhandledRejection");
    });

    // Keep process alive
    await new Promise(() => {});
  } catch (error) {
    console.error("Failed to start daemon:", error);
    await cleanup();
    process.exit(1);
  }
}

main();
