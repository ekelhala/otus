// Otus Guest Agent (Go implementation)
//
// A stateless execution agent that runs inside the Firecracker VM.
// Listens on VSock for JSON-RPC commands from the host daemon.
//
// Build: CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o otus-agent .

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	VSockPort      = 9999
	TCPPort        = 9999
	DefaultCwd     = "/workspace"
	DefaultTimeout = 300
)

var agentStartTime = time.Now()

// JSON-RPC types
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	ID      interface{}     `json:"id"`
}

type RPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   *RPCError   `json:"error,omitempty"`
	ID      interface{} `json:"id"`
}

type RPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	InternalError  = -32603
	ExecutionError = -32000
)

// Request/Response types
type ExecuteParams struct {
	Command string            `json:"command"`
	Cwd     string            `json:"cwd,omitempty"`
	Timeout int               `json:"timeout,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

type ExecuteResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

type HealthResult struct {
	Status   string  `json:"status"`
	Uptime   float64 `json:"uptime"`
	Hostname string  `json:"hostname"`
}

type ReadFileParams struct {
	Path string `json:"path"`
}

type ReadFileResult struct {
	Content string `json:"content"`
	Exists  bool   `json:"exists"`
	Size    int64  `json:"size,omitempty"`
}

type WriteFileParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode,omitempty"`
}

type WriteFileResult struct {
	Success      bool `json:"success"`
	BytesWritten int  `json:"bytesWritten"`
}

type ListDirParams struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive,omitempty"`
}

type DirEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	Mtime       int64  `json:"mtime"`
}

type ListDirResult struct {
	Entries []DirEntry `json:"entries"`
}

type SyncToGuestParams struct {
	Files    []FileToSync `json:"files"`
	BasePath string       `json:"basePath,omitempty"`
}

type FileToSync struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    int    `json:"mode,omitempty"`
}

type SyncToGuestResult struct {
	FilesWritten int         `json:"filesWritten"`
	Errors       []SyncError `json:"errors"`
}

type SyncError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type SyncFromGuestParams struct {
	BasePath string `json:"basePath,omitempty"`
	Since    int64  `json:"since,omitempty"`
}

type SyncFromGuestResult struct {
	Files []SyncedFile `json:"files"`
}

type SyncedFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mtime   int64  `json:"mtime"`
}

func main() {
	hostname, _ := os.Hostname()
	fmt.Printf("[Otus Agent] Starting Go agent\n")
	fmt.Printf("[Otus Agent] Hostname: %s\n", hostname)
	fmt.Printf("[Otus Agent] Working directory: %s\n", DefaultCwd)

	os.MkdirAll(DefaultCwd, 0755)

	go startVSockListener()
	go startTCPListener()

	select {}
}

func startVSockListener() {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM, 0)
	if err != nil {
		fmt.Printf("[Otus Agent] Failed to create VSock socket: %v\n", err)
		return
	}

	unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)

	sa := &unix.SockaddrVM{
		CID:  unix.VMADDR_CID_ANY,
		Port: VSockPort,
	}

	if err := unix.Bind(fd, sa); err != nil {
		fmt.Printf("[Otus Agent] Failed to bind VSock: %v\n", err)
		unix.Close(fd)
		return
	}

	if err := unix.Listen(fd, 10); err != nil {
		fmt.Printf("[Otus Agent] Failed to listen on VSock: %v\n", err)
		unix.Close(fd)
		return
	}

	fmt.Printf("[Otus Agent] Listening on VSock port %d\n", VSockPort)

	for {
		nfd, _, err := unix.Accept(fd)
		if err != nil {
			fmt.Printf("[Otus Agent] VSock accept error: %v\n", err)
			continue
		}

		fmt.Println("[Otus Agent] VSock client connected")

		file := os.NewFile(uintptr(nfd), "vsock")
		conn, err := net.FileConn(file)
		file.Close()

		if err != nil {
			fmt.Printf("[Otus Agent] Failed to create conn from VSock fd: %v\n", err)
			unix.Close(nfd)
			continue
		}

		go handleConnection(conn)
	}
}

