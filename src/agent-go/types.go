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

// SyncToGuestParams contains parameters for syncing files to the guest
type SyncToGuestParams struct {
	Files    []FileToSync `json:"files"`
	BasePath string       `json:"basePath,omitempty"`
}

// FileToSync represents a file to be synced to the guest
type FileToSync struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode,omitempty"`
}

// SyncToGuestResult contains the result of syncing files to the guest
type SyncToGuestResult struct {
	FilesWritten int         `json:"filesWritten"`
	Errors       []SyncError `json:"errors"`
}

// SyncError represents an error during file sync
type SyncError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// SyncFromGuestParams contains parameters for syncing files from the guest
type SyncFromGuestParams struct {
	BasePath string `json:"basePath,omitempty"`
	Since    int64  `json:"since,omitempty"`
}

// SyncFromGuestResult contains the result of syncing files from the guest
type SyncFromGuestResult struct {
	Files []SyncedFile `json:"files"`
}

// SyncedFile represents a file synced from the guest
type SyncedFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mtime   int64  `json:"mtime"`
}
