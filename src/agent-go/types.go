package main

import "encoding/json"

// JSON-RPC error codes
const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	InternalError  = -32603
	ExecutionError = -32000
)

// RPCRequest represents a JSON-RPC 2.0 request
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	ID      interface{}     `json:"id"`
}

// RPCResponse represents a JSON-RPC 2.0 response
type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
	ID      interface{} `json:"id"`
}

// RPCError represents a JSON-RPC 2.0 error object
type RPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// ExecuteParams contains parameters for the execute method
// Command is always base64-encoded to avoid multiline/escaping issues
type ExecuteParams struct {
	Command string            `json:"command"`
	Cwd     string            `json:"cwd,omitempty"`
	Timeout int               `json:"timeout,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// ExecuteResult contains the result of command execution
type ExecuteResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

// HealthResult contains health check information
type HealthResult struct {
	Status   string  `json:"status"`
	Uptime   float64 `json:"uptime"`
	Hostname string  `json:"hostname"`
}

// ReadFileParams contains parameters for reading a file
type ReadFileParams struct {
	Path string `json:"path"`
}

// ReadFileResult contains the result of reading a file
type ReadFileResult struct {
	Content string `json:"content"`
	Exists  bool   `json:"exists"`
	Size    int64  `json:"size,omitempty"`
}

// WriteFileParams contains parameters for writing a file
type WriteFileParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode,omitempty"`
}

// WriteFileResult contains the result of writing a file
type WriteFileResult struct {
	Success      bool `json:"success"`
	BytesWritten int  `json:"bytesWritten"`
}

// ListDirParams contains parameters for listing directory contents
type ListDirParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}

// DirEntry represents a directory entry
type DirEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	Mtime       int64  `json:"mtime"`
}

// ListDirResult contains the result of listing a directory
type ListDirResult struct {
	Entries []DirEntry `json:"entries"`
}

// SyncToGuestParams contains parameters for syncing files to the guest (tar-based)
type SyncToGuestParams struct {
	TarData  string `json:"tarData"` // Base64-encoded tar.gz
	BasePath string `json:"basePath,omitempty"`
}

// SyncToGuestResult contains the result of syncing files to the guest
type SyncToGuestResult struct {
	Success      bool   `json:"success"`
	FilesWritten int    `json:"filesWritten"`
	Error        string `json:"error,omitempty"`
}

// SyncFromGuestParams contains parameters for syncing files from the guest (tar-based)
type SyncFromGuestParams struct {
	BasePath string   `json:"basePath,omitempty"`
	Excludes []string `json:"excludes,omitempty"` // Additional patterns to exclude
}

// SyncFromGuestResult contains the result of syncing files from the guest
type SyncFromGuestResult struct {
	TarData string `json:"tarData"` // Base64-encoded tar.gz
	Size    int    `json:"size"`    // Size in bytes
}

// ========== Session (tmux) types ==========

// StartSessionParams contains parameters for starting a tmux session
type StartSessionParams struct {
	Name string `json:"name"`          // Session name (required)
	Cwd  string `json:"cwd,omitempty"` // Working directory (default: /workspace)
}

// StartSessionResult contains the result of starting a session
type StartSessionResult struct {
	Name    string `json:"name"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// SendToSessionParams contains parameters for sending a command to a session
type SendToSessionParams struct {
	Name    string `json:"name"`            // Session name
	Command string `json:"command"`         // Base64-encoded command to send
	Enter   bool   `json:"enter,omitempty"` // Whether to send Enter after command (default: true)
}

// SendToSessionResult contains the result of sending to a session
type SendToSessionResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// ReadSessionParams contains parameters for reading session output
type ReadSessionParams struct {
	Name  string `json:"name"`            // Session name
	Lines int    `json:"lines,omitempty"` // Number of lines to capture (default: 1000)
}

// ReadSessionResult contains the captured session output
type ReadSessionResult struct {
	Output  string `json:"output"` // Captured output from the session
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// ListSessionsResult contains the list of active sessions
type ListSessionsResult struct {
	Sessions []SessionInfo `json:"sessions"`
}

// SessionInfo contains info about a single session
type SessionInfo struct {
	Name     string `json:"name"`
	Created  string `json:"created"`
	Attached bool   `json:"attached"`
	Windows  int    `json:"windows"`
}

// KillSessionParams contains parameters for killing a session
type KillSessionParams struct {
	Name string `json:"name"` // Session name to kill
}

// KillSessionResult contains the result of killing a session
type KillSessionResult struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}