func startTCPListener() {
	listener, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", TCPPort))
	if err != nil {
		fmt.Printf("[Otus Agent] Failed to start TCP listener: %v\n", err)
		return
	}

	fmt.Printf("[Otus Agent] Listening on TCP port %d\n", TCPPort)

	for {
		conn, err := listener.Accept()
		if err != nil {
			fmt.Printf("[Otus Agent] TCP accept error: %v\n", err)
			continue
		}

		fmt.Println("[Otus Agent] TCP client connected")
		go handleConnection(conn)
	}
}

func handleConnection(conn net.Conn) {
	defer conn.Close()
	defer fmt.Println("[Otus Agent] Client disconnected")

	reader := bufio.NewReader(conn)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				fmt.Printf("[Otus Agent] Read error: %v\n", err)
			}
			return
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			sendError(conn, nil, ParseError, "Parse error", nil)
			continue
		}

		response := handleRequest(&req)
		respBytes, _ := json.Marshal(response)
		conn.Write(append(respBytes, '\n'))
	}
}

func sendError(conn net.Conn, id interface{}, code int, message string, data interface{}) {
	resp := RPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &RPCError{
			Code:    code,
			Message: message,
			Data:    data,
		},
	}
	respBytes, _ := json.Marshal(resp)
	conn.Write(append(respBytes, '\n'))
}

func handleRequest(req *RPCRequest) *RPCResponse {
	resp := &RPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
	}

	switch req.Method {
	case "health":
		resp.Result = handleHealth()

	case "execute":
		var params ExecuteParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := handleExecute(&params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "read_file":
		var params ReadFileParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := handleReadFile(&params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "write_file":
		var params WriteFileParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := handleWriteFile(&params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "list_dir":
		var params ListDirParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := handleListDir(&params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "sync_to_guest":
		var params SyncToGuestParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := handleSyncToGuest(&params)
		if err != nil {
			resp.Error = &RPCError{Code: ExecutionError, Message: err.Error()}
			return resp
		}
		resp.Result = result

	case "sync_from_guest":
		var params SyncFromGuestParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			resp.Error = &RPCError{Code: InvalidParams, Message: "Invalid params"}
			return resp
		}
		result, err := handleSyncFromGuest(&params)
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

func handleHealth() *HealthResult {
	hostname, _ := os.Hostname()
	return &HealthResult{
		Status:   "ok",
		Uptime:   time.Since(agentStartTime).Seconds(),
		Hostname: hostname,
	}
}

func handleExecute(params *ExecuteParams) (*ExecuteResult, error) {
	cwd := params.Cwd
	if cwd == "" {
		cwd = DefaultCwd
	}

	timeout := params.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	startTime := time.Now()

	cmd := exec.Command("sh", "-c", params.Command)
	cmd.Dir = cwd
	cmd.Env = os.Environ()
	for k, v := range params.Env {
		cmd.Env = append(cmd.Env, fmt.Sprintf("%s=%s", k, v))
	}

	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return &ExecuteResult{
			Stdout:     "",
			Stderr:     err.Error(),
			ExitCode:   -1,
			DurationMs: time.Since(startTime).Milliseconds(),
		}, nil
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	var timedOut bool
	select {
	case err := <-done:
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				exitCode = -1
			}
		}
		return &ExecuteResult{
			Stdout:     stdout.String(),
			Stderr:     stderr.String(),
			ExitCode:   exitCode,
			DurationMs: time.Since(startTime).Milliseconds(),
			TimedOut:   false,
		}, nil

	case <-time.After(time.Duration(timeout) * time.Second):
		timedOut = true
		if cmd.Process != nil {
			cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(100 * time.Millisecond)
			cmd.Process.Kill()
		}
		<-done
	}

	return &ExecuteResult{
		Stdout:     stdout.String(),
		Stderr:     stderr.String(),
		ExitCode:   -1,
		DurationMs: time.Since(startTime).Milliseconds(),
		TimedOut:   timedOut,
	}, nil
}

func handleReadFile(params *ReadFileParams) (*ReadFileResult, error) {
	content, err := os.ReadFile(params.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return &ReadFileResult{
				Content: "",
				Exists:  false,
			}, nil
		}
		return nil, err
	}

	info, _ := os.Stat(params.Path)
	return &ReadFileResult{
		Content: base64.StdEncoding.EncodeToString(content),
		Exists:  true,
		Size:    info.Size(),
	}, nil
}

func handleWriteFile(params *WriteFileParams) (*WriteFileResult, error) {
	content, err := base64.StdEncoding.DecodeString(params.Content)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 content: %v", err)
	}

	dir := filepath.Dir(params.Path)
	if dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, err
		}
	}

	mode := params.Mode
	if mode == 0 {
		mode = 0644
	}

	if err := os.WriteFile(params.Path, content, fs.FileMode(mode)); err != nil {
		return nil, err
	}

	return &WriteFileResult{
		Success:      true,
		BytesWritten: len(content),
	}, nil
}

