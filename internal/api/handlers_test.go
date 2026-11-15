package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"burley/internal/vault"
)

type harness struct {
	srv  *httptest.Server
	v    *vault.LocalVault
	root string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	v, err := vault.NewLocalVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	v.DisableRipgrep = true

	static := fstest.MapFS{
		"index.html":    {Data: []byte("<html>burley</html>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
	h := New(v, static, Options{Root: dir, Logger: log.New(io.Discard, "", 0)})
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return &harness{srv: srv, v: v, root: dir}
}

func (h *harness) do(t *testing.T, method, url string, body any) (*http.Response, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, h.srv.URL+url, rdr)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := h.srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, data
}

func (h *harness) write(t *testing.T, rel, content string) {
	t.Helper()
	p := filepath.Join(h.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestHealth(t *testing.T) {
	h := newHarness(t)
	resp, data := h.do(t, "GET", "/api/health", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"status":"ok"`) {
		t.Fatalf("health = %d %s", resp.StatusCode, data)
	}
}

func TestTreeAndFileRoundTrip(t *testing.T) {
	h := newHarness(t)
	h.write(t, "welcome.md", "# Welcome\n")
	h.write(t, "notes/a.md", "A\n")
	h.write(t, "notes/assets/fig.png", "PNG")

	resp, data := h.do(t, "GET", "/api/tree", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("tree = %d %s", resp.StatusCode, data)
	}
	var tree struct {
		Tree  []vault.Entry `json:"tree"`
		Files []struct {
			Path string `json:"path"`
		} `json:"files"`
	}
	if err := json.Unmarshal(data, &tree); err != nil {
		t.Fatal(err)
	}
	if len(tree.Tree) != 2 || len(tree.Files) != 2 {
		t.Fatalf("tree=%+v files=%+v", tree.Tree, tree.Files)
	}

	resp, data = h.do(t, "GET", "/api/file?path=notes/a.md", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("file = %d %s", resp.StatusCode, data)
	}
	var fd vault.FileData
	if err := json.Unmarshal(data, &fd); err != nil {
		t.Fatal(err)
	}
	if fd.Content != "A\n" || fd.Hash == "" {
		t.Fatalf("file data = %+v", fd)
	}

	// Save with the correct hash succeeds.
	resp, data = h.do(t, "PUT", "/api/file", map[string]any{
		"path":         "notes/a.md",
		"content":      "A v2\r\n",
		"expectedHash": fd.Hash,
	})
	if resp.StatusCode != 200 {
		t.Fatalf("put = %d %s", resp.StatusCode, data)
	}
	var saved vault.FileData
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(filepath.Join(h.root, "notes", "a.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "A v2\r\n" {
		t.Fatalf("CRLF not preserved: %q", onDisk)
	}

	// Save with a stale hash returns 409 + server current content.
	resp, data = h.do(t, "PUT", "/api/file", map[string]any{
		"path":         "notes/a.md",
		"content":      "stale",
		"expectedHash": fd.Hash,
	})
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("conflict status = %d %s", resp.StatusCode, data)
	}
	var current vault.FileData
	if err := json.Unmarshal(data, &current); err != nil {
		t.Fatal(err)
	}
	if current.Content != "A v2\r\n" {
		t.Fatalf("conflict body = %+v", current)
	}
}

func TestAssetServing(t *testing.T) {
	h := newHarness(t)
	h.write(t, "img/pic.png", "PNGDATA")

	resp, data := h.do(t, "GET", "/api/asset?path=img/pic.png", nil)
	if resp.StatusCode != 200 || string(data) != "PNGDATA" {
		t.Fatalf("asset = %d %q", resp.StatusCode, data)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("missing nosniff header")
	}
}

func TestSearchEndpoint(t *testing.T) {
	h := newHarness(t)
	h.write(t, "a.md", "an Eigenvalue here\n")
	h.write(t, "sub/b.md", "another eigenvalue\n")

	resp, data := h.do(t, "GET", "/api/search?q=eigenvalue", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("search = %d %s", resp.StatusCode, data)
	}
	var matches []vault.SearchMatch
	if err := json.Unmarshal(data, &matches); err != nil {
		t.Fatal(err)
	}
	if len(matches) != 2 {
		t.Fatalf("matches = %+v", matches)
	}

	resp, data = h.do(t, "GET", "/api/search?q=", nil)
	if resp.StatusCode != 200 || strings.TrimSpace(string(data)) != "[]" {
		t.Fatalf("empty search = %d %s", resp.StatusCode, data)
	}
}

func TestTraversalRejected(t *testing.T) {
	h := newHarness(t)
	cases := []string{
		"/api/file?path=../../etc/passwd",
		"/api/asset?path=../secret.png",
		"/api/file?path=C:%5CWindows%5Cwin.ini",
	}
	for _, u := range cases {
		resp, data := h.do(t, "GET", u, nil)
		if resp.StatusCode != http.StatusForbidden && resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s = %d %s, want 400/403", u, resp.StatusCode, data)
		}
	}

	resp, data := h.do(t, "PUT", "/api/file", map[string]any{
		"path": "../escape.md", "content": "x", "expectedHash": "",
	})
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("traversal write = %d %s", resp.StatusCode, data)
	}
}

func TestStaticServingAndSPAFallback(t *testing.T) {
	h := newHarness(t)

	resp, data := h.do(t, "GET", "/", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), "burley") {
		t.Fatalf("index = %d %s", resp.StatusCode, data)
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("index cache-control = %q", cc)
	}

	resp, data = h.do(t, "GET", "/assets/app.js", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), "console.log") {
		t.Fatalf("asset js = %d %s", resp.StatusCode, data)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("js content-type = %q", ct)
	}

	resp, data = h.do(t, "GET", "/some/deep/route", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), "burley") {
		t.Fatalf("spa fallback = %d %s", resp.StatusCode, data)
	}

	resp, _ = h.do(t, "GET", "/api/nope", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown api = %d", resp.StatusCode)
	}
}

func TestDeleteEndpoint(t *testing.T) {
	h := newHarness(t)
	h.write(t, "welcome.md", "# Welcome\n")
	h.write(t, "notes/keep.txt", "text")

	resp, data := h.do(t, "DELETE", "/api/file?path=welcome.md", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"deleted":"welcome.md"`) {
		t.Fatalf("delete = %d %s", resp.StatusCode, data)
	}
	resp, _ = h.do(t, "GET", "/api/file?path=welcome.md", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("get deleted = %d, want 404", resp.StatusCode)
	}
	resp, data = h.do(t, "DELETE", "/api/file?path=welcome.md", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("delete missing = %d %s", resp.StatusCode, data)
	}
	resp, data = h.do(t, "DELETE", "/api/file?path=notes/keep.txt", nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("delete txt = %d %s", resp.StatusCode, data)
	}
	resp, data = h.do(t, "DELETE", "/api/file?path=../escape.md", nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("delete traversal = %d %s", resp.StatusCode, data)
	}
}

func TestPutBodyValidation(t *testing.T) {	h := newHarness(t)
	resp, data := h.do(t, "PUT", "/api/file", map[string]any{"content": "x"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing path = %d %s", resp.StatusCode, data)
	}
	resp, data = h.do(t, "PUT", "/api/file", "not an object")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad json = %d %s", resp.StatusCode, data)
	}
}

func TestHealthVersion(t *testing.T) {
	h := newHarness(t)
	resp, data := h.do(t, "GET", "/api/health", nil)
	if resp.StatusCode != 200 {
		t.Fatal(string(data))
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(m["version"]) == "" {
		t.Fatalf("no version: %v", m)
	}
}

func TestQuitEndpoint(t *testing.T) {
	dir := t.TempDir()
	v, err := vault.NewLocalVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	quit := make(chan struct{})
	handler := New(v, fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}, Options{
		Root:   dir,
		Logger: log.New(io.Discard, "", 0),
		OnQuit: func() { close(quit) },
	})

	// GET is rejected.
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/quit", nil))
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET quit = %d, want 405", rr.Code)
	}

	// Non-loopback callers are rejected.
	remoteReq := httptest.NewRequest(http.MethodPost, "/api/quit", nil)
	remoteReq.RemoteAddr = "203.0.113.9:4567"
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, remoteReq)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("remote quit = %d, want 403", rr.Code)
	}

	// A loopback POST answers and invokes the shutdown hook.
	req := httptest.NewRequest(http.MethodPost, "/api/quit", nil)
	req.RemoteAddr = "127.0.0.1:54321"
	rr = httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "shutting_down") {
		t.Fatalf("POST quit = %d %s", rr.Code, rr.Body.String())
	}
	select {
	case <-quit:
	case <-time.After(2 * time.Second):
		t.Fatal("OnQuit was not invoked within 2s")
	}
}

