/**
 * Otus Daemon Client
 * HTTP client for communicating with the daemon over Unix socket
 */

import { DAEMON } from "@shared/constants.ts";
import type { InferenceEvent } from "@daemon/inference/index.ts";

export interface DaemonHealth {
  status: string;
  vmPool?: {
    available: number;
    target: number;
  };
}

export interface PrerequisitesResult {
  ok: boolean;
  issues: string[];
}

export interface InitOptions {
  workspacePath: string;
  openrouterApiKey: string;
  voyageApiKey: string;
  verbose?: boolean;
  model?: string;
  maxIterations?: number;
}

export interface SessionOptions {
  workspacePath: string;
  maxIterations?: number;
}

/**
 * Client for communicating with the Otus daemon
 */
export class DaemonClient {
  private socketPath: string;

  constructor(socketPath: string = DAEMON.SOCKET_PATH) {
    this.socketPath = socketPath;
  }

  /**
   * Check if daemon is running
   */
  async health(): Promise<DaemonHealth> {
    const response = await this.request("GET", "/health");
    return await response.json() as DaemonHealth;
  }

  /**
   * Check prerequisites
   */
  async checkPrerequisites(workspacePath: string): Promise<PrerequisitesResult> {
    const response = await this.request("POST", "/prerequisites", { workspacePath });
    return await response.json() as PrerequisitesResult;
  }

  /**
   * Initialize a workspace
   */
  async init(options: InitOptions): Promise<void> {
    const response = await this.request("POST", "/init", options);
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.error || "Failed to initialize workspace");
    }
  }

  /**
   * Create a new chat session
   */
  async createSession(options: SessionOptions): Promise<{ sessionId: string; model: string }> {
    const response = await this.request("POST", "/sessions", options);
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.error || "Failed to create session");
    }
    const result = await response.json() as any;
    return { sessionId: result.sessionId, model: result.model };
  }

  /**
   * Send a message to a session and stream the response
   */
  async *sendMessage(sessionId: string, message: string): AsyncGenerator<InferenceEvent> {
    const response = await this.request("POST", `/sessions/${sessionId}/messages`, { message });
    
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.error || "Failed to send message");
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        
        // Process complete SSE messages
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || ""; // Keep incomplete message in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6); // Remove "data: " prefix
            try {
              const event = JSON.parse(data) as InferenceEvent;
              // Don't yield internal stream_end events
              if (event.type !== "stream_end") {
                yield event;
              }
            } catch (error) {
              console.error("Failed to parse SSE event:", data, error);
            }
          }
        }
      }
    } catch (error) {
      // Log connection errors for debugging
      if (error instanceof Error) {
        if (error.message.includes("socket connection was closed")) {
          console.error("[Client] Connection to daemon was closed unexpectedly (sendMessage)");
          return; // Exit the generator gracefully
        }
        console.error(`[Client] Stream error: ${error.message}`);
      }
      throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore errors when releasing lock on closed stream
      }
    }
  }

  /**
   * End a session
   */
  async endSession(sessionId: string): Promise<void> {
    const response = await this.request("DELETE", `/sessions/${sessionId}`);
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.error || "Failed to end session");
    }
  }

  /**
   * Shutdown a specific workspace
   */
  async shutdownWorkspace(workspacePath: string): Promise<void> {
    const encoded = encodeURIComponent(workspacePath);
    const response = await this.request("POST", `/workspaces/${encoded}/shutdown`);
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.error || "Failed to shutdown workspace");
    }
  }

  /**
   * Shutdown the daemon
   */
  async shutdownDaemon(): Promise<void> {
    const response = await this.request("POST", "/shutdown");
    if (!response.ok) {
      const error = await response.json() as any;
      throw new Error(error.error || "Failed to shutdown daemon");
    }
  }

  /**
   * Make a request to the daemon
   */
  private async request(method: string, path: string, body?: any): Promise<Response> {
    const url = `http://localhost${path}`;
    
    const options: RequestInit = {
      method,
      // @ts-ignore - Bun specific unix socket option
      unix: this.socketPath,
    };

    if (body) {
      options.headers = {
        "Content-Type": "application/json",
      };
      options.body = JSON.stringify(body);
    }

    try {
      return await fetch(url, options);
    } catch (error) {
      if (error instanceof Error && error.message.includes("ENOENT")) {
        throw new Error("Daemon not running. Run 'otus daemon start' first.");
      }
      throw error;
    }
  }
}
