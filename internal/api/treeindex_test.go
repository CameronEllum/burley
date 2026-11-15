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
