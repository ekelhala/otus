/**
 * Otus Protocol Definitions
 * Defines the API contract between daemon and agent
 */

import { z } from "zod";

/**
 * Execute Command Request
 * Tells the guest agent to run a shell command
 */
export const ExecuteRequestSchema = z.object({
  command: z.string().describe("The shell command to execute"),
  cwd: z.string().optional().describe("Working directory (default: /workspace)"),
  timeout: z.number().optional().describe("Timeout in seconds (default: 300)"),
  env: z
    .record(z.string())
    .optional()
    .describe("Additional environment variables"),
});

export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

/**
 * Execute Command Response
 * Returns the output and exit code from the command
 */
export const ExecuteResponseSchema = z.object({
  stdout: z.string().describe("Standard output from the command"),
  stderr: z.string().describe("Standard error from the command"),
  exitCode: z.number().describe("Process exit code"),
  durationMs: z.number().describe("Execution time in milliseconds"),
  timedOut: z.boolean().optional().describe("Whether the command timed out"),
});

export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>;

/**
 * Health Check Request
 * Verifies the guest agent is responsive
 */
export const HealthCheckRequestSchema = z.object({});

export type HealthCheckRequest = z.infer<typeof HealthCheckRequestSchema>;

/**
 * Health Check Response
 */
export const HealthCheckResponseSchema = z.object({
  status: z.literal("ok"),
  uptime: z.number().describe("Agent uptime in seconds"),
  hostname: z.string(),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

/**
 * RPC Method Names
 */
export const RPCMethod = {
  EXECUTE: "execute",
  HEALTH: "health",
  READ_FILE: "read_file",
  WRITE_FILE: "write_file",
  LIST_DIR: "list_dir",
  SYNC_TO_GUEST: "sync_to_guest",
  SYNC_FROM_GUEST: "sync_from_guest",
} as const;

/**
 * Read File Request - read a file from guest filesystem
 */
export const ReadFileRequestSchema = z.object({
  path: z.string().describe("Absolute path to the file"),
});

export type ReadFileRequest = z.infer<typeof ReadFileRequestSchema>;

/**
 * Read File Response
 */
export const ReadFileResponseSchema = z.object({
  content: z.string().describe("Base64 encoded file content"),
  exists: z.boolean(),
  size: z.number().optional(),
});

export type ReadFileResponse = z.infer<typeof ReadFileResponseSchema>;

/**
 * Write File Request - write a file to guest filesystem
 */
export const WriteFileRequestSchema = z.object({
  path: z.string().describe("Absolute path for the file"),
  content: z.string().describe("Base64 encoded file content"),
  mode: z.number().optional().describe("File permissions (default: 0o644)"),
});

export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

/**
 * Write File Response
 */
export const WriteFileResponseSchema = z.object({
  success: z.boolean(),
  bytesWritten: z.number(),
});

export type WriteFileResponse = z.infer<typeof WriteFileResponseSchema>;

/**
 * List Directory Request
 */
export const ListDirRequestSchema = z.object({
  path: z.string().describe("Directory path to list"),
  recursive: z.boolean().optional().describe("List recursively"),
});

export type ListDirRequest = z.infer<typeof ListDirRequestSchema>;

/**
 * Directory Entry
 */
export const DirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  size: z.number(),
  mtime: z.number().describe("Modification time as unix timestamp"),
});

export type DirEntry = z.infer<typeof DirEntrySchema>;

/**
 * List Directory Response
 */
export const ListDirResponseSchema = z.object({
  entries: z.array(DirEntrySchema),
});

export type ListDirResponse = z.infer<typeof ListDirResponseSchema>;

/**
 * Sync To Guest Request - batch write multiple files
 */
export const SyncToGuestRequestSchema = z.object({
  files: z.array(z.object({
    path: z.string().describe("Relative path within workspace"),
    content: z.string().describe("Base64 encoded content"),
    mode: z.number().optional(),
  })),
  basePath: z.string().optional().describe("Base path (default: /workspace)"),
});

export type SyncToGuestRequest = z.infer<typeof SyncToGuestRequestSchema>;

/**
 * Sync To Guest Response
 */
export const SyncToGuestResponseSchema = z.object({
  filesWritten: z.number(),
  errors: z.array(z.object({
    path: z.string(),
    error: z.string(),
  })),
});

export type SyncToGuestResponse = z.infer<typeof SyncToGuestResponseSchema>;

/**
 * Sync From Guest Request - get all modified files
 */
export const SyncFromGuestRequestSchema = z.object({
  basePath: z.string().optional().describe("Base path (default: /workspace)"),
  since: z.number().optional().describe("Only files modified after this unix timestamp"),
});

export type SyncFromGuestRequest = z.infer<typeof SyncFromGuestRequestSchema>;

/**
 * Sync From Guest Response
 */
export const SyncFromGuestResponseSchema = z.object({
  files: z.array(z.object({
    path: z.string().describe("Relative path within workspace"),
    content: z.string().describe("Base64 encoded content"),
    mtime: z.number(),
  })),
});

export type SyncFromGuestResponse = z.infer<typeof SyncFromGuestResponseSchema>;
