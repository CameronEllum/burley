package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveAsset(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "notes/analysis.md", "# Analysis\n")
	ctx := context.Background()

	data := []byte("\x89PNG\r\n\x1a\nfake")
	rel, err := v.SaveAsset(ctx, "notes/analysis.md", "Screenshot 2026.png", data, "image/png")
	if err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}
	if rel != "notes/analysis_assets/screenshot-2026.png" {
		t.Fatalf("rel = %q", rel)
	}
	full := filepath.Join(dir, filepath.FromSlash(rel))
	raw, err := os.ReadFile(full)
	if err != nil || string(raw) != string(data) {
		t.Fatalf("stored bytes = %q %v", raw, err)
	}

	// Duplicate names get a numeric suffix.
	rel2, err := v.SaveAsset(ctx, "notes/analysis.md", "screenshot-2026.png", data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if rel2 != "notes/analysis_assets/screenshot-2026-1.png" {
		t.Fatalf("second rel = %q", rel2)
	}

	if _, err := v.SaveAsset(ctx, "notes/analysis.md", "x.txt", []byte("hello"), "text/plain"); !errors.Is(err, ErrUnsupportedMedia) {
		t.Fatalf("text upload err = %v, want ErrUnsupportedMedia", err)
	}
	if _, err := v.SaveAsset(ctx, "../escape.md", "x.png", data, "image/png"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("traversal note err = %v, want ErrForbidden", err)
	}
	if _, err := v.SaveAsset(ctx, "notes/analysis.md", "x.png", nil, "image/png"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("empty upload err = %v, want ErrInvalidPath", err)
	}
}

func TestAssetFolderUsesNoteName(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "notes/deep/run-1.md", "# Run\n")
	rel, err := v.SaveAsset(context.Background(), "notes/deep/run-1.md", "plot.png", []byte("png"), "image/png")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rel, "notes/deep/run-1_assets/") {
		t.Fatalf("asset path = %q, want run-1_assets", rel)
	}
}
