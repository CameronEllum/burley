package vault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRecentRoundTrip(t *testing.T) {
	v, dir := newTestVault(t)
	ctx := context.Background()

	initial, err := v.ReadRecent(ctx)
	if err != nil || len(initial) != 0 {
		t.Fatalf("initial recent = %v %v", initial, err)
	}

	paths := []string{"welcome.md", "notes/todo.md", "welcome.md", "notes/deep/analysis.md"}
	if err := v.WriteRecent(ctx, paths); err != nil {
		t.Fatalf("WriteRecent: %v", err)
	}
	got, err := v.ReadRecent(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"welcome.md", "notes/todo.md", "notes/deep/analysis.md"}
	if len(got) != len(want) {
		t.Fatalf("recent = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("recent = %v, want %v", got, want)
		}
	}

	raw, err := os.ReadFile(filepath.Join(dir, ".burley", "recent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "recent:") || !strings.Contains(string(raw), `- "welcome.md"`) {
		t.Fatalf("unexpected yaml:\n%s", raw)
	}
}

func TestRecentCapsAtTen(t *testing.T) {
	v, _ := newTestVault(t)
	paths := make([]string, 0, 12)
	for _, name := range []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"} {
		paths = append(paths, name+".md")
	}
	if err := v.WriteRecent(context.Background(), paths); err != nil {
		t.Fatal(err)
	}
	got, err := v.ReadRecent(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 10 || got[0] != "a.md" || got[9] != "j.md" {
		t.Fatalf("capped recent = %v", got)
	}
}

func TestRecentValidation(t *testing.T) {
	v, _ := newTestVault(t)
	for _, bad := range [][]string{{"../escape.md"}, {"/etc/passwd"}, {".burley/hidden.md"}} {
		if err := v.WriteRecent(context.Background(), bad); err == nil {
			t.Fatalf("WriteRecent(%v) accepted invalid path", bad)
		}
	}
}
