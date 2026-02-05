package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Unique markers for command completion detection
const (
	cmdStartMarker = "__OTUS_CMD_START__"
	cmdEndMarker   = "__OTUS_CMD_END__"
)

// PersistentShell manages a long-running bash session
type PersistentShell struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	stderr    io.ReadCloser
	outReader *bufio.Reader
	errReader *bufio.Reader
	mu        sync.Mutex
	cwd       string
	active    bool
}

// NewPersistentShell creates and starts a new persistent bash shell
func NewPersistentShell(cwd string) (*PersistentShell, error) {
	if cwd == "" {
		cwd = DefaultCwd
	}

	// Ensure cwd exists
	os.MkdirAll(cwd, 0755)

	cmd := exec.Command("bash", "--norc", "--noprofile", "-i")
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"PS1=", // Disable prompt to avoid interference
		"TERM=dumb",
	)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start shell: %w", err)
	}

	shell := &PersistentShell{
		cmd:       cmd,
		stdin:     stdin,
		stdout:    stdout,
		stderr:    stderr,
		outReader: bufio.NewReader(stdout),
		errReader: bufio.NewReader(stderr),
		cwd:       cwd,
		active:    true,
	}

	// Initialize shell - disable echo and set up environment
	shell.stdin.Write([]byte("set +o history\n"))
	shell.stdin.Write([]byte("stty -echo 2>/dev/null || true\n"))

	return shell, nil
}

// Execute runs a command in the persistent shell and returns the result
func (s *PersistentShell) Execute(command string, timeout int, env map[string]string) (*ExecuteResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.active {
		return nil, fmt.Errorf("shell is not active")
	}

	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	startTime := time.Now()

	// Build the command with markers and exit code capture
	// We redirect stderr to a temp file so we can capture it separately
	stderrFile := fmt.Sprintf("/tmp/otus_stderr_%d", time.Now().UnixNano())

	wrappedCmd := fmt.Sprintf(`
echo '%s'
{ %s; } 2>%s
__otus_exit_code__=$?
echo '%s'"$__otus_exit_code__"'%s'
`,
		cmdStartMarker,
		command,
		stderrFile,
		cmdEndMarker,
		cmdEndMarker,
	)

	// Set any additional environment variables
	for k, v := range env {
		envCmd := fmt.Sprintf("export %s=%q\n", k, v)
		s.stdin.Write([]byte(envCmd))
	}

	// Send the command
	_, err := s.stdin.Write([]byte(wrappedCmd + "\n"))
	if err != nil {
		return nil, fmt.Errorf("failed to write command: %w", err)
	}

	// Read output until we see the end marker
	var stdoutBuf strings.Builder
	exitCode := 0
	timedOut := false

	// Create a channel to signal completion
	done := make(chan bool, 1)
	var readErr error

	// End marker pattern: __OTUS_CMD_END__<exitcode>__OTUS_CMD_END__
	endPattern := regexp.MustCompile(cmdEndMarker + `(\d+)` + cmdEndMarker)

	go func() {
		foundStart := false
		for {
			line, err := s.outReader.ReadString('\n')
			if err != nil {
				readErr = err
				done <- false
				return
			}

			// Skip until we see start marker
			if !foundStart {
				if strings.Contains(line, cmdStartMarker) {
					foundStart = true
				}
				continue
			}

			// Check for end marker
			if matches := endPattern.FindStringSubmatch(line); matches != nil {
				exitCode, _ = strconv.Atoi(matches[1])
				done <- true
				return
			}

			stdoutBuf.WriteString(line)
		}
	}()

	// Wait with timeout
	select {
	case success := <-done:
		if !success && readErr != nil {
			return nil, fmt.Errorf("read error: %w", readErr)
		}
	case <-time.After(time.Duration(timeout) * time.Second):
		timedOut = true
		// Send interrupt to stop the command
		s.stdin.Write([]byte{3}) // Ctrl+C
		time.Sleep(100 * time.Millisecond)
	}

	// Read stderr from temp file
	stderrBytes, _ := os.ReadFile(stderrFile)
	os.Remove(stderrFile)

	return &ExecuteResult{
		Stdout:     strings.TrimSuffix(stdoutBuf.String(), "\n"),
		Stderr:     string(stderrBytes),
		ExitCode:   exitCode,
		DurationMs: time.Since(startTime).Milliseconds(),
		TimedOut:   timedOut,
	}, nil
}

// Close terminates the persistent shell
func (s *PersistentShell) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.active = false

	if s.stdin != nil {
		s.stdin.Write([]byte("exit\n"))
		s.stdin.Close()
	}

	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
	}

	return nil
}

// IsActive returns whether the shell is still running
func (s *PersistentShell) IsActive() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active
}
