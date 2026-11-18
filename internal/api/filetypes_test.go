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

	"burley/internal/vault"
)

func TestRawFileAndFileTypesSettings(t *testing.T) {
	h := newHarness(t)
	if err := os.WriteFile(filepath.Join(h.root, "note.md"), []byte("# Note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	htmlBody := "<!doctype html><html><body><div id='x'>hi</div><script>window.__ok=true</script></body></html>"
	if err := os.WriteFile(filepath.Join(h.root, "page.html"), []byte(htmlBody), 0o644); err != nil {
		t.Fatal(err)
	}

	resp, err := http.Get(h.srv.URL + "/raw/page.html")
	if err != nil {
		t.Fatalf("GET /raw/page.html: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /raw/page.html status = %d, want 200", resp.StatusCode)
	}
	if got := resp.Header.Get("Content-Security-Policy"); got != "frame-ancestors 'self'" {
		t.Fatalf("CSP = %q, want frame-ancestors 'self'", got)
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != htmlBody {
		t.Fatalf("raw body = %q, want %q", string(body), htmlBody)
	}

	// Prime tree cache with both files visible.
	treeResp, err := http.Get(h.srv.URL + "/api/tree")
	if err != nil {
		t.Fatal(err)
	}
	treeBytes, _ := io.ReadAll(treeResp.Body)
	treeResp.Body.Close()
	if !strings.Contains(string(treeBytes), "page.html") || !strings.Contains(string(treeBytes), "note.md") {
		t.Fatalf("initial /api/tree = %s, want both note.md and page.html", string(treeBytes))
	}

	// Disable html via PUT /api/settings; server must invalidate tree cache.
	getSettingsResp, err := http.Get(h.srv.URL + "/api/settings")
	if err != nil {
		t.Fatal(err)
	}
	var settingsEnvelope struct {
		Settings vault.Settings `json:"settings"`
	}
	if err := json.NewDecoder(getSettingsResp.Body).Decode(&settingsEnvelope); err != nil {
		getSettingsResp.Body.Close()
		t.Fatal(err)
	}
	getSettingsResp.Body.Close()
	settingsEnvelope.Settings.FileTypes = []string{"markdown"}
	payload, _ := json.Marshal(settingsEnvelope.Settings)
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

	treeResp2, err := http.Get(h.srv.URL + "/api/tree")
	if err != nil {
		t.Fatal(err)
	}
	treeBytes2, _ := io.ReadAll(treeResp2.Body)
	treeResp2.Body.Close()
	if strings.Contains(string(treeBytes2), "page.html") || !strings.Contains(string(treeBytes2), "note.md") {
		t.Fatalf("filtered /api/tree = %s, want only note.md", string(treeBytes2))
	}
}
