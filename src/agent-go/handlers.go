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

	cmd := exec.Command("sh", "-c", command)
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

// handleSyncToGuest syncs multiple files to the guest filesystem
func (s *Server) handleSyncToGuest(params *SyncToGuestParams) (*SyncToGuestResult, error) {
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

// handleSyncFromGuest syncs files from the guest filesystem
func (s *Server) handleSyncFromGuest(params *SyncFromGuestParams) (*SyncFromGuestResult, error) {
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
			if shouldSkip(name, true) {
				return filepath.SkipDir
			}
			return nil
		}

		if shouldSkip(name, false) {
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

// shouldSkip determines if a file or directory should be skipped
func shouldSkip(name string, isDir bool) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	if isDir && (name == "node_modules" || name == "__pycache__") {
		return true
	}
	return false
}
