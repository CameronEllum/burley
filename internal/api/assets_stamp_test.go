package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFileAssetsStampChangesWhenAssetModified(t *testing.T) {
	h := newHarness(t)
	if err := os.MkdirAll(filepath.Join(h.root, "img"), 0o755); err != nil {
		t.Fatal(err)
	}
	assetPath := filepath.Join(h.root, "img", "plot.png")
	if err := os.WriteFile(assetPath, []byte("png-v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.root, "note.md"), []byte("![plot](img/plot.png)\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	getStamp := func() string {
		resp, err := http.Get(h.srv.URL + "/api/file/assets?path=note.md")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var body struct {
			HasAssets bool   `json:"hasAssets"`
			Stamp     string `json:"stamp"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if !body.HasAssets || body.Stamp == "" {
			t.Fatalf("expected hasAssets=true and non-empty stamp, got %+v", body)
		}
		return body.Stamp
	}

	stamp1 := getStamp()
	// Ensure mtime and size both differ.
	time.Sleep(20 * time.Millisecond)
	if err := os.WriteFile(assetPath, []byte("png-v2-updated"), 0o644); err != nil {
		t.Fatal(err)
	}
	stamp2 := getStamp()
	if stamp1 == stamp2 {
		t.Fatalf("expected asset stamp to change after modifying asset, still %q", stamp1)
	}
}
