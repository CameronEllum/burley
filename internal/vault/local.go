package vault

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	maxFileBytes  = 32 << 20  // 32 MiB for Markdown reads/writes
	maxAssetBytes = 128 << 20 // 128 MiB for assets
	maxScanBytes  = 4 << 20   // per-file limit for the pure-Go search fallback
)

// LocalVault is a Vault backed by a directory on the local filesystem.
type LocalVault struct {
	root string

	// DisableRipgrep forces the pure-Go content search implementation. Useful
	// for tests and for hosts without ripgrep installed.
	DisableRipgrep bool

	// RipgrepPath overrides ripgrep discovery. Empty means look up "rg".
	RipgrepPath string

	rgPath    string
	rgChecked bool
}

// NewLocalVault opens a vault rooted at root.
func NewLocalVault(root string) (*LocalVault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("vault root %q: %w", root, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("vault root %q is not a directory", root)
	}
	return &LocalVault{root: abs}, nil
}

// Root returns the absolute vault root.
func (v *LocalVault) Root() string { return v.root }

// resolve turns a client supplied relative path into an absolute path that is
// guaranteed to live inside the vault root. Symlinks are evaluated and must
// also resolve inside the root.
func (v *LocalVault) resolve(rel string) (string, string, error) {
	clean, err := NormalizeRel(rel)
	if err != nil {
		return "", "", err
	}
	abs := filepath.Join(v.root, filepath.FromSlash(clean))

	// Defense in depth: filepath.Join already cleans, but verify containment
	// with filepath.Rel so platform-specific quirks cannot slip through.
	inside, err := isInside(v.root, abs)
	if err != nil || !inside {
		return "", "", ErrForbidden
	}

	// If the path (or its closest existing parent) is a symlink, ensure the
	// resolved target is still inside the root.
	if err := checkSymlinks(v.root, abs); err != nil {
		return "", "", err
	}
	return abs, clean, nil
}

func isInside(rootAbs, targetAbs string) (bool, error) {
	rel, err := filepath.Rel(rootAbs, targetAbs)
	if err != nil {
		return false, err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false, nil
	}
	return true, nil
}

func checkSymlinks(rootAbs, targetAbs string) error {
	// Walk up to the closest existing ancestor, since writes may target files
	// that do not exist yet.
	cur := targetAbs
	for {
		if _, err := os.Lstat(cur); err == nil {
			break
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return ErrForbidden
		}
		cur = parent
	}
	eval, err := filepath.EvalSymlinks(cur)
	if err != nil {
		return ErrForbidden
	}
	inside, err := isInside(rootAbs, eval)
	if err != nil || !inside {
		return ErrForbidden
	}
	return nil
}

func notFoundIfNeeded(err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	return err
}

func (v *LocalVault) enabledFileTypes(ctx context.Context) []string {
	settings, _, err := v.ReadSettings(ctx)
	if err != nil {
		return defaultFileTypes()
	}
	return normalizeFileTypes(settings.FileTypes)
}

// Tree returns the recursive directory tree of enabled files. Directories that
// contain no matching files (recursively) are omitted, as are hidden folders.
func (v *LocalVault) Tree(ctx context.Context) ([]Entry, error) {
	types := v.enabledFileTypes(ctx)
	entries, _, err := v.walk(ctx, v.root, "", types)
	if err != nil {
		return nil, err
	}
	if entries == nil {
		entries = []Entry{}
	}
	return entries, nil
}

// ScanTree walks every visible folder and calls visit for each enabled file.
// The HTTP layer uses this to publish a progressively populated tree for large
// vaults; directories are derived from the file paths.
func (v *LocalVault) ScanTree(ctx context.Context, visit func(Entry) error) error {
	return v.scanDir(ctx, v.root, "", v.enabledFileTypes(ctx), visit)
}

// ScanFolder walks a single vault-relative subfolder and calls visit for each
// enabled file inside it.
func (v *LocalVault) ScanFolder(ctx context.Context, relDir string, visit func(Entry) error) error {
	if strings.TrimSpace(relDir) == "" {
		return v.ScanTree(ctx, visit)
	}
	abs, clean, err := v.resolve(relDir)
	if err != nil {
		return err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return notFoundIfNeeded(err)
	}
	if !info.IsDir() {
		return ErrInvalidPath
	}
	return v.scanDir(ctx, abs, clean, v.enabledFileTypes(ctx), visit)
}