func TestQuitEndpointDisabled(t *testing.T) {
	h := newHarness(t)
	req := httptest.NewRequest(http.MethodPost, "/api/quit", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	rr := httptest.NewRecorder()
	h.srv.Config.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusNotImplemented {
		t.Fatalf("quit without handler = %d, want 501", rr.Code)
	}
}

func TestRecentAPI(t *testing.T) {
	h := newHarness(t)

	resp, data := h.do(t, "GET", "/api/recent", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"recent":[]`) {
		t.Fatalf("empty recent = %d %s", resp.StatusCode, data)
	}

	resp, data = h.do(t, "PUT", "/api/recent", map[string]any{
		"recent": []string{"welcome.md", "notes/todo.md", "welcome.md"},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("put recent = %d %s", resp.StatusCode, data)
	}
	var payload struct {
		Recent []string `json:"recent"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Recent) != 2 || payload.Recent[0] != "welcome.md" {
		t.Fatalf("recent = %v", payload.Recent)
	}

	raw, err := os.ReadFile(filepath.Join(h.root, ".burley", "recent.yaml"))
	if err != nil {
		t.Fatalf("recent.yaml: %v", err)
	}
	if !strings.Contains(string(raw), `- "welcome.md"`) {
		t.Fatalf("unexpected recent yaml:\n%s", raw)
	}

	resp, data = h.do(t, "PUT", "/api/recent", map[string]any{"recent": []string{"../escape.md"}})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("traversal recent = %d %s", resp.StatusCode, data)
	}
	resp, data = h.do(t, "PUT", "/api/recent", "not-json")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad recent json = %d %s", resp.StatusCode, data)
	}
}

