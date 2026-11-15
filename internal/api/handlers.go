// Package api implements Burley's HTTP interface: a small JSON REST API for the
// vault plus embedded serving of the compiled frontend.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"burley/internal/vault"
)

const maxRequestBody = 64 << 20 // 64 MiB (Markdown files are capped in the vault)

// Options configures the HTTP handler.
type Options struct {
	// RipgrepAvailable is only used by the health endpoint for diagnostics.
	RipgrepAvailable bool
	// Root is the vault root, surfaced by /api/health.
	Root string
	// Logger defaults to the standard logger.
	Logger *log.Logger
	// OnQuit is invoked (after a short delay) when POST /api/quit is called.
	// It is wired to the same graceful-shutdown path as SIGINT.
	OnQuit func()
}

// New returns the root HTTP handler serving both the API and the embedded
// frontend. staticFS should contain index.html at its root.
func New(v vault.Vault, staticFS fs.FS, opts Options) http.Handler {
	s := &server{vault: v, static: staticFS, opts: opts}
	if s.opts.Logger == nil {
		s.opts.Logger = log.Default()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/tree", s.handleTree)
	mux.HandleFunc("GET /api/file", s.handleGetFile)
	mux.HandleFunc("PUT /api/file", s.handlePutFile)
	mux.HandleFunc("GET /api/asset", s.handleAsset)
	mux.HandleFunc("GET /api/search", s.handleSearch)
	mux.HandleFunc("GET /api/favorites", s.handleGetFavorites)
	mux.HandleFunc("PUT /api/favorites", s.handlePutFavorites)
	mux.HandleFunc("/api/quit", s.handleQuit)
	mux.HandleFunc("/", s.handleStatic)

	return withCommonHeaders(s.logRequests(mux))
}

type server struct {
	vault  vault.Vault
	static fs.FS
	opts   Options
}

// ---------------------------------------------------------------- middleware

func withCommonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		} else {
			h.Set("Content-Security-Policy",
				"default-src 'self'; "+
					"script-src 'self' 'unsafe-eval'; "+
					"style-src 'self' 'unsafe-inline'; "+
					"img-src 'self' data: blob:; "+
					"font-src 'self' data:; "+
					"connect-src 'self'; "+
					"object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
		}
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (s *server) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		s.opts.Logger.Printf("%s %s -> %d (%s)", r.Method, r.URL.RequestURI(), rec.status, time.Since(start).Round(time.Millisecond))
	})
}

