package api

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"burley/internal/vault"
)

func TestTreeWatcherDetectsExternalChangesInWatchedDirs(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "other"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "root.md"), []byte("# Root\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "a.md"), []byte("# A\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "other", "b.md"), []byte("# B\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	v, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{vault: v}
	s.initTreeWatcher()
	if s.watcher == nil {
		t.Fatal("expected treeWatcher to initialize")
	}
	s.watcher.debounce = 30 * time.Millisecond
	defer s.closeTreeWatcher()

	s.startTreeScan(false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, _, _ := s.treeSnapshot()
		if done && len(files) == 3 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	initialVer := s.treeVersion()

	watched, capped := s.watcher.setDirs([]string{"sub"})
	if capped || watched != 2 {
		t.Fatalf("setDirs = (%d, %v), want (2, false)", watched, capped)
	}

	if err := os.WriteFile(filepath.Join(root, "sub", "new.md"), []byte("# New\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var addedFound bool
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ver, delta, status := s.treeDeltaSince(initialVer)
		if status == "delta" && ver > initialVer {
			for _, f := range delta.added {
				if f.Path == "sub/new.md" {
					addedFound = true
					break
				}
			}
			if addedFound {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !addedFound {
		t.Fatalf("watcher did not record delta for sub/new.md")
	}

	afterAddVer := s.treeVersion()
	if err := os.Remove(filepath.Join(root, "sub", "a.md")); err != nil {
		t.Fatal(err)
	}

	var removedFound bool
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		ver, delta, status := s.treeDeltaSince(afterAddVer)
		if status == "delta" && ver > afterAddVer {
			for _, p := range delta.removed {
				if p == "sub/a.md" {
					removedFound = true
					break
				}
			}
			if removedFound {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !removedFound {
		t.Fatalf("watcher did not record removal delta for sub/a.md")
	}
}

func TestTreeWatcherEnforcesMaxDirCapAndIgnoresHidden(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"d1", "d2", "d3", "d4", ".git", "node_modules"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	v, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{vault: v}
	s.initTreeWatcher()
	if s.watcher == nil {
		t.Fatal("expected treeWatcher to initialize")
	}
	defer s.closeTreeWatcher()

	s.watcher.maxDirs = 3 // root + at most 2 subdirs
	watched, capped := s.watcher.setDirs([]string{".git", "node_modules", "d1", "d2", "d3", "d4"})
	if !capped {
		t.Fatalf("expected capped=true when exceeding maxDirs=3")
	}
	if watched != 3 {
		t.Fatalf("watched = %d, want 3", watched)
	}
}

func TestHandleWatchTreeEndpoint(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.root, "notes"), 0o755); err != nil {
		t.Fatal(err)
	}
	resp, data := h.do(t, http.MethodPost, "/api/tree/watch", map[string]any{
		"dirs": []string{"notes", ".burley"},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/tree/watch = %d %s", resp.StatusCode, data)
	}
}

func TestRefreshTreeDiffsInPlaceWithoutClearingFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "keep.md"), []byte("# Keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	v, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{vault: v}
	s.startTreeScan(false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, _, _ := s.treeSnapshot()
		if done && len(files) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := os.WriteFile(filepath.Join(root, "added.md"), []byte("# Added\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s.startTreeScan(true)

	// Immediately after starting a refresh, keep.md must still be present in the snapshot.
	files, _, _, _ := s.treeSnapshot()
	if len(files) == 0 || files[0].Path != "keep.md" {
		t.Fatalf("refresh cleared existing files mid-scan: %+v", files)
	}

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, scanning, _ := s.treeSnapshot()
		if done && !scanning && len(files) == 2 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	files, _, _, _ = s.treeSnapshot()
	t.Fatalf("refresh did not diff in added.md; files = %+v", files)
}

func TestServerWarmsTreeFromBinaryCacheAndReconciles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "keep.md"), []byte("# Keep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "gone.md"), []byte("# Gone\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	v1, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	s1 := &server{vault: v1}
	s1.startTreeScan(false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, _, _ := s1.treeSnapshot()
		if done && len(files) == 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	cachePath := filepath.Join(root, ".burley", "tree-cache.bin")
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(cachePath); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("expected tree-cache.bin to be written: %v", err)
	}

	// Simulate changes while Burley is stopped.
	if err := os.Remove(filepath.Join(root, "gone.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "new.md"), []byte("# New\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	v2, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	s2 := &server{vault: v2}
	s2.startTreeScan(false)

	// Reconciled snapshot should contain keep.md and new.md, and drop gone.md.
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, scanning, _ := s2.treeSnapshot()
		if done && !scanning && len(files) == 2 {
			if files[0].Path == "keep.md" && files[1].Path == "new.md" {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	files, _, _, _ := s2.treeSnapshot()
	t.Fatalf("reconciled files = %+v, want [keep.md new.md]", files)
}