func (v *LocalVault) scanDir(ctx context.Context, dirAbs, relDir string, types []string, visit func(Entry) error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dirents, err := os.ReadDir(dirAbs)
	if err != nil {
		return notFoundIfNeeded(err)
	}

	for _, de := range dirents {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		rel := name
		if relDir != "" {
			rel = relDir + "/" + name
		}
		if de.IsDir() {
			if name == "node_modules" || name == "vendor" {
				continue
			}
			if err := v.scanDir(ctx, filepath.Join(dirAbs, name), rel, types, visit); err != nil {
				return err
			}
			continue
		}
		if !IsEnabledFile(name, types) {
			continue
		}
		info, err := de.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if err := visit(Entry{
			Name:    name,
			Path:    rel,
			IsDir:   false,
			ModTime: info.ModTime().UnixMilli(),
			Size:    info.Size(),
		}); err != nil {
			return err
		}
	}
	return nil
}

func (v *LocalVault) walk(ctx context.Context, dirAbs, relDir string, types []string) ([]Entry, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	dirents, err := os.ReadDir(dirAbs)
	if err != nil {
		return nil, false, notFoundIfNeeded(err)
	}

	var dirs []Entry
	var files []Entry
	hasMarkdown := false

	for _, de := range dirents {
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		rel := name
		if relDir != "" {
			rel = relDir + "/" + name
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		if de.IsDir() {
			if name == "node_modules" || name == "vendor" {
				continue
			}
			children, childMD, err := v.walk(ctx, filepath.Join(dirAbs, name), rel, types)
			if err != nil {
				return nil, false, err
			}
			if childMD {
				hasMarkdown = true
				dirs = append(dirs, Entry{
					Name:     name,
					Path:     rel,
					IsDir:    true,
					ModTime:  info.ModTime().UnixMilli(),
					Children: children,
				})
			}
			continue
		}
		if !info.Mode().IsRegular() || !IsEnabledFile(name, types) {
			continue
		}
		hasMarkdown = true
		files = append(files, Entry{
			Name:    name,
			Path:    rel,
			IsDir:   false,
			ModTime: info.ModTime().UnixMilli(),
			Size:    info.Size(),
		})
	}

	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name) })
	sort.Slice(files, func(i, j int) bool { return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name) })

	return append(dirs, files...), hasMarkdown, nil
}

// Read returns a Markdown file's content and metadata.
func (v *LocalVault) Read(ctx context.Context, relPath string) (FileData, error) {
	abs, clean, err := v.resolve(relPath)
	if err != nil {
		return FileData{}, err
	}
	if !IsSupportedPath(clean) {
		return FileData{}, ErrInvalidPath
	}
	info, err := os.Stat(abs)
	if err != nil {
		return FileData{}, notFoundIfNeeded(err)
	}
	if info.IsDir() {
		return FileData{}, ErrInvalidPath
	}
	if info.Size() > maxFileBytes {
		return FileData{}, ErrTooLarge
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return FileData{}, notFoundIfNeeded(err)
	}
	return FileData{
		Path:    clean,
		Content: string(b),
		ModTime: info.ModTime().UnixMilli(),
		Hash:    HashBytes(b),
	}, nil
}

// Write atomically replaces a Markdown file after checking expectedHash. An
// empty expectedHash means "create or overwrite".
func (v *LocalVault) Write(ctx context.Context, relPath string, content []byte, expectedHash string) (FileData, error) {
	if len(content) > maxFileBytes {
		return FileData{}, ErrTooLarge
	}
	abs, clean, err := v.resolve(relPath)
	if err != nil {
		return FileData{}, err
	}
	if !IsSupportedPath(clean) {
		return FileData{}, ErrInvalidPath
	}
	if err := ctx.Err(); err != nil {
		return FileData{}, err
	}

	// Snapshot the current state for conflict detection.
	current := FileData{Path: clean}
	var currentBytes []byte
	info, statErr := os.Stat(abs)
	switch {
	case statErr == nil:
		if info.IsDir() {
			return FileData{}, ErrInvalidPath
		}
		currentBytes, err = os.ReadFile(abs)
		if err != nil {
			return FileData{}, notFoundIfNeeded(err)
		}
		current = FileData{
			Path:    clean,
			Content: string(currentBytes),
			ModTime: info.ModTime().UnixMilli(),
			Hash:    HashBytes(currentBytes),
		}
	case errors.Is(statErr, fs.ErrNotExist):
		// New file: current hash stays empty.
	default:
		return FileData{}, statErr
	}

	if expectedHash != "" && expectedHash != current.Hash {
		return FileData{}, &ConflictError{Current: current}
	}

	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return FileData{}, err
	}

	perm := fs.FileMode(0o644)
	if statErr == nil {
		perm = info.Mode().Perm()
	}

	if err := writeFileAtomic(abs, content, perm); err != nil {
		return FileData{}, err
	}

	newInfo, err := os.Stat(abs)
	if err != nil {
		return FileData{}, err
	}
	return FileData{
		Path:    clean,
		Content: string(content),
		ModTime: newInfo.ModTime().UnixMilli(),
		Hash:    HashBytes(content),
	}, nil
}

