/**
 * VSock Communication Layer
 * Handles communication with the guest agent via Firecracker's VSock proxy
 */

import { connect, type Socket } from "net";
import type { RPCRequest, RPCResponse } from "@shared/rpc.ts";
import { createRequest, createErrorResponse, RPCErrorCode } from "@shared/rpc.ts";
import { VSOCK, FIRECRACKER } from "@shared/constants.ts";

export interface VSockConnectionOptions {
  /** Path to Firecracker's VSock Unix socket */
  socketPath: string;
  /** Guest CID (Context ID) */
  guestCid: number;
  /** Port the agent is listening on */
  port: number;
  /** Connection timeout in milliseconds */
  timeout?: number;
}

export class VSockConnection {
  private socket: Socket | null = null;
  private readonly options: Required<VSockConnectionOptions>;
  private requestId = 0;
  private readonly pendingRequests = new Map<
    number | string,
    {
      resolve: (response: RPCResponse) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(options: VSockConnectionOptions) {
    this.options = {
      timeout: 60000, // 60 second default timeout for operations
      ...options,
    };
  }

  /**
   * Connect to the guest agent via VSock
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[VSock] Connecting to socket: ${this.options.socketPath} (port ${this.options.port})`);
      
      const timeout = setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
        }
        reject(new Error("VSock connection timeout"));
      }, this.options.timeout);

      // Connect to Firecracker's VSock Unix socket proxy
      this.socket = connect(this.options.socketPath);

      let connectPhase = true;
      let buffer = "";

      const dataHandler = (data: Buffer) => {
        if (connectPhase) {
          // Handle CONNECT protocol response
          buffer += data.toString();
          console.log(`[VSock] Received during connect phase: ${JSON.stringify(buffer)}`);
          
          if (buffer.includes("\n")) {
            const line = buffer.split("\n")[0] ?? "";
            console.log(`[VSock] Parsed response line: ${JSON.stringify(line)}`);
            if (line.startsWith("OK")) {
              // Connection established
              console.log("[VSock] Connection established successfully");
              connectPhase = false;
              clearTimeout(timeout);
              this.socket!.off("data", dataHandler);
              this.setupSocketHandlers();
              resolve();
            } else {
              clearTimeout(timeout);
              reject(new Error(`VSock proxy error: ${line}`));
            }
          }
        }
      };

      this.socket.on("connect", () => {
        // Send CONNECT command to VSock proxy
        const connectCmd = `CONNECT ${this.options.port}\n`;
        console.log(`[VSock] Connected to unix socket, sending: ${connectCmd.trim()}`);
        this.socket!.write(connectCmd);
      });

      this.socket.on("data", dataHandler);

      this.socket.on("error", (error) => {
        console.log(`[VSock] Socket error: ${error.message}`);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketHandlers(): void {
    if (!this.socket) return;

    let buffer = "";

    this.socket.on("data", (data) => {
      buffer += data.toString();
      
      // Try to parse complete JSON-RPC responses
      // Messages are newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line) as RPCResponse;
            this.handleResponse(response);
          } catch (error) {
            console.error("[VSock] Failed to parse response:", line, error);
          }
        }
      }
    });

    this.socket.on("error", (error) => {
      console.error("[VSock] Socket error:", error);
      this.rejectAllPending(error);
    });

    this.socket.on("close", () => {
      console.log("[VSock] Connection closed");
      this.rejectAllPending(new Error("Connection closed"));
    });
  }

  /**
   * Handle an RPC response from the guest
   */
  private handleResponse(response: RPCResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      this.pendingRequests.delete(response.id);
      pending.resolve(response);
    }
  }

