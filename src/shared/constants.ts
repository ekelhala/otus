/**
 * Otus System Constants
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * System Paths - where VM assets are installed system-wide
 */
export const SYSTEM_PATHS = {
  /** System-wide Otus directory (production) */
  SYSTEM_DIR: "/etc/otus",
  /** Local development directory */
  LOCAL_DIR: "./infra",
} as const;

/**
 * VSock Configuration
 */
export const VSOCK = {
  /** Guest Context ID (assigned by Firecracker) */
  GUEST_CID: 3,
  /** Host Context ID (always 2 in Firecracker) */
  HOST_CID: 2,
  /** Port the guest agent listens on */
  AGENT_PORT: 9999,
} as const;

/**
 * Firecracker Configuration
 */
export const FIRECRACKER = {
  /** Unix socket for Firecracker API */
  API_SOCKET: "/tmp/firecracker.socket",
  /** Unix socket for VSock proxy */
  VSOCK_SOCKET: "/tmp/firecracker-vsock.socket",
  /** VM configuration template */
  CONFIG_PATH: "./infra/vm-config.json",
  /** Kernel image filename */
  KERNEL_FILENAME: "vmlinux.bin",
  /** Root filesystem image filename */
  ROOTFS_FILENAME: "rootfs.ext4",
} as const;

/**
 * VM Assets paths resolved at runtime.
 * Checks /etc/otus first (production), falls back to ./infra (development).
 */
export interface VMAssetPaths {
  kernelPath: string;
  rootfsPath: string;
  source: "system" | "local";
}

/**
 * Environment detection
 * Set OTUS_ENV=production for production mode
 */
export const isProduction = process.env.OTUS_ENV === "production";

/**
 * Resolve VM asset paths.
 * In production (OTUS_ENV=production): uses /etc/otus
 * In development: uses ./infra
 */
export function resolveVMAssets(): VMAssetPaths | null {
  if (isProduction) {
    // Production: only check system path
    const systemKernel = join(SYSTEM_PATHS.SYSTEM_DIR, FIRECRACKER.KERNEL_FILENAME);
    const systemRootfs = join(SYSTEM_PATHS.SYSTEM_DIR, FIRECRACKER.ROOTFS_FILENAME);
    
    if (existsSync(systemKernel) && existsSync(systemRootfs)) {
      return {
        kernelPath: systemKernel,
        rootfsPath: systemRootfs,
        source: "system",
      };
    }
    return null;
  }
  
  // Development: only check local path
  const localKernel = join(SYSTEM_PATHS.LOCAL_DIR, FIRECRACKER.KERNEL_FILENAME);
  const localRootfs = join(SYSTEM_PATHS.LOCAL_DIR, FIRECRACKER.ROOTFS_FILENAME);
  
  if (existsSync(localKernel) && existsSync(localRootfs)) {
    return {
      kernelPath: localKernel,
      rootfsPath: localRootfs,
      source: "local",
    };
  }
  
  return null;
}

/**
 * Get human-readable instructions for missing VM assets
 */
export function getVMAssetInstructions(): string {
  if (isProduction) {
    return `VM assets not found at ${SYSTEM_PATHS.SYSTEM_DIR}. Install vmlinux.bin and rootfs.ext4.`;
  }
  return `VM assets not found. Run ./infra/build-kernel.sh and ./infra/build-rootfs.sh`;
}

/**
 * Network Configuration
 */
export const NETWORK = {
  /** Bridge name for TAP devices */
  BRIDGE_NAME: "otus-br0",
  /** TAP device prefix */
  TAP_PREFIX: "otus-tap",
  /** Number of TAP devices in the pool */
  TAP_POOL_SIZE: 10,
  /** Bridge IP address (gateway for VMs) */
  BRIDGE_IP: "172.20.0.1",
  /** Network subnet */
  SUBNET: "172.20.0.0/24",
  /** Starting IP for guest VMs */
  GUEST_IP_START: 2,
} as const;

/**
 * Otus Workspace Structure
 */
export const WORKSPACE = {
  /** Hidden directory for Otus data */
  OTUS_DIR: ".otus",
  /** Configuration file */
  CONFIG_FILE: "config.json",
  /** SQLite database */
  MEMORY_DB: "memory.db",
  /** LanceDB directory */
  LANCEDB_DIR: "lancedb",
  /** Snapshots directory */
  SNAPSHOTS_DIR: "snapshots",
} as const;

/**
 * Execution Defaults
 */
export const EXECUTION = {
  /** Default command timeout in seconds */
  DEFAULT_TIMEOUT: 30,
  /** Default working directory in guest */
  DEFAULT_CWD: "/workspace",
  /** Maximum number of ReAct loop iterations */
  MAX_ITERATIONS: 50,
  /** Maximum events to include in LLM context */
  MAX_CONTEXT_EVENTS: 3,
  /** API call timeout in milliseconds (5 minutes) */
  API_TIMEOUT_MS: 5 * 60 * 1000,
} as const;

/**
 * Embedding Configuration
 */
export const EMBEDDINGS = {
  /** Voyage AI model name */
  MODEL: "voyage-code-3",
  /** Vector dimensions */
  DIMENSIONS: 1024,
  /** Maximum texts per batch embedding request */
  BATCH_SIZE: 128,
  /** Chunk size for code files (in tokens, approximate) */
  CHUNK_SIZE: 500,
} as const;

/**
 * LLM Configuration (via OpenRouter)
 */
export const LLM = {
  /** OpenRouter model identifier */
  MODEL: "google/gemini-3-flash-preview",
  /** Maximum tokens for completion */
  MAX_TOKENS: 4096,
  /** Number of RAG results to include in context */
  RAG_RESULTS: 10,
} as const;

/**
 * OpenRouter Configuration
 */
export const OPENROUTER = {
  /** OpenRouter API base URL */
  BASE_URL: "https://openrouter.ai/api/v1",
  /** App name for OpenRouter analytics */
  APP_NAME: "Otus",
  /** App URL for OpenRouter analytics */
  APP_URL: "https://github.com/otus-ai/otus",
} as const;

/**
 * Global Configuration (User's home directory)
 */
export const GLOBAL_CONFIG = {
  /** Global Otus directory in user's home */
  DIR: ".otus",
  /** Credentials file for API keys */
  CREDENTIALS_FILE: "credentials.json",
} as const;

/**
 * Daemon Configuration
 */
export const DAEMON = {
  /** Unix socket path for daemon communication */
  SOCKET_PATH: join(homedir(), ".otus", "daemon.sock"),
  /** PID file for daemon process */
  PID_FILE: join(homedir(), ".otus", "daemon.pid"),
} as const;

/**
 * Supported credential key names
 */
export const CREDENTIAL_KEYS = [
  "openrouter_api_key",
  "voyage_api_key",
] as const;

export type CredentialKey = typeof CREDENTIAL_KEYS[number];
