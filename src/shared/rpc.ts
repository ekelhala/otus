/**
 * JSON-RPC 2.0 Protocol Types
 * Shared between host daemon and guest agent
 */

export interface RPCRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

export interface RPCResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: RPCError;
  id: number | string;
}

export interface RPCError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Standard JSON-RPC error codes
 */
export const RPCErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Custom error codes (application-specific)
  TIMEOUT_ERROR: -32000,
  EXECUTION_ERROR: -32001,
} as const;

export function createRequest(
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = Date.now()
): RPCRequest {
  return {
    jsonrpc: "2.0",
    method,
    params,
    id,
  };
}

export function createSuccessResponse(
  id: number | string,
  result: unknown
): RPCResponse {
  return {
    jsonrpc: "2.0",
    result,
    id,
  };
}

export function createErrorResponse(
  id: number | string,
  code: number,
  message: string,
  data?: unknown
): RPCResponse {
  return {
    jsonrpc: "2.0",
    error: { code, message, data },
    id,
  };
}
