package demo

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmbeddedDemoMatchesDemoVault(t *testing.T) {
	repoDemo := filepath.Join("..", "..", "demo-vault")
	if _, err := os.Stat(repoDemo); err != nil {
		t.Skip("demo-vault directory not present")
	}

	expected := map[string][]byte{}
	err := filepath.WalkDir(repoDemo, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(repoDemo, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() && (d.Name() == ".burley" || strings.HasPrefix(rel, ".burley/")) {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		expected[rel] = data
		return nil
	})
	if err != nil {
		t.Fatalf("walk demo-vault: %v", err)
	}

	actual := map[string][]byte{}
	rootFS := subFS()
	err = fs.WalkDir(rootFS, ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil || p == "." {
			return walkErr
		}
		if d.IsDir() && (d.Name() == ".burley" || strings.HasPrefix(p, ".burley/")) {
			return fs.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(rootFS, p)
		if err != nil {
			return err
		}
		actual[p] = data
		return nil
	})
	if err != nil {
		t.Fatalf("walk embedded demo: %v", err)
	}

	if len(actual) != len(expected) {
		t.Fatalf("embedded demo file count = %d, demo-vault = %d", len(actual), len(expected))
	}
	for rel, want := range expected {
		got, ok := actual[rel]
		if !ok {
			t.Fatalf("embedded demo missing %s", rel)
		}
		if string(got) != string(want) {
			t.Fatalf("embedded demo %s differs from demo-vault", rel)
		}
	}
}

func TestVirtualDemoTreeAndRead(t *testing.T) {
	entries, flat := Tree()
	if len(entries) == 0 || len(flat) == 0 {
		t.Fatal("expected non-empty virtual demo tree")
	}
	data, err := Read("_demo/welcome.md")
	if err != nil {
		t.Fatalf("Read(_demo/welcome.md): %v", err)
	}
	if data.Content == "" || data.Hash == "" {
		t.Fatalf("unexpected empty FileData: %+v", data)
	}
	if _, err := Read("_demo/notes/equations.md"); err != nil {
		t.Fatalf("Read(_demo/notes/equations.md): %v", err)
	}
	if _, err := ReadAsset("_demo/notes/data/benchmarks.csv"); err != nil {
		t.Fatalf("ReadAsset(_demo/notes/data/benchmarks.csv): %v", err)
	}
}