func TestSettingsAPI(t *testing.T) {	h := newHarness(t)

	resp, data := h.do(t, "GET", "/api/settings", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"exists":false`) {
		t.Fatalf("default settings = %d %s", resp.StatusCode, data)
	}

	resp, data = h.do(t, "PUT", "/api/settings", map[string]any{"theme": "dark", "wideMode": true})
	if resp.StatusCode != 200 {
		t.Fatalf("put settings = %d %s", resp.StatusCode, data)
	}
	var payload struct {
		Settings vault.Settings `json:"settings"`
		Exists   bool           `json:"exists"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Exists || payload.Settings.Theme != "dark" || !payload.Settings.WideMode {
		t.Fatalf("saved settings = %+v exists=%v", payload.Settings, payload.Exists)
	}

	resp, data = h.do(t, "GET", "/api/settings", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("get settings = %d %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Settings.Theme != "dark" || !payload.Settings.WideMode {
		t.Fatalf("round-trip settings = %+v", payload.Settings)
	}

	raw, err := os.ReadFile(filepath.Join(h.root, ".burley", "settings.yaml"))
	if err != nil {
		t.Fatalf("settings.yaml: %v", err)
	}
	if !strings.Contains(string(raw), "wide_mode: true") {
		t.Fatalf("unexpected settings yaml:\n%s", raw)
	}

	resp, data = h.do(t, "PUT", "/api/settings", map[string]any{"theme": "neon"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid theme = %d %s", resp.StatusCode, data)
	}

	resp, data = h.do(t, "PUT", "/api/settings", "not-json")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad settings json = %d %s", resp.StatusCode, data)
	}
}

func TestFavoritesAPI(t *testing.T) {	h := newHarness(t)

	resp, data := h.do(t, "GET", "/api/favorites", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"favorites":[]`) {
		t.Fatalf("empty favorites = %d %s", resp.StatusCode, data)
	}

	resp, data = h.do(t, "PUT", "/api/favorites", map[string]any{
		"favorites": []string{"welcome.md", "notes/todo.md", "welcome.md"},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("put favorites = %d %s", resp.StatusCode, data)
	}
	var saved struct {
		Favorites []string `json:"favorites"`
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Favorites) != 2 || saved.Favorites[0] != "welcome.md" || saved.Favorites[1] != "notes/todo.md" {
		t.Fatalf("saved favorites = %v", saved.Favorites)
	}

	resp, data = h.do(t, "GET", "/api/favorites", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("get favorites = %d %s", resp.StatusCode, data)
	}
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Favorites) != 2 {
		t.Fatalf("round-trip favorites = %v", saved.Favorites)
	}

	// The YAML file is created under .burley/.
	raw, err := os.ReadFile(filepath.Join(h.root, ".burley", "favorites.yaml"))
	if err != nil {
		t.Fatalf("read favorites.yaml: %v", err)
	}
	if !strings.Contains(string(raw), `- "welcome.md"`) {
		t.Fatalf("unexpected yaml:\n%s", raw)
	}

	// Traversal and hidden paths are rejected.
	resp, data = h.do(t, "PUT", "/api/favorites", map[string]any{"favorites": []string{"../escape.md"}})
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("traversal favorites = %d %s", resp.StatusCode, data)
	}
	resp, data = h.do(t, "PUT", "/api/favorites", map[string]any{"favorites": []string{".burley/hidden.md"}})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("hidden favorites = %d %s", resp.StatusCode, data)
	}

	// Bad JSON is a 400.
	resp, data = h.do(t, "PUT", "/api/favorites", "not-json")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad favorites json = %d %s", resp.StatusCode, data)
	}

	// .burley never appears in the tree.
	h.write(t, "welcome.md", "# Welcome\n")
	resp, data = h.do(t, "GET", "/api/tree", nil)
	if resp.StatusCode != 200 || strings.Contains(string(data), ".burley") {
		t.Fatalf("tree leaked .burley = %d %s", resp.StatusCode, data)
	}
}
