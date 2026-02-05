package main

import "encoding/json"

// handleRPCRequest processes an RPC request and returns a response
func (s *Server) handleRPCRequest(req *RPCRequest) *RPCResponse {
	resp := &RPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
	}

	switch req.Method {
	case "health":
		resp.Result = s.handleHealth()

	case "execute":
		params, err := parseParams[ExecuteParams](req.Params)
		if err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := s.handleExecute(params)
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
		result, err := s.handleReadFile(params)
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
		result, err := s.handleWriteFile(params)
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
		result, err := s.handleListDir(params)
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
		result, err := s.handleSyncToGuest(params)
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
		result, err := s.handleSyncFromGuest(params)
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
