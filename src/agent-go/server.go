package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/sourcegraph/jsonrpc2"
	"golang.org/x/sys/unix"
)

const (
	// VSockPort is the port number for VSock communication
	VSockPort = 9999
)

// NewlineObjectCodec implements a newline-delimited JSON codec for jsonrpc2
type NewlineObjectCodec struct{}

// WriteObject writes a JSON object followed by a newline
func (NewlineObjectCodec) WriteObject(stream io.Writer, obj interface{}) error {
	data, err := json.Marshal(obj)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = stream.Write(data)
	return err
}

// ReadObject reads a newline-delimited JSON object
func (NewlineObjectCodec) ReadObject(stream *bufio.Reader, v interface{}) error {
	line, err := stream.ReadBytes('\n')
	if err != nil {
		return err
	}
	return json.Unmarshal(line, v)
}

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

// NewServer creates a new Server instance
func NewServer() *Server {
	return &Server{
		startTime: time.Now(),
	}
}

// Start initializes and starts the VSock listener
func (s *Server) Start() {
	hostname, _ := os.Hostname()
	fmt.Printf("[Otus Agent] Starting Go agent\n")
	fmt.Printf("[Otus Agent] Hostname: %s\n", hostname)
	fmt.Printf("[Otus Agent] Working directory: %s\n", DefaultCwd)

	os.MkdirAll(DefaultCwd, 0755)

	s.startVSockListener()
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
		go s.handleVSockConnection(nfd)
	}
}

// handleVSockConnection handles a vsock connection using jsonrpc2
func (s *Server) handleVSockConnection(fd int) {
	conn := &fdConn{fd: fd}
	defer conn.Close()

	fmt.Println("[Otus Agent] VSock client connected")
	defer fmt.Println("[Otus Agent] VSock client disconnected")

	// Create jsonrpc2 connection with newline-delimited JSON codec
	stream := jsonrpc2.NewBufferedStream(conn, NewlineObjectCodec{})
	rpcConn := jsonrpc2.NewConn(context.Background(), stream, jsonrpc2.HandlerWithError(s.handle))

	// Wait for connection to close
	<-rpcConn.DisconnectNotify()
}

// handle processes JSON-RPC requests
func (s *Server) handle(c context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) (interface{}, error) {
	switch req.Method {
	case "health":
		return s.handleHealth(), nil

	case "execute":
		var params ExecuteParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleExecute(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "read_file":
		var params ReadFileParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleReadFile(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "write_file":
		var params WriteFileParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleWriteFile(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "list_dir":
		var params ListDirParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleListDir(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "sync_to_guest":
		var params SyncToGuestParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleSyncToGuest(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "sync_from_guest":
		var params SyncFromGuestParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleSyncFromGuest(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "start_session":
		var params StartSessionParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleStartSession(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "send_to_session":
		var params SendToSessionParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleSendToSession(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "read_session":
		var params ReadSessionParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleReadSession(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "list_sessions":
		result, err := s.handleListSessions()
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	case "kill_session":
		var params KillSessionParams
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			return nil, &jsonrpc2.Error{Code: InvalidParams, Message: "Invalid params"}
		}
		result, err := s.handleKillSession(&params)
		if err != nil {
			return nil, &jsonrpc2.Error{Code: ExecutionError, Message: err.Error()}
		}
		return result, nil

	default:
		return nil, &jsonrpc2.Error{Code: MethodNotFound, Message: "Method not found"}
	}
}

// Uptime returns the server uptime in seconds
func (s *Server) Uptime() float64 {
	return time.Since(s.startTime).Seconds()
}
