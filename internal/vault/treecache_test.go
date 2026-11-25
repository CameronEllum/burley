package vault

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTreeCacheRoundTripAndInvalidation(t *testing.T) {
	root := t.TempDir()
	v, err := NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	if _, ok, err := v.ReadTreeCache(ctx); err != nil || ok {
		t.Fatalf("expected cache miss on empty vault, got ok=%v err=%v", ok, err)
	}

	want := []Entry{
		{Name: "a.md", Path: "a.md", ModTime: 1700000001000, Size: 12},
		{Name: "b.md", Path: "notes/b.md", ModTime: 1700000002000, Size: 345},
	}
	if err := v.WriteTreeCache(ctx, want); err != nil {
		t.Fatalf("WriteTreeCache: %v", err)
	}

	got, ok, err := v.ReadTreeCache(ctx)
	if err != nil || !ok {
		t.Fatalf("ReadTreeCache hit failed: ok=%v err=%v", ok, err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// Changing enabled file types must invalidate the cache.
	s := defaultSettings()
	s.FileTypes = []string{"markdown"}
	if err := v.WriteSettings(ctx, s); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := v.ReadTreeCache(ctx); err != nil || ok {
		t.Fatalf("expected cache miss after fileTypes change, got ok=%v err=%v", ok, err)
	}

	// Corrupting the file must fall back cleanly without error.
	if err := os.WriteFile(filepath.Join(root, ".burley", "tree-cache.bin"), []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := v.ReadTreeCache(ctx); err != nil || ok {
		t.Fatalf("expected clean miss on corrupt cache, got ok=%v err=%v", ok, err)
	}
}
