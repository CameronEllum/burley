package api

import (
	"context"
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

func buildFakeAgent(t *testing.T, name, source string) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module fakeagent\n\ngo 1.21\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	binary := name
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	out := filepath.Join(dir, binary)
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake %s: %v\n%s", name, err, output)
	}
	return dir
}

const fakeOpenCodeSource = `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "models" {
		fmt.Println("opencode-go/deepseek-v4.1-flash")
		fmt.Println("opencode-go/deepseek-v4-pro")
		return
	}
	if path := os.Getenv("FAKE_ARGS_FILE"); path != "" {
		_ = os.WriteFile(path, []byte(strings.Join(args, "\x00")), 0o644)
	}
	fmt.Println("fake opencode answer")
}
`

func TestAgentModelsAndPinnedModel(t *testing.T) {
	binDir := buildFakeAgent(t, "opencode", fakeOpenCodeSource)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	argsFile := filepath.Join(t.TempDir(), "args.bin")
	t.Setenv("FAKE_ARGS_FILE", argsFile)

	root := t.TempDir()
	v, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.WriteSettings(context.Background(), vault.Settings{
		Theme:       "system",
		AgentModels: map[string]string{"opencode": "opencode-go/deepseek-v4-pro"},
	}); err != nil {
		t.Fatal(err)
	}
	handler := New(v, nil, Options{Root: root})

	req := httptest.NewRequest(http.MethodGet, "/api/agent/models?agent=opencode", nil)
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("models = %d %s", rr.Code, rr.Body.String())
	}
	var listing struct {
		Models      []string `json:"models"`
		Pinned      string   `json:"pinned"`
		Unsupported bool     `json:"unsupported"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listing); err != nil {
		t.Fatal(err)
	}
	if len(listing.Models) != 2 || listing.Unsupported {
		t.Fatalf("listing = %+v", listing)
	}
	if listing.Pinned != "opencode-go/deepseek-v4-pro" {
		t.Fatalf("pinned = %q", listing.Pinned)
	}

	body := `{"agent":"opencode","prompt":"hi","path":"","mode":"ask"}`
	req = httptest.NewRequest(http.MethodPost, "/api/agent/chat", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("chat = %d %s", rr.Code, rr.Body.String())
	}
	response := rr.Body.String()
	if !strings.Contains(response, "fake opencode answer") {
		t.Fatalf("missing agent output:\n%s", response)
	}
	if !strings.Contains(response, `"model":"opencode-go/deepseek-v4-pro"`) {
		t.Fatalf("meta should report the pinned model:\n%s", response)
	}

	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("agent args were not recorded: %v", err)
	}
	args := strings.Split(string(raw), "\x00")
	if len(args) < 4 || args[0] != "run" || args[1] != "--model" || args[2] != "opencode-go/deepseek-v4-pro" {
		t.Fatalf("agent args = %q", args)
	}
	if !strings.Contains(args[len(args)-1], "hi") {
		t.Fatalf("prompt missing from args: %q", args)
	}
}