// writeFileAtomic writes data to a hidden temp file in the target directory,
// syncs it, then renames it over abs. The temp file never leaves its directory,
// so the rename is atomic on the same filesystem.
func writeFileAtomic(abs string, data []byte, perm fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".burley-tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	cleanup := func() {
		tmp.Close()
		os.Remove(name)
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Chmod(name, perm); err != nil {
		os.Remove(name)
		return err
	}
	if err := renameWithRetry(name, abs); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// renameWithRetry retries a rename on Windows, where a virus scanner or a
// concurrent reader can briefly hold the destination and fail it with
// "Access is denied" (EPERM).
func renameWithRetry(from, to string) error {
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		if !isRetryableRename(err) {
			return err
		}
		time.Sleep(time.Duration(attempt+1) * 15 * time.Millisecond)
	}
	return err
}

func isRetryableRename(err error) bool {
	if errors.Is(err, fs.ErrPermission) {
		return true
	}
	// Windows sharing violations: ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION
	// (32) and ERROR_LOCK_VIOLATION (33).
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch uintptr(errno) {
		case 5, 32, 33:
			return true
		}
	}
	return false
}

func hasHiddenSegment(clean string) bool {
	for _, seg := range strings.Split(clean, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// Rename moves or renames a Markdown file or directory within the vault.
func (v *LocalVault) Rename(ctx context.Context, fromPath, toPath string) error {
	fromAbs, fromClean, err := v.resolve(fromPath)
	if err != nil {
		return err
	}
	toAbs, toClean, err := v.resolve(toPath)
	if err != nil {
		return err
	}
	if hasHiddenSegment(fromClean) || hasHiddenSegment(toClean) {
		return ErrInvalidPath
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	fromInfo, err := os.Stat(fromAbs)
	if err != nil {
		return notFoundIfNeeded(err)
	}
	if fromInfo.IsDir() {
		if toClean == fromClean || strings.HasPrefix(toClean, fromClean+"/") {
			return ErrInvalidPath
		}
	} else {
		if !IsSupportedPath(fromClean) || !IsSupportedPath(toClean) {
			return ErrInvalidPath
		}
	}
	if fromClean == toClean {
		return nil
	}
	if _, err := os.Stat(toAbs); err == nil {
		return ErrExists
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(toAbs), 0o755); err != nil {
		return err
	}
	return renameWithRetry(fromAbs, toAbs)
}

// Delete permanently removes a Markdown file or directory from the vault.
func (v *LocalVault) Delete(ctx context.Context, relPath string) error {
	abs, clean, err := v.resolve(relPath)
	if err != nil {
		return err
	}
	if hasHiddenSegment(clean) {
		return ErrInvalidPath
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return notFoundIfNeeded(err)
	}
	if info.IsDir() {
		return os.RemoveAll(abs)
	}
	if !IsSupportedPath(clean) {
		return ErrInvalidPath
	}
	return os.Remove(abs)
}

var assetTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".ico":  "image/x-icon",
	".svg":  "image/svg+xml",
	".json": "application/json",
	".csv":  "text/csv",
	".tsv":  "text/tab-separated-values",
	".txt":  "text/plain; charset=utf-8",
	".yaml": "text/yaml; charset=utf-8",
	".yml":  "text/yaml; charset=utf-8",
	".pdf":  "application/pdf",
	".mp4":  "video/mp4",
	".webm": "video/webm",
}

var rawTypes = map[string]string{
	".html":     "text/html; charset=utf-8",
	".htm":      "text/html; charset=utf-8",
	".css":      "text/css; charset=utf-8",
	".js":       "application/javascript; charset=utf-8",
	".mjs":      "application/javascript; charset=utf-8",
	".wasm":     "application/wasm",
	".woff":     "font/woff",
	".woff2":    "font/woff2",
	".ttf":      "font/ttf",
	".otf":      "font/otf",
	".xml":      "application/xml; charset=utf-8",
	".map":      "application/json",
	".md":       "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".mdown":    "text/markdown; charset=utf-8",
	".mkd":      "text/markdown; charset=utf-8",
}

// ReadRaw returns raw bytes plus a MIME type for serving HTML files and their
// relative scripts, stylesheets, fonts, and assets inside an iframe.
func (v *LocalVault) ReadRaw(ctx context.Context, relPath string) ([]byte, string, error) {
	abs, clean, err := v.resolve(relPath)
	if err != nil {
		return nil, "", err
	}
	for _, seg := range strings.Split(clean, "/") {
		if strings.HasPrefix(seg, ".") {
			return nil, "", ErrInvalidPath
		}
	}
	ext := strings.ToLower(path.Ext(clean))
	mimeType, ok := rawTypes[ext]
	if !ok {
		mimeType, ok = assetTypes[ext]
	}
	if !ok {
		mimeType = "application/octet-stream"
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, "", notFoundIfNeeded(err)
	}
	if info.IsDir() {
		return nil, "", ErrInvalidPath
	}
	if info.Size() > maxAssetBytes {
		return nil, "", ErrTooLarge
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, "", notFoundIfNeeded(err)
	}
	return b, mimeType, nil
}

// ReadAsset returns raw bytes plus a MIME type for a non-Markdown asset.
func (v *LocalVault) ReadAsset(ctx context.Context, relPath string) ([]byte, string, error) {
	abs, clean, err := v.resolve(relPath)
	if err != nil {
		return nil, "", err
	}
	ext := strings.ToLower(path.Ext(clean))
	mimeType, ok := assetTypes[ext]
	if !ok {
		return nil, "", ErrInvalidPath
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, "", notFoundIfNeeded(err)
	}
	if info.IsDir() {
		return nil, "", ErrInvalidPath
	}
	if info.Size() > maxAssetBytes {
		return nil, "", ErrTooLarge
	}
	b, err := os.ReadFile(abs)
	if err != nil {
		return nil, "", notFoundIfNeeded(err)
	}
	return b, mimeType, nil
}

// SearchContent searches Markdown files for query. It uses ripgrep when
// available and falls back to a pure-Go scan otherwise.
func (v *LocalVault) SearchContent(ctx context.Context, query string, max int) ([]SearchMatch, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []SearchMatch{}, nil
	}
	if max <= 0 {
		max = 100
	}
	if !v.DisableRipgrep {
		if rg, ok := v.ripgrep(); ok {
			matches, err := v.searchRipgrep(ctx, rg, query, max)
			if err == nil {
				return matches, nil
			}
			// Fall through to the Go implementation on rg failures (e.g.
			// binary missing after lookup, unsupported flags).
		}
	}
	return v.searchGo(ctx, query, max)
}

func (v *LocalVault) ripgrep() (string, bool) {
	if v.rgChecked {
		return v.rgPath, v.rgPath != ""
	}
	v.rgChecked = true
	if v.RipgrepPath != "" {
		if p, err := exec.LookPath(v.RipgrepPath); err == nil {
			v.rgPath = p
			return p, true
		}
		return "", false
	}
	if p, err := exec.LookPath("rg"); err == nil {
		v.rgPath = p
		return p, true
	}
	return "", false
}

type rgMessage struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
		Submatches []struct {
			Start int `json:"start"`
			End   int `json:"end"`
		} `json:"submatches"`
	} `json:"data"`
}