  /**
   * Reject all pending requests
   */
  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Send an RPC request and wait for response
   * @param method - RPC method name
   * @param params - Method parameters
   * @param requestTimeout - Optional timeout in ms (defaults to connection timeout)
   */
  async request(method: string, params?: Record<string, unknown>, requestTimeout?: number): Promise<RPCResponse> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to guest agent");
    }

    const id = this.requestId++;
    const request = createRequest(method, params, id);
    const timeoutMs = requestTimeout ?? this.options.timeout;

    return new Promise((resolve, reject) => {
      // Set up response handler
      this.pendingRequests.set(id, { resolve, reject });

      // Set timeout for this specific request
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Clear timeout when request completes
      const originalResolve = resolve;
      const originalReject = reject;
      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          originalResolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });

      // Send request as newline-delimited JSON
      const message = JSON.stringify(request) + "\n";
      this.socket!.write(message);
    });
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    if (this.socket && !this.socket.destroyed) {
      return new Promise((resolve) => {
        this.socket!.end(() => {
          this.socket = null;
          resolve();
        });
      });
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }
}

/**
 * High-level client for interacting with the guest agent
 */
export class GuestAgentClient {
  private connection: VSockConnection;

  constructor(
    socketPath: string = FIRECRACKER.VSOCK_SOCKET,
    guestCid: number = VSOCK.GUEST_CID,
    port: number = VSOCK.AGENT_PORT
  ) {
    this.connection = new VSockConnection({
      socketPath,
      guestCid,
      port,
    });
  }

  /**
   * Connect to the agent
   */
  async connect(): Promise<void> {
    await this.connection.connect();
  }

  /**
   * Execute a command in the guest
   */
  async execute(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    timedOut?: boolean;
  }> {
    // Encode command as base64 to avoid multiline/escaping issues
    // Use execution timeout + buffer for RPC overhead (timeout is in seconds, convert to ms)
    const execTimeoutMs = ((options?.timeout || 300) + 10) * 1000;
    
    const response = await this.connection.request("execute", {
      command: Buffer.from(command).toString("base64"),
      ...options,
    }, execTimeoutMs);

    if (response.error) {
      throw new Error(`Execution failed: ${response.error.message}`);
    }

    return response.result as any;
  }

  /**
   * Check agent health
   */
  async health(): Promise<{
    status: string;
    uptime: number;
    hostname: string;
  }> {
    const response = await this.connection.request("health");

    if (response.error) {
      throw new Error(`Health check failed: ${response.error.message}`);
    }

    return response.result as any;
  }

  /**
   * Sync files to the guest VM using tar
   */
  async syncToGuest(
    tarData: Buffer,
    basePath = "/workspace"
  ): Promise<{
    success: boolean;
    filesWritten: number;
    error?: string;
  }> {
    const response = await this.connection.request("sync_to_guest", {
      tarData: tarData.toString("base64"),
      basePath,
    }, 300000); // 5 minute timeout for large syncs

    if (response.error) {
      throw new Error(`Sync to guest failed: ${response.error.message}`);
    }

    return response.result as any;
  }

  /**
   * Sync files from the guest VM using tar
   */
  async syncFromGuest(
    basePath = "/workspace",
    excludes?: string[]
  ): Promise<{
    tarData: Buffer;
    size: number;
  }> {
    const response = await this.connection.request("sync_from_guest", {
      basePath,
      excludes,
    }, 300000); // 5 minute timeout for large syncs

    if (response.error) {
      throw new Error(`Sync from guest failed: ${response.error.message}`);
    }

    const result = response.result as { tarData: string; size: number };
    return {
      tarData: Buffer.from(result.tarData, "base64"),
      size: result.size,
    };
  }

  /**
   * List directory contents in guest
   */
  async listDir(
    path: string,
    recursive = false
  ): Promise<{
    entries: Array<{
      name: string;
      path: string;
      isDirectory: boolean;
      size: number;
      mtime: number;
    }>;
  }> {
    // Use longer timeout for recursive directory listing
    const timeoutMs = recursive ? 120000 : 60000;
    const response = await this.connection.request("list_dir", {
      path,
      recursive,
    }, timeoutMs);

    if (response.error) {
      throw new Error(`List dir failed: ${response.error.message}`);
    }

    return response.result as any;
  }

  /**
   * Close the connection
   */
  async close(): Promise<void> {
    await this.connection.close();
  }
}
