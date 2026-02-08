/**
 * Otus Daemon HTTP Server
 * Unix socket-based HTTP server for CLI-daemon communication
 */

import { WorkspaceContext, type WorkspaceConfig } from "./index.ts";
import type { InferenceEvent } from "./inference/index.ts";
import { DAEMON } from "@shared/constants.ts";
import { initLogger } from "@shared/logger.ts";
import { vmPool } from "./vm-pool.ts";

interface InitRequest {
  workspacePath: string;
  openrouterApiKey: string;
  voyageApiKey: string;
  verbose?: boolean;
  model?: string;
  maxIterations?: number;
}

interface PrerequisitesRequest {
  workspacePath: string;
}

interface CreateSessionRequest {
  workspacePath: string;
  maxIterations?: number;
}

interface SendMessageRequest {
  message: string;
}

interface ShutdownWorkspaceRequest {
  workspacePath: string;
}

/**
 * Daemon server manages workspace contexts and HTTP routes
 */
export class DaemonServer {
  private workspaces = new Map<string, WorkspaceContext>();
  private sessions = new Map<string, { workspacePath: string; sessionId: string }>();
  private server: any;
  private logger = initLogger(false);

  /**
   * Start the HTTP server on Unix socket
   */
  async start(): Promise<void> {
    this.logger.debug("Starting daemon server...");

    this.server = Bun.serve({
      unix: DAEMON.SOCKET_PATH,
      fetch: async (req) => {
        try {
          return await this.handleRequest(req);
        } catch (error) {
          this.logger.debug(`Request error: ${error}`);
          return new Response(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      },
      development: false, // Disable development mode for longer timeouts
    });

    // Set socket permissions to owner-only
    await Bun.spawn(["chmod", "600", DAEMON.SOCKET_PATH]).exited;

    this.logger.debug(`Daemon listening on ${DAEMON.SOCKET_PATH}`);

    // Start warming VM pool in background
    this.logger.debug("Starting VM pool warming...");
    vmPool.startWarming().catch((error) => {
      this.logger.debug(`VM pool warming failed: ${error}`);
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    this.logger.debug(`${method} ${path}`);

    // Health check
    if (method === "GET" && path === "/health") {
      const poolStats = vmPool.getStats();
      return new Response(JSON.stringify({ 
        status: "ok",
        vmPool: poolStats,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Prerequisites check
    if (method === "POST" && path === "/prerequisites") {
      const body = await req.json() as PrerequisitesRequest;
      const result = await WorkspaceContext.checkPrerequisites();
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Initialize workspace
    if (method === "POST" && path === "/init") {
      const body = await req.json() as InitRequest;
      return await this.handleInit(body);
    }

    // Create session
    if (method === "POST" && path === "/sessions") {
      const body = await req.json() as CreateSessionRequest;
      return await this.handleCreateSession(body);
    }

    // Send message to session (SSE stream)
    if (method === "POST" && path.startsWith("/sessions/") && path.endsWith("/messages")) {
      const sessionId = path.split("/")[2];
      if (!sessionId) {
        return new Response(JSON.stringify({ error: "Missing session ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = await req.json() as SendMessageRequest;
      return await this.handleSendMessage(sessionId, body);
    }

    // End session
    if (method === "DELETE" && path.startsWith("/sessions/")) {
      const sessionId = path.split("/")[2];
      if (!sessionId) {
        return new Response(JSON.stringify({ error: "Missing session ID" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      return await this.handleEndSession(sessionId);
    }

    // Shutdown specific workspace
    if (method === "POST" && path.startsWith("/workspaces/") && path.endsWith("/shutdown")) {
      const encodedPath = path.split("/")[2];
      if (!encodedPath) {
        return new Response(JSON.stringify({ error: "Missing workspace path" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const workspacePath = decodeURIComponent(encodedPath);
      return await this.handleShutdownWorkspace(workspacePath);
    }

    // Shutdown daemon
    if (method === "POST" && path === "/shutdown") {
      return await this.handleShutdown();
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Initialize a workspace
   */
  private async handleInit(body: InitRequest): Promise<Response> {
    const { workspacePath, openrouterApiKey, voyageApiKey, verbose, model, maxIterations } = body;

    // Check if already initialized
    if (this.workspaces.has(workspacePath)) {
      const context = this.workspaces.get(workspacePath)!;
      
      // Update model if it changed
      context.updateModel(model);

      // Update maxIterations if it changed
      context.updateMaxIterations(maxIterations);
      
      return new Response(
        JSON.stringify({ message: "Workspace already initialized" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Create workspace context
    const context = await WorkspaceContext.create({
      workspacePath,
      openrouterApiKey,
      voyageApiKey,
      verbose,
      model,
      maxIterations,
    });

    this.workspaces.set(workspacePath, context);

    return new Response(
      JSON.stringify({ message: "Workspace initialized", workspacePath }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Create a new chat session
   */
  private async handleCreateSession(body: CreateSessionRequest): Promise<Response> {
    const { workspacePath, maxIterations } = body;

    const context = this.workspaces.get(workspacePath);
    if (!context) {
      return new Response(
        JSON.stringify({ error: "Workspace not initialized. Call /init first." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { sessionId, model } = context.startSession({ maxIterations });
    this.sessions.set(sessionId, { workspacePath, sessionId });

    return new Response(
      JSON.stringify({ sessionId, model }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Send message to session and stream response via SSE
   */
  private async handleSendMessage(sessionId: string, body: SendMessageRequest): Promise<Response> {
    const { message } = body;

    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const context = this.workspaces.get(sessionInfo.workspacePath);
    if (!context) {
      return new Response(
        JSON.stringify({ error: "Workspace context lost" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const engine = context.getInferenceEngine(sessionId);
    if (!engine) {
      return new Response(
        JSON.stringify({ error: "Inference engine not found" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    this.logger.debug(`HANDLE_SEND_MESSAGE: Creating SSE stream for session ${sessionId}`);
    // Stream events as SSE
    const response = this.createSSEStream(engine.chat(message));
    this.logger.debug(`HANDLE_SEND_MESSAGE: Response created, returning`);
    return response;
  }

  /**
   * End a session
   */
  private async handleEndSession(sessionId: string): Promise<Response> {
    const sessionInfo = this.sessions.get(sessionId);
    if (!sessionInfo) {
      return new Response(
        JSON.stringify({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    const context = this.workspaces.get(sessionInfo.workspacePath);
    if (context) {
      context.endSession(sessionId);
    }

    this.sessions.delete(sessionId);

    return new Response(
      JSON.stringify({ message: "Session ended" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Shutdown a specific workspace
   */
  private async handleShutdownWorkspace(workspacePath: string): Promise<Response> {
    const context = this.workspaces.get(workspacePath);
    if (!context) {
      return new Response(
        JSON.stringify({ error: "Workspace not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    await context.shutdown();
    this.workspaces.delete(workspacePath);

    // Remove all sessions for this workspace
    for (const [sessionId, info] of this.sessions.entries()) {
      if (info.workspacePath === workspacePath) {
        this.sessions.delete(sessionId);
      }
    }

    return new Response(
      JSON.stringify({ message: "Workspace shutdown complete" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Shutdown the entire daemon
   */
  private async handleShutdown(): Promise<Response> {
    this.logger.debug("Shutting down daemon...");

    // Shutdown all workspaces
    for (const [workspacePath, context] of this.workspaces.entries()) {
      await context.shutdown();
    }

    this.workspaces.clear();
    this.sessions.clear();

    // Stop the server
    if (this.server) {
      this.server.stop();
    }

    return new Response(
      JSON.stringify({ message: "Daemon shutdown complete" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  /**
   * Create an SSE stream from an async generator of inference events.
   * Uses keepalive pings to prevent connection timeout during long operations
   * (Bun Unix sockets have aggressive idle timeouts).
   */
  private createSSEStream(generator: AsyncGenerator<InferenceEvent>): Response {
    let cancelled = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    const encoder = new TextEncoder();
    
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send keepalive pings every second to prevent idle timeout
        keepAliveTimer = setInterval(() => {
          if (!cancelled) {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              if (keepAliveTimer) {
                clearInterval(keepAliveTimer);
                keepAliveTimer = null;
              }
            }
          }
        }, 1000);
        
        // Process generator events in background
        (async () => {
          try {
            for await (const event of generator) {
              if (cancelled) break;
              
              const sseMessage = `data: ${JSON.stringify(event)}\n\n`;
              try {
                controller.enqueue(encoder.encode(sseMessage));
              } catch {
                break;
              }
            }
            
            if (!cancelled) {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "stream_end" })}\n\n`));
                controller.close();
              } catch {
                // Connection already closed
              }
            }
          } catch (error) {
            if (!cancelled) {
              try {
                const errorEvent: InferenceEvent = {
                  type: "error",
                  message: error instanceof Error ? error.message : String(error),
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
                controller.close();
              } catch {
                // Connection already closed
              }
            }
          } finally {
            if (keepAliveTimer) {
              clearInterval(keepAliveTimer);
              keepAliveTimer = null;
            }
          }
        })();
      },
      
      cancel() {
        cancelled = true;
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }
        generator.return(undefined).catch(() => {});
      },
    });
    
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    this.logger.debug("Stopping server...");
    
    // Shutdown all workspaces
    for (const context of this.workspaces.values()) {
      await context.shutdown();
    }

    this.workspaces.clear();
    this.sessions.clear();

    // Shutdown VM pool
    await vmPool.shutdown();

    if (this.server) {
      this.server.stop();
    }
  }
}