// rgNoMatches reports ripgrep's "no matches found" exit status (1). It must not
// be treated as a failure, otherwise every miss would trigger a full Go scan.
func rgNoMatches(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 1
}

func (v *LocalVault) searchRipgrep(ctx context.Context, rg, query string, max int) ([]SearchMatch, error) {
	types := v.enabledFileTypes(ctx)
	if len(types) == 0 {
		return []SearchMatch{}, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	args := []string{
		"--json",
		"--max-count", "50",
		"--smart-case",
		"--no-messages",
	}
	for _, ft := range types {
		switch ft {
		case "markdown":
			args = append(args, "--glob", "*.md", "--glob", "*.markdown", "--glob", "*.mdown", "--glob", "*.mkd")
		case "html":
			args = append(args, "--glob", "*.html", "--glob", "*.htm")
		}
	}
	args = append(args,
		"--glob", "!.*",
		"--",
		query,
		v.root,
	)
	cmd := exec.CommandContext(ctx, rg, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ripgrep pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ripgrep start: %w", err)
	}

	matches := make([]SearchMatch, 0, max)
	limitReached := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8<<20)
	for scanner.Scan() {
		var msg rgMessage
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			continue
		}
		if msg.Type != "match" {
			continue
		}
		abs := msg.Data.Path.Text
		rel, relErr := filepath.Rel(v.root, abs)
		if relErr != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		line := strings.TrimRight(msg.Data.Lines.Text, "\r\n")
		col := 1
		if len(msg.Data.Submatches) > 0 {
			col = msg.Data.Submatches[0].Start + 1
		}
		matches = append(matches, SearchMatch{
			Path:    filepath.ToSlash(rel),
			Line:    msg.Data.LineNumber,
			Column:  col,
			Text:    truncate(line, 400),
			Snippet: truncate(strings.TrimSpace(line), 240),
		})
		if len(matches) >= max {
			// Stop ripgrep immediately instead of draining the rest of its output.
			limitReached = true
			cancel()
			break
		}
	}

	scanErr := scanner.Err()
	if limitReached {
		// The context cancellation kills ripgrep; drain the pipe so Wait can
		// reap the process without blocking on unread buffered output.
		cancel()
		_, _ = io.Copy(io.Discard, stdout)
	}
	waitErr := cmd.Wait()

	if limitReached {
		// The process was killed deliberately after collecting enough matches.
		_ = scanErr
		return matches, nil
	}
	if waitErr != nil {
		switch {
		case rgNoMatches(waitErr):
			// Exit code 1 means "no matches"; this is a successful empty result.
			return []SearchMatch{}, nil
		case len(matches) > 0:
			// Keep whatever was collected before a timeout/partial failure.
			return matches, nil
		default:
			return nil, fmt.Errorf("ripgrep: %w: %s", waitErr, strings.TrimSpace(stderr.String()))
		}
	}
	if scanErr != nil {
		if len(matches) > 0 {
			return matches, nil
		}
		return nil, fmt.Errorf("ripgrep output: %w", scanErr)
	}
	if len(matches) == 0 {
		return []SearchMatch{}, nil
	}
	return matches, nil
}