// --------------------------------------------------------------------- utils

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("write json: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// vaultError maps vault errors to HTTP status codes.
func vaultError(w http.ResponseWriter, err error) {
	var conflict *vault.ConflictError
	switch {
	case errors.As(err, &conflict):
		writeJSON(w, http.StatusConflict, conflict.Current)
	case errors.Is(err, vault.ErrForbidden):
		writeError(w, http.StatusForbidden, "path is outside the vault root")
	case errors.Is(err, vault.ErrInvalidPath):
		writeError(w, http.StatusBadRequest, "invalid path")
	case errors.Is(err, vault.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, vault.ErrTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "file is too large")
	default:
		log.Printf("vault error: %v", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// ---------------------------------------------------------------- API routes

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"root":    s.opts.Root,
		"ripgrep": s.opts.RipgrepAvailable,
		"version": "0.1.0",
	})
}

func (s *server) handleTree(w http.ResponseWriter, r *http.Request) {
	tree, err := s.vault.Tree(r.Context())
	if err != nil {
		vaultError(w, err)
		return
	}
	type flatEntry struct {
		Path    string `json:"path"`
		Name    string `json:"name"`
		ModTime int64  `json:"modTime"`
		Size    int64  `json:"size"`
	}
	files := []flatEntry{}
	var flatten func(entries []vault.Entry)
	flatten = func(entries []vault.Entry) {
		for _, e := range entries {
			if e.IsDir {
				flatten(e.Children)
				continue
			}
			files = append(files, flatEntry{Path: e.Path, Name: e.Name, ModTime: e.ModTime, Size: e.Size})
		}
	}
	flatten(tree)
	writeJSON(w, http.StatusOK, map[string]any{
		"tree":  tree,
		"files": files,
		"root":  s.opts.Root,
	})
}

func (s *server) handleGetFile(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	data, err := s.vault.Read(r.Context(), p)
	if err != nil {
		vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *server) handlePutFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	var req struct {
		Path         string  `json:"path"`
		Content      string  `json:"content"`
		ExpectedHash *string `json:"expectedHash"`
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if req.Path == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	expected := ""
	if req.ExpectedHash != nil {
		expected = *req.ExpectedHash
	}
	data, err := s.vault.Write(r.Context(), req.Path, []byte(req.Content), expected)
	if err != nil {
		vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *server) handleAsset(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	b, mimeType, err := s.vault.ReadAsset(r.Context(), p)
	if err != nil {
		vaultError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", mimeType)
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Length", strconv.Itoa(len(b)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(b)
	}
}

func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {	q := r.URL.Query().Get("q")
	if strings.TrimSpace(q) == "" {
		writeJSON(w, http.StatusOK, []vault.SearchMatch{})
		return
	}
	max := 100
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 500 {
			max = n
		}
	}
	matches, err := s.vault.SearchContent(r.Context(), q, max)
	if err != nil {
		vaultError(w, err)
		return
	}
	if matches == nil {
		matches = []vault.SearchMatch{}
	}
	writeJSON(w, http.StatusOK, matches)
}

// -------------------------------------------------------------- favorites

func (s *server) handleGetFavorites(w http.ResponseWriter, r *http.Request) {
	favorites, err := s.vault.ReadFavorites(r.Context())
	if err != nil {
		vaultError(w, err)
		return
	}
	if favorites == nil {
		favorites = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"favorites": favorites})
}

func (s *server) handlePutFavorites(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req struct {
		Favorites []string `json:"favorites"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if req.Favorites == nil {
		req.Favorites = []string{}
	}
	if err := s.vault.WriteFavorites(r.Context(), req.Favorites); err != nil {
		vaultError(w, err)
		return
	}
	// Return the canonical, de-duplicated list.
	favorites, err := s.vault.ReadFavorites(r.Context())
	if err != nil {
		vaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"favorites": favorites})
}

// ------------------------------------------------------------- file lifecycle
// remoteIP extracts the client IP from a request's RemoteAddr.
func remoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

// handleQuit stops the server. It is restricted to loopback clients so that a
// server deliberately bound to a LAN address cannot be killed remotely.
func (s *server) handleQuit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if ip := remoteIP(r); ip == nil || !ip.IsLoopback() {
		writeError(w, http.StatusForbidden, "quit is only allowed from the local machine")
		return
	}
	if s.opts.OnQuit == nil {
		writeError(w, http.StatusNotImplemented, "quit is not enabled")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "shutting_down"})
	onQuit := s.opts.OnQuit
	go func() {
		// Give the response time to reach the browser before the listener closes.
		time.Sleep(250 * time.Millisecond)
		onQuit()
	}()
}

// ------------------------------------------------------------- static assets

func (s *server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, "unknown API endpoint")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	upath := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if upath == "" {
		upath = "index.html"
	}

	if data, ok := s.readStatic(upath); ok {
		s.serveStatic(w, r, upath, data)
		return
	}
	// SPA fallback: unknown paths render the app shell.
	if data, ok := s.readStatic("index.html"); ok {
		s.serveStatic(w, r, "index.html", data)
		return
	}
	http.NotFound(w, r)
}

func (s *server) readStatic(name string) ([]byte, bool) {
	if s.static == nil {
		return nil, false
	}
	f, err := s.static.Open(name)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return nil, false
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, false
	}
	return data, true
}

func (s *server) serveStatic(w http.ResponseWriter, r *http.Request, name string, data []byte) {
	ext := strings.ToLower(path.Ext(name))
	ct := mime.TypeByExtension(ext)
	switch ext {
	case ".js", ".mjs":
		ct = "text/javascript; charset=utf-8"
	case ".css":
		ct = "text/css; charset=utf-8"
	case ".html":
		ct = "text/html; charset=utf-8"
	case ".svg":
		ct = "image/svg+xml"
	case ".woff2":
		ct = "font/woff2"
	case ".woff":
		ct = "font/woff"
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	if name == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
