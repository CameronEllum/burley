package api

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"testing/fstest"

	"burley/internal/vault"
)

func TestIsNewerVersion(t *testing.T) {
	cases := []struct {
		latest  string
		current string
		want    bool
	}{
		{"v0.2.0", "0.1.0", true},
		{"0.1.1", "v0.1.0", true},
		{"v1.0.0", "0.9.9", true},
		{"v0.1.0", "0.1.0", false},
		{"v0.1.0", "0.1.1", false},
		{"v0.2.0-beta.1", "0.2.0", false},
		{"v0.2.0", "0.2.0-beta.1", true},
		{"not-a-version", "0.1.0", false},
		{"v0.1.1", "dev", false},
	}
	for _, tc := range cases {
		if got := isNewerVersion(tc.latest, tc.current); got != tc.want {
			t.Errorf("isNewerVersion(%q, %q) = %v, want %v", tc.latest, tc.current, got, tc.want)
		}
	}
}

func newReleaseHandler(t *testing.T, releaseAPI, version string) http.Handler {
	t.Helper()
	v, err := vault.NewLocalVault(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(v, fstest.MapFS{"index.html": {Data: []byte("<html></html>")}}, Options{
		Version:    version,
		RepoURL:    "https://github.com/example/burley",
		ReleaseAPI: releaseAPI,
		Logger:     log.New(io.Discard, "", 0),
	})
}

type releasePayload struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	URL             string `json:"url"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Repo            string `json:"repo"`
	Error           string `json:"error"`
}

func getRelease(t *testing.T, handler http.Handler, query string) releasePayload {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/release"+query, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var payload releasePayload
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload
}

func TestReleaseEndpoint(t *testing.T) {
	var calls atomic.Int32
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"tag_name": "v0.2.0",
			"name": "Burley 0.2.0",
			"html_url": "https://github.com/example/burley/releases/tag/v0.2.0",
			"published_at": "2026-12-01T12:00:00Z",
			"draft": false,
			"prerelease": false
		}`))
	}))
	defer github.Close()

	handler := newReleaseHandler(t, github.URL, "0.1.0")
	payload := getRelease(t, handler, "")
	if payload.Current != "0.1.0" || payload.Latest != "v0.2.0" || !payload.UpdateAvailable {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.Repo != "https://github.com/example/burley" {
		t.Fatalf("repo = %q", payload.Repo)
	}
	if payload.URL == "" {
		t.Fatal("release URL is empty")
	}

	// The second request is served from the cache.
	_ = getRelease(t, handler, "")
	if calls.Load() != 1 {
		t.Fatalf("GitHub calls = %d, want 1 (cached)", calls.Load())
	}
	// refresh=1 bypasses the cache.
	_ = getRelease(t, handler, "?refresh=1")
	if calls.Load() != 2 {
		t.Fatalf("GitHub calls = %d, want 2 after refresh", calls.Load())
	}
}

func TestReleaseEndpointErrorIsQuiet(t *testing.T) {
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", http.StatusForbidden)
	}))
	defer github.Close()

	handler := newReleaseHandler(t, github.URL, "0.1.0")
	payload := getRelease(t, handler, "")
	if payload.UpdateAvailable || payload.Error == "" {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.Current != "0.1.0" {
		t.Fatalf("current = %q", payload.Current)
	}
}
