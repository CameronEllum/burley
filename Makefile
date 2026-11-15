# Burley — build, test, and packaging.
#
#   make build     # frontend + Go binary for the host (bin/burley)
#   make linux     # cross-compiled EC2 binary (bin/burley-linux-amd64)
#   make test      # Go tests + frontend type check
#   make run       # build then serve ./demo-vault on 127.0.0.1:8080
#   make clean

BINARY      := burley
BIN_DIR     := bin
WEB_DIR     := web
DIST_DIR    := cmd/server/dist
ROOT        ?= ./demo-vault
ADDR        ?= 127.0.0.1:8080

.PHONY: all build web dist run linux test test-go check clean deps

all: build

deps:
	cd $(WEB_DIR) && npm install

web:
	cd $(WEB_DIR) && npm run build

# Copy the Vite output next to cmd/server so //go:embed can pick it up.
dist: web
	rm -rf $(DIST_DIR)
	cp -r $(WEB_DIR)/dist $(DIST_DIR)

build: dist
	mkdir -p $(BIN_DIR)
	go build -trimpath -ldflags "-s -w" -o $(BIN_DIR)/$(BINARY) ./cmd/server

# EC2 / Linux x86-64 build (single self-contained binary).
linux: dist
	mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o $(BIN_DIR)/$(BINARY)-linux-amd64 ./cmd/server

run: build
	./$(BIN_DIR)/$(BINARY) --root $(ROOT) --addr $(ADDR)

test: test-go check

test-go:
	go vet ./...
	go test ./...

check:
	cd $(WEB_DIR) && npm run check

clean:
	rm -rf $(BIN_DIR) $(WEB_DIR)/dist $(DIST_DIR)
