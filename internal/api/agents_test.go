package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"burley/internal/vault"
)

func TestAgentsEndpoint(t *testing.T) {
	h := newHarness(t)
	resp, data := h.do(t, "GET", "/api/agents", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("agents = %d %s", resp.StatusCode, data)
	}
	var payload struct {
		Agents []struct {
			ID string `json:"id"`
		} `json:"agents"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Agents) != 4 {
		t.Fatalf("agents = %+v, want 4 adapters", payload.Agents)
	}
}

func buildFakeClaude(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	dir := t.TempDir()
	module := "module fakeclaude\n\ngo 1.21\n"
	source := `package main

import "fmt"

func main() {
	fmt.Println("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello from fake agent\"}]}}")
}
`
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(module), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	name := "claude"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	out := filepath.Join(dir, name)
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake claude: %v\n%s", err, output)
	}
	return dir
}

func TestAgentChatStreamsSSE(t *testing.T) {
	binDir := buildFakeClaude(t)
	oldPath := os.Getenv("PATH")
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+oldPath)

	root := t.TempDir()
	v, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	handler := New(v, nil, Options{Root: root})

	body := `{"agent":"claude","prompt":"hi","path":"","mode":"ask"}`
	req := httptest.NewRequest(http.MethodPost, "/api/agent/chat", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("chat = %d %s", rr.Code, rr.Body.String())
	}
	response := rr.Body.String()
	if !strings.Contains(response, "Hello from fake agent") {
		t.Fatalf("missing agent output:\n%s", response)
	}
	if !strings.Contains(response, "event: done") {
		t.Fatalf("missing done event:\n%s", response)
	}
}