func (v *LocalVault) searchGo(ctx context.Context, query string, max int) ([]SearchMatch, error) {
	types := v.enabledFileTypes(ctx)
	if len(types) == 0 {
		return []SearchMatch{}, nil
	}
	matches := make([]SearchMatch, 0, max)
	needle := strings.ToLower(query)

	err := filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		name := d.Name()
		if d.IsDir() {
			if p != v.root && strings.HasPrefix(name, ".") {
				return filepath.SkipDir
			}
			if name == "node_modules" || name == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() || !IsEnabledFile(name, types) {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil || info.Size() > maxScanBytes {
			return nil
		}
		data, readErr := os.ReadFile(p)
		if readErr != nil {
			return nil
		}
		rel, relErr := filepath.Rel(v.root, p)
		if relErr != nil {
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		lines := strings.Split(string(data), "\n")
		for i, line := range lines {
			idx := strings.Index(strings.ToLower(line), needle)
			if idx < 0 {
				continue
			}
			line = strings.TrimRight(line, "\r")
			matches = append(matches, SearchMatch{
				Path:    relSlash,
				Line:    i + 1,
				Column:  idx + 1,
				Text:    truncate(line, 400),
				Snippet: truncate(strings.TrimSpace(line), 240),
			})
			if len(matches) >= max {
				return errLimitReached
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errLimitReached) {
		return nil, err
	}
	return matches, nil
}

var errLimitReached = errors.New("search limit reached")

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// Keep it valid UTF-8-ish by trimming at a rune boundary.
	cut := n
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + "…"
}
