package main

import (
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	// DefaultCwd is the default working directory for commands
	DefaultCwd = "/workspace"
	// DefaultTimeout is the default timeout for command execution in seconds
	DefaultTimeout = 300
)

// handleHealth returns the current health status of the agent
func (s *Server) handleHealth() *HealthResult {
	hostname, _ := os.Hostname()
	return &HealthResult{
		Status:   "ok",
		Uptime:   s.Uptime(),
		Hostname: hostname,
	}
}

// handleExecute executes a shell command and returns the result
func (s *Server) handleExecute(params *ExecuteParams) (*ExecuteResult, error) {
	cwd := params.Cwd
	if cwd == "" {
		cwd = DefaultCwd
	}

	timeout := params.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	// Decode command from base64 (all commands are base64-encoded)
	if params.Command == "" {
		return nil, fmt.Errorf("no command provided")
	}

	decoded, err := base64.StdEncoding.DecodeString(params.Command)
	if err != nil {
		return nil, fmt.Errorf("failed to decode base64 command: %w", err)
	}
	command := string(decoded)

	startTime := time.Now()

	// Use bash instead of sh for better compatibility (source, arrays, etc.)
	cmd := exec.Command("bash", "-c", command)
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

// handleReadFile reads a file and returns its content (base64 encoded)
func (s *Server) handleReadFile(params *ReadFileParams) (*ReadFileResult, error) {
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

// handleWriteFile writes content to a file
func (s *Server) handleWriteFile(params *WriteFileParams) (*WriteFileResult, error) {
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

// handleListDir lists directory contents
func (s *Server) handleListDir(params *ListDirParams) (*ListDirResult, error) {
	var entries []DirEntry

	if params.Recursive {
		err := filepath.Walk(params.Path, func(path string, info fs.FileInfo, err error) error {
			if err != nil {
				return nil
			}

			name := info.Name()
			if shouldSkip(name, info.IsDir()) {
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
			if shouldSkip(name, item.IsDir()) {
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

// handleSyncToGuest extracts a tar.gz archive to the guest filesystem
func (s *Server) handleSyncToGuest(params *SyncToGuestParams) (*SyncToGuestResult, error) {
	basePath := params.BasePath
	if basePath == "" {
		basePath = DefaultCwd
	}

	// Ensure base path exists
	if err := os.MkdirAll(basePath, 0755); err != nil {
		return &SyncToGuestResult{Success: false, Error: err.Error()}, nil
	}

	// Decode base64 tar data
	tarData, err := base64.StdEncoding.DecodeString(params.TarData)
	if err != nil {
		return &SyncToGuestResult{Success: false, Error: fmt.Sprintf("invalid base64: %v", err)}, nil
	}

	// Write to temp file and extract with tar command (more reliable than Go's tar)
	tmpFile := fmt.Sprintf("/tmp/sync_%d.tar.gz", time.Now().UnixNano())
	if err := os.WriteFile(tmpFile, tarData, 0644); err != nil {
		return &SyncToGuestResult{Success: false, Error: err.Error()}, nil
	}
	defer os.Remove(tmpFile)

	// Extract using tar command
	cmd := exec.Command("tar", "-xzf", tmpFile, "-C", basePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return &SyncToGuestResult{
			Success: false,
			Error:   fmt.Sprintf("tar extract failed: %v: %s", err, string(output)),
		}, nil
	}

	// Count files (approximate)
	countCmd := exec.Command("sh", "-c", fmt.Sprintf("find %s -type f | wc -l", basePath))
	countOutput, _ := countCmd.Output()
	count := 0
	fmt.Sscanf(strings.TrimSpace(string(countOutput)), "%d", &count)

	return &SyncToGuestResult{
		Success:      true,
		FilesWritten: count,
	}, nil
}

// handleSyncFromGuest creates a tar.gz archive of the guest filesystem
func (s *Server) handleSyncFromGuest(params *SyncFromGuestParams) (*SyncFromGuestResult, error) {
	basePath := params.BasePath
	if basePath == "" {
		basePath = DefaultCwd
	}

	// Check if path exists
	if _, err := os.Stat(basePath); os.IsNotExist(err) {
		return &SyncFromGuestResult{TarData: "", Size: 0}, nil
	}

	// Build exclude arguments from host-provided patterns only
	// (no default excludes - .otusignore on host is the single source of truth)
	excludeArgs := make([]string, 0, len(params.Excludes)*2)
	for _, pattern := range params.Excludes {
		excludeArgs = append(excludeArgs, "--exclude="+pattern)
	}

	// Create tar.gz using tar command
	tmpFile := fmt.Sprintf("/tmp/sync_%d.tar.gz", time.Now().UnixNano())
	defer os.Remove(tmpFile)

	args := append([]string{"-czf", tmpFile}, excludeArgs...)
	args = append(args, "-C", basePath, ".")

	cmd := exec.Command("tar", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// tar might return non-zero for warnings, check if file was created
		if _, statErr := os.Stat(tmpFile); statErr != nil {
			return nil, fmt.Errorf("tar create failed: %v: %s", err, string(output))
		}
	}

	// Read the tar file
	tarData, err := os.ReadFile(tmpFile)
	if err != nil {
		return nil, fmt.Errorf("failed to read tar file: %v", err)
	}

	return &SyncFromGuestResult{
		TarData: base64.StdEncoding.EncodeToString(tarData),
		Size:    len(tarData),
	}, nil
}

// shouldSkip determines if a file or directory should be skipped during listing
// Note: No default excludes - .otusignore on host is the single source of truth for sync
func shouldSkip(name string, isDir bool) bool {
	return false
}

// ========== Session (tmux) handlers ==========

// handleStartSession creates a new tmux session
func (s *Server) handleStartSession(params *StartSessionParams) (*StartSessionResult, error) {
	if params.Name == "" {
		return &StartSessionResult{Success: false, Error: "session name is required"}, nil
	}

	cwd := params.Cwd
	if cwd == "" {
		cwd = DefaultCwd
	}

	// Check if session already exists
	checkCmd := exec.Command("tmux", "has-session", "-t", params.Name)
	if err := checkCmd.Run(); err == nil {
		return &StartSessionResult{
			Name:    params.Name,
			Success: true, // Session already exists, consider it a success
		}, nil
	}

	// Create new tmux session (detached)
	cmd := exec.Command("tmux", "new-session", "-d", "-s", params.Name, "-c", cwd)
	cmd.Env = os.Environ()

	if output, err := cmd.CombinedOutput(); err != nil {
		return &StartSessionResult{
			Name:    params.Name,
			Success: false,
			Error:   fmt.Sprintf("failed to create session: %v: %s", err, string(output)),
		}, nil
	}

	return &StartSessionResult{
		Name:    params.Name,
		Success: true,
	}, nil
}

// handleSendToSession sends a command to a tmux session
func (s *Server) handleSendToSession(params *SendToSessionParams) (*SendToSessionResult, error) {
	if params.Name == "" {
		return &SendToSessionResult{Success: false, Error: "session name is required"}, nil
	}

	// Check if session exists
	checkCmd := exec.Command("tmux", "has-session", "-t", params.Name)
	if err := checkCmd.Run(); err != nil {
		return &SendToSessionResult{
			Success: false,
			Error:   fmt.Sprintf("session %s does not exist", params.Name),
		}, nil
	}

	// Decode command from base64
	decoded, err := base64.StdEncoding.DecodeString(params.Command)
	if err != nil {
		return &SendToSessionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to decode base64 command: %v", err),
		}, nil
	}
	command := string(decoded)

	// Send keys to the session
	// Using send-keys with the command, followed by Enter
	// Always send Enter since this is for command execution
	args := []string{"send-keys", "-t", params.Name, command, "Enter"}

	cmd := exec.Command("tmux", args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return &SendToSessionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to send to session: %v: %s", err, string(output)),
		}, nil
	}

	return &SendToSessionResult{Success: true}, nil
}

// handleReadSession reads output from a tmux session using capture-pane
func (s *Server) handleReadSession(params *ReadSessionParams) (*ReadSessionResult, error) {
	if params.Name == "" {
		return &ReadSessionResult{Success: false, Error: "session name is required"}, nil
	}

	// Check if session exists
	checkCmd := exec.Command("tmux", "has-session", "-t", params.Name)
	if err := checkCmd.Run(); err != nil {
		return &ReadSessionResult{
			Success: false,
			Error:   fmt.Sprintf("session %s does not exist", params.Name),
		}, nil
	}

	lines := params.Lines
	if lines <= 0 {
		lines = 1000 // Default to capturing 1000 lines
	}

	// Use capture-pane to get the session output
	// -p prints to stdout, -S specifies start line (negative = history)
	cmd := exec.Command("tmux", "capture-pane", "-t", params.Name, "-p", "-S", fmt.Sprintf("-%d", lines))
	output, err := cmd.Output()
	if err != nil {
		return &ReadSessionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to capture session output: %v", err),
		}, nil
	}

	return &ReadSessionResult{
		Output:  string(output),
		Success: true,
	}, nil
}

// handleListSessions lists all active tmux sessions
func (s *Server) handleListSessions() (*ListSessionsResult, error) {
	cmd := exec.Command("tmux", "list-sessions", "-F", "#{session_name}|#{session_created}|#{session_attached}|#{session_windows}")
	output, err := cmd.Output()
	if err != nil {
		// No sessions might return an error, return empty list
		return &ListSessionsResult{Sessions: []SessionInfo{}}, nil
	}

	var sessions []SessionInfo
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) >= 4 {
			windows := 0
			fmt.Sscanf(parts[3], "%d", &windows)
			sessions = append(sessions, SessionInfo{
				Name:     parts[0],
				Created:  parts[1],
				Attached: parts[2] == "1",
				Windows:  windows,
			})
		}
	}

	return &ListSessionsResult{Sessions: sessions}, nil
}

// handleKillSession terminates a tmux session
func (s *Server) handleKillSession(params *KillSessionParams) (*KillSessionResult, error) {
	if params.Name == "" {
		return &KillSessionResult{Success: false, Error: "session name is required"}, nil
	}

	cmd := exec.Command("tmux", "kill-session", "-t", params.Name)
	if output, err := cmd.CombinedOutput(); err != nil {
		return &KillSessionResult{
			Success: false,
			Error:   fmt.Sprintf("failed to kill session: %v: %s", err, string(output)),
		}, nil
	}

	return &KillSessionResult{Success: true}, nil
}
