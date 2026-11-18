package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"burley/internal/vault"
)

func TestBackgroundScanSettingsRoundTrip(t *testing.T) {
	h := newHarness(t)

	resp, err := http.Get(h.srv.URL + "/api/settings")
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		Settings vault.Settings `json:"settings"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil {
		resp.Body.Close()
		t.Fatal(err)
	}
	resp.Body.Close()
	if env.Settings.BackgroundScan {
		t.Fatalf("default BackgroundScan = true, want false")
	}

	env.Settings.BackgroundScan = true
	payload, _ := json.Marshal(env.Settings)
	req, _ := http.NewRequest(http.MethodPut, h.srv.URL+"/api/settings", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/settings status = %d, want 200", putResp.StatusCode)
	}

	resp2, err := http.Get(h.srv.URL + "/api/settings")
	if err != nil {
		t.Fatal(err)
	}
	var env2 struct {
		Settings vault.Settings `json:"settings"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&env2); err != nil {
		resp2.Body.Close()
		t.Fatal(err)
	}
	resp2.Body.Close()
	if !env2.Settings.BackgroundScan {
		t.Fatalf("persisted BackgroundScan = false, want true")
	}
}

func TestLowPriorityBackgroundScanUpdatesTree(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "initial.md"), []byte("# Initial\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	v, err := vault.NewLocalVault(root)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{
		vault: v,
		tree: treeState{
			bgInterval: 25 * time.Millisecond,
			bgPace:     2 * time.Millisecond,
		},
	}
	defer s.configureBackgroundScan(false)

	// Prime the tree cache via a normal foreground scan.
	s.startTreeScan(false)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, _, _ := s.treeSnapshot()
		if done && len(files) == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Enable background scan, then add a file externally on disk.
	s.configureBackgroundScan(true)
	if err := os.WriteFile(filepath.Join(root, "external.md"), []byte("# External\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Without calling startTreeScan(true) or invalidateTree(), the low-priority
	// background scan should discover external.md and swap it into treeSnapshot.
	found := false
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		files, done, scanning, _ := s.treeSnapshot()
		if done && !scanning {
			var names []string
			for _, f := range files {
				names = append(names, f.Name)
			}
			joined := strings.Join(names, ",")
			if strings.Contains(joined, "external.md") && strings.Contains(joined, "initial.md") {
				found = true
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !found {
		files, _, _, _ := s.treeSnapshot()
		t.Fatalf("background scan did not pick up external.md; files = %+v", files)
	}

	// Disabling background scan should stop updates for subsequent external files.
	s.configureBackgroundScan(false)
	if err := os.WriteFile(filepath.Join(root, "after-stop.md"), []byte("# After\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	files, _, _, _ := s.treeSnapshot()
	for _, f := range files {
		if f.Name == "after-stop.md" {
			t.Fatalf("background scan still ran after being disabled")
		}
	}
	_ = io.Discard
}

func TestTreeSinceVersionUnchanged(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(filepath.Join(h.root, "a.md"), []byte("# A\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var first struct {
		Version   uint64 `json:"version"`
		Unchanged bool   `json:"unchanged"`
		Done      bool   `json:"done"`
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(h.srv.URL + "/api/tree")
		if err != nil {
			t.Fatal(err)
		}
		err = json.NewDecoder(resp.Body).Decode(&first)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if first.Done {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !first.Done || first.Version == 0 {
		t.Fatalf("expected completed tree with non-zero version, got %+v", first)
	}

	resp2, err := http.Get(h.srv.URL + "/api/tree?since=" + strings.TrimSpace(jsonNumber(first.Version)))
	if err != nil {
		t.Fatal(err)
	}
	var second struct {
		Version   uint64 `json:"version"`
		Unchanged bool   `json:"unchanged"`
		Done      bool   `json:"done"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&second); err != nil {
		resp2.Body.Close()
		t.Fatal(err)
	}
	resp2.Body.Close()
	if !second.Unchanged || second.Version != first.Version {
		t.Fatalf("expected unchanged=true version=%d, got %+v", first.Version, second)
	}

	// Now test delta response when a file is added and another is removed.
	s := &server{
		vault: h.v,
		tree: treeState{
			bgInterval: 20 * time.Millisecond,
			bgPace:     1 * time.Millisecond,
		},
	}
	s.startTreeScan(false)
	for time.Now().Before(time.Now().Add(2 * time.Second)) {
		_, done, _, _ := s.treeSnapshot()
		if done {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	v0 := s.treeVersion()
	s.configureBackgroundScan(true)
	defer s.configureBackgroundScan(false)

	if err := os.MkdirAll(filepath.Join(h.root, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.root, "sub", "new.md"), []byte("# New\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(h.root, "a.md")); err != nil {
		t.Fatal(err)
	}

	var gotDelta treeDelta
	var status string
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, gotDelta, status = s.treeDeltaSince(v0)
		if status == "delta" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if status != "delta" {
		t.Fatalf("expected delta status, got %q", status)
	}
	if len(gotDelta.added) != 1 || gotDelta.added[0].Path != "sub/new.md" {
		t.Fatalf("delta.added = %+v, want [sub/new.md]", gotDelta.added)
	}
	if len(gotDelta.removed) != 1 || gotDelta.removed[0] != "a.md" {
		t.Fatalf("delta.removed = %+v, want [a.md]", gotDelta.removed)
	}
}

func jsonNumber(v uint64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
