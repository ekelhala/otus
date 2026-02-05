package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

const (
	// VSockPort is the port number for VSock communication
	VSockPort = 9999
	// TCPPort is the port number for TCP communication
	TCPPort = 9999
)

// fdConn wraps a file descriptor to implement io.Reader/Writer
// This approach is used by the reference implementation for reliable vsock communication
type fdConn struct {
	fd int
}

func (c *fdConn) Read(p []byte) (n int, err error) {
	n, err = unix.Read(c.fd, p)
	if err != nil {
		return 0, err
	}
	if n == 0 {
		return 0, io.EOF
	}
	return n, nil
}

func (c *fdConn) Write(p []byte) (n int, err error) {
	return unix.Write(c.fd, p)
}

func (c *fdConn) Close() error {
	return unix.Close(c.fd)
}

// Server manages the guest agent's network listeners and connections
type Server struct {
	startTime time.Time
}

// ConnectionContext holds per-connection state including persistent shell
type ConnectionContext struct {
	shell  *PersistentShell
	server *Server
}

// NewServer creates a new Server instance
func NewServer() *Server {
	return &Server{
		startTime: time.Now(),
	}
}

// Start initializes and starts both VSock and TCP listeners
func (s *Server) Start() {
	hostname, _ := os.Hostname()
	fmt.Printf("[Otus Agent] Starting Go agent\n")
	fmt.Printf("[Otus Agent] Hostname: %s\n", hostname)
	fmt.Printf("[Otus Agent] Working directory: %s\n", DefaultCwd)

	os.MkdirAll(DefaultCwd, 0755)

	go s.startVSockListener()
	go s.startTCPListener()

	// Block forever
	select {}
}

// startVSockListener creates and manages the VSock listener
func (s *Server) startVSockListener() {
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

		// Use direct fd wrapper for reliable vsock communication
		// This approach matches the reference implementation
		go s.handleVSockConnection(nfd)
	}
}

// handleVSockConnection handles a vsock connection using raw fd
func (s *Server) handleVSockConnection(fd int) {
	conn := &fdConn{fd: fd}
	defer conn.Close()

	// Create persistent shell for this connection
	shell, err := NewPersistentShell(DefaultCwd)
	if err != nil {
		fmt.Printf("[Otus Agent] Failed to create persistent shell: %v\n", err)
		return
	}
	defer shell.Close()

	ctx := &ConnectionContext{
		shell:  shell,
		server: s,
	}

	fmt.Println("[Otus Agent] VSock client connected (persistent shell ready)")
	defer fmt.Println("[Otus Agent] VSock client disconnected")

	reader := bufio.NewReader(conn)

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			if err != io.EOF {
				fmt.Printf("[Otus Agent] VSock read error: %v\n", err)
			}
			return
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var req RPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			s.sendErrorRaw(conn, nil, ParseError, "Parse error", nil)
			continue
		}

		response := ctx.handleRPCRequest(&req)
		respBytes, _ := json.Marshal(response)
		conn.Write(append(respBytes, '\n'))
	}
}

// sendErrorRaw sends an error response using raw fd writer
func (s *Server) sendErrorRaw(w io.Writer, id interface{}, code int, message string, data interface{}) {
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
	w.Write(append(respBytes, '\n'))
}

// startTCPListener creates and manages the TCP listener
func (s *Server) startTCPListener() {
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
		go s.handleConnection(conn)
	}
}

// handleConnection manages a client connection, reading and processing RPC requests
func (s *Server) handleConnection(conn net.Conn) {
	defer conn.Close()

	// Create persistent shell for this connection
	shell, err := NewPersistentShell(DefaultCwd)
	if err != nil {
		fmt.Printf("[Otus Agent] Failed to create persistent shell: %v\n", err)
		return
	}
	defer shell.Close()

	ctx := &ConnectionContext{
		shell:  shell,
		server: s,
	}

	fmt.Println("[Otus Agent] TCP client connected (persistent shell ready)")
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
			s.sendError(conn, nil, ParseError, "Parse error", nil)
			continue
		}

		response := ctx.handleRPCRequest(&req)
		respBytes, _ := json.Marshal(response)
		conn.Write(append(respBytes, '\n'))
	}
}

// sendError sends an error response to the client
func (s *Server) sendError(conn net.Conn, id interface{}, code int, message string, data interface{}) {
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

// Uptime returns the server uptime in seconds
func (s *Server) Uptime() float64 {
	return time.Since(s.startTime).Seconds()
}
