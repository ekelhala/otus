package main

import "encoding/json"

// handleRPCRequest processes an RPC request and returns a response (ConnectionContext version)
func (ctx *ConnectionContext) handleRPCRequest(req *RPCRequest) *RPCResponse {
	resp := &RPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
	}

	switch req.Method {
	case "health":
		resp.Result = ctx.server.handleHealth()

	case "execute":
		params, err := parseParams[ExecuteParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		// Use persistent shell for execute
		result, err := ctx.handleExecute(params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "read_file":
		params, err := parseParams[ReadFileParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := ctx.server.handleReadFile(params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "write_file":
		params, err := parseParams[WriteFileParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := ctx.server.handleWriteFile(params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "list_dir":
		params, err := parseParams[ListDirParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := ctx.server.handleListDir(params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "sync_to_guest":
		params, err := parseParams[SyncToGuestParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := ctx.server.handleSyncToGuest(params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "sync_from_guest":
		params, err := parseParams[SyncFromGuestParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := ctx.server.handleSyncFromGuest(params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	default:
		resp.Error = &RPCError{Code: MethodNotFound, Message: "Method not found"}
	}

	return resp
}

// parseParams is a generic helper for unmarshaling RPC parameters
func parseParams[T any](raw json.RawMessage) (*T, error) {
	var params T
	if err := json.Unmarshal(raw, &params); err != nil {
		return nil, err
	}
	return &params, nil
}
