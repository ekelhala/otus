.PHONY: build clean test fmt vet all

# Binary name
BINARY=../../dist/otus-agent

# Build flags
CGO_ENABLED=0
GOOS=linux
GOARCH=amd64
LDFLAGS=-ldflags="-s -w"

all: build

build:
	CGO_ENABLED=$(CGO_ENABLED) GOOS=$(GOOS) GOARCH=$(GOARCH) go build $(LDFLAGS) -o $(BINARY) .

clean:
	rm -f $(BINARY)
	go clean

test:
	go test -v ./...

fmt:
	go fmt ./...

vet:
	go vet ./...

run: build
	./$(BINARY)
