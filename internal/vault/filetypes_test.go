package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSettingsFileTypesDefaultAndYAML(t *testing.T) {
	ctx := context.Background()
	v, err := NewLocalVault(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}

	got, _, err := v.ReadSettings(ctx)
	if err != nil {
		t.Fatalf("ReadSettings default: %v", err)
	}
	if !reflect.DeepEqual(got.FileTypes, []string{"markdown", "html"}) {
		t.Fatalf("default FileTypes = %v, want [markdown html]", got.FileTypes)
	}

	got.FileTypes = []string{"markdown"}
	if err := v.WriteSettings(ctx, got); err != nil {
		t.Fatalf("WriteSettings: %v", err)
	}
	reloaded, exists, err := v.ReadSettings(ctx)
	if err != nil || !exists {
		t.Fatalf("ReadSettings reload: exists=%v err=%v", exists, err)
	}
	if !reflect.DeepEqual(reloaded.FileTypes, []string{"markdown"}) {
		t.Fatalf("reloaded FileTypes = %v, want [markdown]", reloaded.FileTypes)
	}

	// Legacy YAML without file_type_* keys should default both to enabled.
	legacy := "theme: dark\nwide_mode: true\n"
	if err := os.WriteFile(filepath.Join(v.root, ".burley", "settings.yaml"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy settings: %v", err)
	}
	fromLegacy, _, err := v.ReadSettings(ctx)
	if err != nil {
		t.Fatalf("ReadSettings legacy: %v", err)
	}
	if !reflect.DeepEqual(fromLegacy.FileTypes, []string{"markdown", "html"}) {
		t.Fatalf("legacy FileTypes = %v, want [markdown html]", fromLegacy.FileTypes)
	}
}

func TestFileTypesTreeAndSearchFiltering(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("# Hello\nneedle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "page.html"), []byte("<h1>Hi</h1><p>needle</p>"), 0o644); err != nil {
		t.Fatal(err)
	}

	v, err := NewLocalVault(root)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}

	treeNames := func() []string {
		tree, err := v.Tree(ctx)
		if err != nil {
			t.Fatalf("Tree: %v", err)
		}
		var names []string
		for _, c := range tree {
			names = append(names, c.Name)
		}
		return names
	}

	searchPaths := func() []string {
		hits, err := v.SearchContent(ctx, "needle", 50)
		if err != nil {
			t.Fatalf("Search: %v", err)
		}
		var paths []string
		for _, h := range hits {
			paths = append(paths, h.Path)
		}
		return paths
	}

	if got := treeNames(); !reflect.DeepEqual(got, []string{"note.md", "page.html"}) {
		t.Fatalf("default Tree = %v, want [note.md page.html]", got)
	}
	if got := searchPaths(); !reflect.DeepEqual(got, []string{"note.md", "page.html"}) {
		t.Fatalf("default Search = %v, want [note.md page.html]", got)
	}

	s, _, _ := v.ReadSettings(ctx)
	s.FileTypes = []string{"markdown"}
	if err := v.WriteSettings(ctx, s); err != nil {
		t.Fatalf("WriteSettings markdown only: %v", err)
	}
	if got := treeNames(); !reflect.DeepEqual(got, []string{"note.md"}) {
		t.Fatalf("markdown-only Tree = %v, want [note.md]", got)
	}
	if got := searchPaths(); !reflect.DeepEqual(got, []string{"note.md"}) {
		t.Fatalf("markdown-only Search = %v, want [note.md]", got)
	}

	s.FileTypes = []string{"html"}
	if err := v.WriteSettings(ctx, s); err != nil {
		t.Fatalf("WriteSettings html only: %v", err)
	}
	if got := treeNames(); !reflect.DeepEqual(got, []string{"page.html"}) {
		t.Fatalf("html-only Tree = %v, want [page.html]", got)
	}
	if got := searchPaths(); !reflect.DeepEqual(got, []string{"page.html"}) {
		t.Fatalf("html-only Search = %v, want [page.html]", got)
	}
}

func TestReadRaw(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "page.html"), []byte("<h1>Hi</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "app.js"), []byte("console.log(1);"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".burley"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".burley", "secret.html"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}

	v, err := NewLocalVault(root)
	if err != nil {
		t.Fatalf("NewLocal: %v", err)
	}

	data, ct, err := v.ReadRaw(ctx, "page.html")
	if err != nil {
		t.Fatalf("ReadRaw page.html: %v", err)
	}
	if string(data) != "<h1>Hi</h1>" || ct != "text/html; charset=utf-8" {
		t.Fatalf("ReadRaw page.html = (%q, %q)", string(data), ct)
	}

	_, jsCT, err := v.ReadRaw(ctx, "app.js")
	if err != nil || jsCT != "application/javascript; charset=utf-8" {
		t.Fatalf("ReadRaw app.js = (%q, %v)", jsCT, err)
	}

	if _, _, err := v.ReadRaw(ctx, ".burley/secret.html"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("ReadRaw .burley/secret.html err = %v, want ErrInvalidPath", err)
	}
	if _, _, err := v.ReadRaw(ctx, "../outside.html"); err == nil {
		t.Fatal("ReadRaw ../outside.html succeeded, want error")
	}
}
