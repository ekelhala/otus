// Otus Guest Agent (Go implementation)
//
// A stateless execution agent that runs inside the Firecracker VM.
// Listens on VSock for JSON-RPC commands from the host daemon.
//
// Build: CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o otus-agent .

package main

func main() {
	server := NewServer()
	server.Start()
}
