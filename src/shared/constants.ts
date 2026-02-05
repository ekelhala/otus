/**
 * Otus System Constants
 */

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
  VSOCK_SOCKET: "./v.sock",
  /** VM configuration template */
  CONFIG_PATH: "./infra/vm-config.json",
  /** Kernel image path */
  KERNEL_PATH: "./infra/vmlinux.bin",
  /** Root filesystem image */
  ROOTFS_PATH: "./infra/rootfs.ext4",
} as const;

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
  DEFAULT_TIMEOUT: 300,
  /** Default working directory in guest */
  DEFAULT_CWD: "/workspace",
  /** Maximum number of ReAct loop iterations */
  MAX_ITERATIONS: 50,
  /** Maximum events to include in LLM context */
  MAX_CONTEXT_EVENTS: 3,
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
 * LLM Configuration
 */
export const LLM = {
  /** Anthropic model */
  MODEL: "claude-3-haiku-20240307",
  /** Maximum tokens for completion */
  MAX_TOKENS: 4096,
  /** Number of RAG results to include in context */
  RAG_RESULTS: 10,
} as const;
