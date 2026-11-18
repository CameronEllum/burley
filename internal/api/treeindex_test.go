package api

import (
	"encoding/json"
	"testing"

	"burley/internal/vault"
)

func TestTreeEndpointReportsCompletion(t *testing.T) {
	h := newHarness(t)
	h.write(t, "a.md", "# A\n")
	h.write(t, "notes/b.md", "# B\n")

	var payload struct {
		Tree    []vault.Entry `json:"tree"`
		Files   []flatFile    `json:"files"`
		Done    bool          `json:"done"`
		Scanned int           `json:"scanned"`
	}
	resp, data := h.do(t, "GET", "/api/tree", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("tree = %d %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Done || payload.Scanned != 2 || len(payload.Files) != 2 {
		t.Fatalf("payload = %+v", payload)
	}

	// The root should contain the note and the folder, folders first.
	if len(payload.Tree) != 2 || !payload.Tree[0].IsDir || payload.Tree[0].Name != "notes" {
		t.Fatalf("tree = %+v", payload.Tree)
	}
	if payload.Tree[1].Path != "a.md" {
		t.Fatalf("root files = %+v", payload.Tree[1])
	}

	// refresh=1 rescans and still finishes for a small vault.
	resp, data = h.do(t, "GET", "/api/tree?refresh=1", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("refresh = %d %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Done || payload.Scanned != 2 {
		t.Fatalf("refresh payload = %+v", payload)
	}
}

func TestDeleteUpdatesTreeWithoutRescan(t *testing.T) {
	h := newHarness(t)
	h.write(t, "keep.md", "# Keep\n")
	h.write(t, "folder/one.md", "# One\n")
	h.write(t, "folder/sub/two.md", "# Two\n")

	// Prime the tree cache.
	resp, data := h.do(t, "GET", "/api/tree", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("tree = %d %s", resp.StatusCode, data)
	}

	// Deleting a folder removes its entries in place while keeping done=true.
	resp, data = h.do(t, "DELETE", "/api/file?path=folder", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete = %d %s", resp.StatusCode, data)
	}

	// Even if another file exists on disk untracked, /api/tree (without refresh=1)
	// should serve the updated cache without triggering a full rescan.
	h.write(t, "unscanned.md", "# Unscanned\n")

	var payload struct {
		Files    []flatFile `json:"files"`
		Done     bool       `json:"done"`
		Scanning bool       `json:"scanning"`
	}
	resp, data = h.do(t, "GET", "/api/tree", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("tree after delete = %d %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Done || payload.Scanning {
		t.Fatalf("expected cached done=true scanning=false, got %+v", payload)
	}
	if len(payload.Files) != 1 || payload.Files[0].Path != "keep.md" {
		t.Fatalf("files = %+v, want only keep.md", payload.Files)
	}
}

func TestRescanFolderUpdatesOnlyTargetFolder(t *testing.T) {
	h := newHarness(t)
	h.write(t, "other/keep.md", "# Keep\n")
	h.write(t, "target/a.md", "# A\n")

	// Prime the cache.
	resp, data := h.do(t, "GET", "/api/tree", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("tree = %d %s", resp.StatusCode, data)
	}

	// Add a file in both target/ and other/; rescanning target/ should pick up
	// target/b.md without rescanning other/.
	h.write(t, "target/b.md", "# B\n")
	h.write(t, "other/unscanned.md", "# Unscanned\n")

	resp, data = h.do(t, "POST", "/api/tree/rescan?path=target", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("rescan = %d %s", resp.StatusCode, data)
	}
	var payload struct {
		Files []flatFile `json:"files"`
		Done  bool       `json:"done"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Done {
		t.Fatalf("expected done=true after folder rescan")
	}
	if len(payload.Files) != 3 {
		t.Fatalf("files = %+v, want 3 entries (other/keep.md, target/a.md, target/b.md)", payload.Files)
	}
	for _, f := range payload.Files {
		if f.Path == "other/unscanned.md" {
			t.Fatalf("folder rescan unexpectedly rescanned other/: %+v", payload.Files)
		}
	}
}
