// Command burley serves a folder of Markdown files as an Obsidian-style
// live-preview editor over HTTP.
//
// The compiled frontend (web/dist) is embedded into the binary with
// //go:embed, so the result is a single self-contained executable.
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"burley/internal/agent"
	"burley/internal/api"
	"burley/internal/demo"
	"burley/internal/syntax"
	"burley/internal/vault"
)

//go:embed all:dist
var embeddedFrontend embed.FS

// version is injected by release builds via -ldflags "-X main.version=…".
// Local builds fall back to this dev marker.
var version = "0.0.0-dev"

// createListener binds preferredAddr, or the next free port (up to 20 attempts)
// when it is already in use, finally falling back to an OS-assigned port. It
// returns the listener and the address it actually bound to.
func createListener(preferredAddr string) (net.Listener, string, error) {
	ln, err := net.Listen("tcp", preferredAddr)
	if err == nil {
		return ln, preferredAddr, nil
	}

	host, portStr, splitErr := net.SplitHostPort(preferredAddr)
	if splitErr != nil {
		host = "127.0.0.1"
		portStr = "8080"
	}
	if host == "" {
		host = "127.0.0.1"
	}
	startPort, convErr := strconv.Atoi(portStr)
	if convErr != nil || startPort <= 0 || startPort > 65515 {
		return nil, "", err
	}

	for p := startPort + 1; p <= startPort+20; p++ {
		candidate := net.JoinHostPort(host, strconv.Itoa(p))
		if ln, err := net.Listen("tcp", candidate); err == nil {
			return ln, candidate, nil
		}
	}

	ln, err = net.Listen("tcp", net.JoinHostPort(host, "0"))
	if err != nil {
		return nil, "", err
	}
	return ln, ln.Addr().String(), nil
}

func main() {
	var (
		root        = flag.String("root", ".", "folder containing the Markdown files to serve")
		addr        = flag.String("addr", "127.0.0.1:8080", "address to listen on (host:port); the next free port is used if busy")
		debugAgents    = flag.Bool("debug-agents", false, "log agent CLI invocations, stderr, and exit status")
		showVersion    = flag.Bool("version", false, "print version and exit")
		reportSyntax   = flag.Bool("report-syntax", false, "print Burley's Markdown flavour reference for AI agents and exit")
		initAgentDocs  = flag.Bool("init-agent-docs", false, "create or update AGENTS.md in --root with Burley's Markdown flavour and exit")
		demoMode       = flag.Bool("demo", false, "serve a temporary copy of the built-in demo vault")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("burley %s\n", version)
		return
	}
	if *reportSyntax {
		fmt.Print(syntax.Full)
		if !strings.HasSuffix(syntax.Full, "\n") {
			fmt.Println()
		}
		return
	}
	if *initAgentDocs {
		v, err := vault.NewLocalVault(*root)
		if err != nil {
			log.Fatalf("open vault: %v", err)
		}
		written, err := syntax.WriteAgentDocs(v.Root())
		if err != nil {
			log.Fatalf("write agent docs: %v", err)
		}
		fmt.Println(written)
		return
	}

	logger := log.New(os.Stderr, "burley ", log.LstdFlags|log.Lmsgprefix)

	vaultRoot := *root
	if *demoMode {
		dir, cleanup, err := demo.ExtractToTemp()
		if err != nil {
			logger.Fatalf("prepare demo vault: %v", err)
		}
		defer cleanup()
		vaultRoot = dir
		logger.Printf("demo vault: %s (temporary, removed on exit)", dir)
	}

	v, err := vault.NewLocalVault(vaultRoot)
	if err != nil {
		logger.Fatalf("open vault: %v", err)
	}

	dist, err := fs.Sub(embeddedFrontend, "dist")
	if err != nil {
		logger.Fatalf("embedded frontend: %v", err)
	}
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		logger.Fatalf("embedded frontend is missing index.html (build the web app first): %v", err)
	}

	// The HTTP Quit button and OS signals share one cancellation path so both
	// shut down through the same graceful drain.
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, quit := context.WithCancel(signalCtx)
	defer quit()

	_, rgErr := exec.LookPath("rg")
	handler := api.New(v, dist, api.Options{
		Root:             v.Root(),
		RipgrepAvailable: rgErr == nil,
		Version:          version,
		Logger:           logger,
		DebugAgents:      *debugAgents,
		DemoMode:         *demoMode,
		OnQuit:           quit,
	})

	ln, actualAddr, err := createListener(*addr)
	if err != nil {
		logger.Fatalf("listen: %v", err)
	}

	srv := &http.Server{
		Addr:              actualAddr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	logger.Printf("v%s serving %s", version, v.Root())
	if rgErr == nil {
		logger.Printf("content search: ripgrep")
	} else {
		logger.Printf("content search: built-in fallback (ripgrep not found)")
	}
	logger.Printf("agents: %s", formatAgentSummary(agent.Detect()))
	if actualAddr != *addr {
		logger.Printf("port %s is busy; switched to %s", *addr, actualAddr)
	}
	url := "http://" + displayAddr(ln.Addr().String())
	logger.Printf("listening on %s", url)
	if host, _, _ := net.SplitHostPort(actualAddr); host == "127.0.0.1" || host == "localhost" {
		logger.Printf("remote use: ssh -N -L %s:%s user@your-ec2-host", portOf(actualAddr), actualAddr)
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Serve(ln)
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("serve: %v", err)
		}
	case <-ctx.Done():
		logger.Printf("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Printf("shutdown: %v", err)
		}
	}
}

func formatAgentSummary(infos []agent.Info) string {
	parts := make([]string, 0, len(infos))
	for _, info := range infos {
		if info.Available {
			parts = append(parts, info.ID+"="+info.Path)
		} else {
			parts = append(parts, info.ID+"=missing")
		}
	}
	return strings.Join(parts, " ")
}

func displayAddr(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	if host == "::" || host == "0.0.0.0" {
		host = "localhost"
	}
	return net.JoinHostPort(host, port)
}

func portOf(addr string) string {
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "8080"
	}
	return port
}
