package vault

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// buildFakeRipgrep compiles a tiny rg stand-in used to exercise the streaming
// and exit-code paths without requiring ripgrep on the test machine.
func buildFakeRipgrep(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not available")
	}
	dir := t.TempDir()
	source := `package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	query := os.Args[len(os.Args)-2]
	root := os.Args[len(os.Args)-1]
	if strings.Contains(query, "nomatch") {
		os.Exit(1)
	}
	count := 10000
	slow := strings.Contains(query, "slow")
	for i := 0; i < count; i++ {
		msg := map[string]any{
			"type": "match",
			"data": map[string]any{
				"path":        map[string]string{"text": root + string(os.PathSeparator) + "note.md"},
				"lines":       map[string]string{"text": fmt.Sprintf("line %d needle\n", i)},
				"line_number": i + 1,
				"submatches":  []map[string]int{{"start": 5, "end": 11}},
			},
		}
		encoded, _ := json.Marshal(msg)
		fmt.Println(string(encoded))
		if slow {
			time.Sleep(5 * time.Millisecond)
		}
	}
}
`
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module fakerg\n\ngo 1.21\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	name := "fake-rg"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	out := filepath.Join(dir, name)
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fake rg: %v\n%s", err, output)
	}
	return out
}

func TestSearchRipgrepNoMatchesIsNotAnError(t *testing.T) {
	v, dir := newTestVault(t)
	v.DisableRipgrep = false
	v.RipgrepPath = buildFakeRipgrep(t)

	// The Go fallback would find this; returning nothing proves ripgrep's exit
	// code 1 was handled as an empty result instead of falling back.
	writeFile(t, dir, "note.md", "nomatch needle\n")

	matches, err := v.SearchContent(context.Background(), "nomatch", 10)
	if err != nil {
		t.Fatalf("SearchContent: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("matches = %+v, want empty", matches)
	}
}

func TestSearchRipgrepStopsAtLimit(t *testing.T) {
	v, _ := newTestVault(t)
	v.DisableRipgrep = false
	v.RipgrepPath = buildFakeRipgrep(t)

	start := time.Now()
	matches, err := v.SearchContent(context.Background(), "slow needle", 2)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("SearchContent: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("matches = %d, want 2", len(matches))
	}
	if elapsed > 3*time.Second {
		t.Fatalf("search took %s; output was not cancelled at the limit", elapsed)
	}
	if matches[0].Path != "note.md" || matches[0].Line != 1 {
		t.Fatalf("first match = %+v", matches[0])
	}
	if !strings.Contains(matches[0].Snippet, "needle") {
		t.Fatalf("snippet = %q", matches[0].Snippet)
	}
}