func handleListDir(params *ListDirParams) (*ListDirResult, error) {
	var entries []DirEntry

	if params.Recursive {
		err := filepath.Walk(params.Path, func(path string, info fs.FileInfo, err error) error {
			if err != nil {
				return nil
			}

			name := info.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__" {
				if info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}

			entries = append(entries, DirEntry{
				Name:        name,
				Path:        path,
				IsDirectory: info.IsDir(),
				Size:        info.Size(),
				Mtime:       info.ModTime().UnixMilli(),
			})

			return nil
		})
		if err != nil {
			return nil, err
		}
	} else {
		items, err := os.ReadDir(params.Path)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			name := item.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__" {
				continue
			}
			info, err := item.Info()
			if err != nil {
				continue
			}
			entries = append(entries, DirEntry{
				Name:        name,
				Path:        filepath.Join(params.Path, name),
				IsDirectory: item.IsDir(),
				Size:        info.Size(),
				Mtime:       info.ModTime().UnixMilli(),
			})
		}
	}

	return &ListDirResult{Entries: entries}, nil
}

func handleSyncToGuest(params *SyncToGuestParams) (*SyncToGuestResult, error) {
	basePath := params.BasePath
	if basePath == "" {
		basePath = DefaultCwd
	}

	result := &SyncToGuestResult{
		Errors: []SyncError{},
	}

	for _, file := range params.Files {
		fullPath := filepath.Join(basePath, file.Path)

		content, err := base64.StdEncoding.DecodeString(file.Content)
		if err != nil {
			result.Errors = append(result.Errors, SyncError{
				Path:  file.Path,
				Error: fmt.Sprintf("invalid base64: %v", err),
			})
			continue
		}

		dir := filepath.Dir(fullPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			result.Errors = append(result.Errors, SyncError{
				Path:  file.Path,
				Error: err.Error(),
			})
			continue
		}

		mode := file.Mode
		if mode == 0 {
			mode = 0644
		}

		if err := os.WriteFile(fullPath, content, fs.FileMode(mode)); err != nil {
			result.Errors = append(result.Errors, SyncError{
				Path:  file.Path,
				Error: err.Error(),
			})
			continue
		}

		result.FilesWritten++
	}

	return result, nil
}

func handleSyncFromGuest(params *SyncFromGuestParams) (*SyncFromGuestResult, error) {
	basePath := params.BasePath
	if basePath == "" {
		basePath = DefaultCwd
	}

	result := &SyncFromGuestResult{
		Files: []SyncedFile{},
	}

	err := filepath.Walk(basePath, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		name := info.Name()
		if info.IsDir() {
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == "__pycache__" {
				return filepath.SkipDir
			}
			return nil
		}

		if strings.HasPrefix(name, ".") {
			return nil
		}

		mtime := info.ModTime().UnixMilli()
		if params.Since > 0 && mtime < params.Since {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return nil
		}

		relPath, err := filepath.Rel(basePath, path)
		if err != nil {
			relPath = path
		}

		result.Files = append(result.Files, SyncedFile{
			Path:    relPath,
			Content: base64.StdEncoding.EncodeToString(content),
			Mtime:   mtime,
		})

		return nil
	})

	if err != nil {
		return nil, err
	}

	return result, nil
}
