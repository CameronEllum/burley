package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"burley/internal/vault"
)

const (
	defaultMaxWatchedDirs = 512
	defaultWatchDebounce  = 180 * time.Millisecond
)

type shallowVault interface {
	Root() string
	ScanDirShallow(context.Context, string) ([]vault.Entry, []string, error)
	ScanFolder(context.Context, string, func(vault.Entry) error) error
}

// treeWatcher maintains a bounded, lazy set of fsnotify directory watches
// (root + active/expanded folders) so external file changes update the tree
// without exhausting Linux inotify limits on EC2 or walking the whole vault.
type treeWatcher struct {
	mu       sync.Mutex
	w        *fsnotify.Watcher
	root     string
	maxDirs  int
	debounce time.Duration
	watched  map[string]string // relDir -> absDir
	byAbs    map[string]string // absDir -> relDir
	timers   map[string]*time.Timer
	capped   bool
	closed   bool
	doneCh   chan struct{}
}

func (s *server) initTreeWatcher() {
	sv, ok := s.vault.(shallowVault)
	if !ok || strings.TrimSpace(sv.Root()) == "" {
		return
	}
	w, err := fsnotify.NewWatcher()
	if err != nil {
		if s.opts.Logger != nil {
			s.opts.Logger.Printf("burley tree watcher disabled: %v", err)
		}
		return
	}
	tw := &treeWatcher{
		w:        w,
		root:     filepath.Clean(sv.Root()),
		maxDirs:  defaultMaxWatchedDirs,
		debounce: defaultWatchDebounce,
		watched:  make(map[string]string),
		byAbs:    make(map[string]string),
		timers:   make(map[string]*time.Timer),
		doneCh:   make(chan struct{}),
	}
	s.watcher = tw
	tw.setDirs(nil)
	go tw.run(s)
}

func (s *server) closeTreeWatcher() {
	if s.watcher != nil {
		s.watcher.close()
	}
}

func (tw *treeWatcher) close() {
	tw.mu.Lock()
	if tw.closed {
		tw.mu.Unlock()
		return
	}
	tw.closed = true
	for _, t := range tw.timers {
		t.Stop()
	}
	tw.timers = nil
	w := tw.w
	tw.mu.Unlock()
	if w != nil {
		_ = w.Close()
	}
	<-tw.doneCh
}

func (tw *treeWatcher) setDirs(dirs []string) (int, bool) {
	desired := map[string]struct{}{"": {}}
	for _, raw := range dirs {
		clean, err := vault.NormalizeRel(raw)
		if err != nil || clean == "" || isIgnoredWatchRel(clean) {
			continue
		}
		desired[clean] = struct{}{}
	}

	tw.mu.Lock()
	defer tw.mu.Unlock()
	if tw.closed || tw.w == nil {
		return 0, tw.capped
	}

	// Remove watches for folders no longer expanded/active.
	for rel, abs := range tw.watched {
		if _, keep := desired[rel]; keep {
			continue
		}
		_ = tw.w.Remove(abs)
		delete(tw.watched, rel)
		delete(tw.byAbs, abs)
	}

	// Add watches for desired folders up to the hard cap.
	for rel := range desired {
		if _, exists := tw.watched[rel]; exists {
			continue
		}
		if len(tw.watched) >= tw.maxDirs {
			tw.capped = true
			break
		}
		abs := tw.root
		if rel != "" {
			abs = filepath.Join(tw.root, filepath.FromSlash(rel))
		}
		abs = filepath.Clean(abs)
		if err := tw.w.Add(abs); err != nil {
			if !os.IsNotExist(err) {
				tw.capped = true
				break
			}
			continue
		}
		tw.watched[rel] = abs
		tw.byAbs[abs] = rel
	}

	return len(tw.watched), tw.capped
}

func (tw *treeWatcher) run(s *server) {
	defer close(tw.doneCh)
	for {
		select {
		case event, ok := <-tw.w.Events:
			if !ok {
				return
			}
			tw.handleEvent(s, event)
		case _, ok := <-tw.w.Errors:
			if !ok {
				return
			}
		}
	}
}

func (tw *treeWatcher) handleEvent(s *server, event fsnotify.Event) {
	if event.Op == 0 || event.Op == fsnotify.Chmod {
		return
	}
	cleanAbs := filepath.Clean(event.Name)
	rel, err := filepath.Rel(tw.root, cleanAbs)
	if err != nil {
		return
	}
	relSlash := filepath.ToSlash(rel)
	if relSlash == ".." || strings.HasPrefix(relSlash, "../") {
		return
	}
	if relSlash == "." {
		tw.scheduleRefresh(s, "")
		return
	}
	if isIgnoredWatchRel(relSlash) {
		return
	}

	// If a watched directory itself was removed or renamed, drop its stale watch
	// and refresh its parent directory.
	tw.mu.Lock()
	watchedRel, isWatchedDir := tw.byAbs[cleanAbs]
	if isWatchedDir && (event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)) {
		_ = tw.w.Remove(cleanAbs)
		delete(tw.byAbs, cleanAbs)
		delete(tw.watched, watchedRel)
	}
	tw.mu.Unlock()

	if isWatchedDir && (event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)) {
		tw.scheduleRefresh(s, parentRelDir(watchedRel))
		return
	}

	tw.scheduleRefresh(s, parentRelDir(relSlash))
}

func (tw *treeWatcher) scheduleRefresh(s *server, relDir string) {
	tw.mu.Lock()
	defer tw.mu.Unlock()
	if tw.closed {
		return
	}
	if existing, ok := tw.timers[relDir]; ok {
		existing.Reset(tw.debounce)
		return
	}
	tw.timers[relDir] = time.AfterFunc(tw.debounce, func() {
		tw.mu.Lock()
		delete(tw.timers, relDir)
		closed := tw.closed
		tw.mu.Unlock()
		if !closed {
			s.refreshWatchedDir(relDir)
		}
	})
}

func (s *server) refreshWatchedDir(relDir string) {
	sv, ok := s.vault.(shallowVault)
	if !ok {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	shallowFiles, subdirs, err := sv.ScanDirShallow(ctx, relDir)
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) && relDir != "" {
			s.tree.mu.Lock()
			if s.tree.done && !s.tree.scanning {
				prefix := relDir + "/"
				kept := make([]vault.Entry, 0, len(s.tree.files))
				var removed []string
				for _, entry := range s.tree.files {
					if strings.HasPrefix(entry.Path, prefix) {
						removed = append(removed, entry.Path)
						continue
					}
					kept = append(kept, entry)
				}
				if len(removed) > 0 {
					s.tree.files = kept
					s.tree.version++
					s.recordTreeDeltaLocked(treeDelta{removed: removed})
				}
			}
			s.tree.mu.Unlock()
		}
		return
	}

	// Find any newly appeared subdirectories that have no cached entries yet.
	var newSubdirs []string
	s.tree.mu.Lock()
	if !s.tree.done || s.tree.scanning {
		s.tree.mu.Unlock()
		return
	}
	for _, sub := range subdirs {
		prefix := sub + "/"
		hasAny := false
		for _, entry := range s.tree.files {
			if strings.HasPrefix(entry.Path, prefix) {
				hasAny = true
				break
			}
		}
		if !hasAny {
			newSubdirs = append(newSubdirs, sub)
		}
	}
	s.tree.mu.Unlock()

	var newSubdirFiles []vault.Entry
	for _, sub := range newSubdirs {
		_ = sv.ScanFolder(ctx, sub, func(entry vault.Entry) error {
			newSubdirFiles = append(newSubdirFiles, entry)
			return nil
		})
	}

	shallowByPath := make(map[string]vault.Entry, len(shallowFiles))
	for _, f := range shallowFiles {
		shallowByPath[f.Path] = f
	}
	subdirSet := make(map[string]struct{}, len(subdirs))
	for _, sub := range subdirs {
		subdirSet[sub] = struct{}{}
	}
	newSubByPath := make(map[string]vault.Entry, len(newSubdirFiles))
	for _, f := range newSubdirFiles {
		newSubByPath[f.Path] = f
	}

	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if !s.tree.done || s.tree.scanning {
		return
	}

	merged := make([]vault.Entry, 0, len(s.tree.files)+len(shallowByPath)+len(newSubByPath))
	var delta treeDelta
	for _, cur := range s.tree.files {
		pDir := parentRelDir(cur.Path)
		if pDir == relDir {
			if next, ok := shallowByPath[cur.Path]; ok {
				if next.ModTime != cur.ModTime || next.Size != cur.Size || next.Name != cur.Name {
					merged = append(merged, next)
					delta.updated = append(delta.updated, next)
				} else {
					merged = append(merged, cur)
				}
				delete(shallowByPath, cur.Path)
			} else {
				delta.removed = append(delta.removed, cur.Path)
			}
			continue
		}
		if isUnderRelDir(cur.Path, relDir) {
			childSub := immediateChildSubdir(relDir, cur.Path)
			if _, exists := subdirSet[childSub]; !exists {
				delta.removed = append(delta.removed, cur.Path)
				continue
			}
			if next, ok := newSubByPath[cur.Path]; ok {
				if next.ModTime != cur.ModTime || next.Size != cur.Size || next.Name != cur.Name {
					merged = append(merged, next)
					delta.updated = append(delta.updated, next)
				} else {
					merged = append(merged, cur)
				}
				delete(newSubByPath, cur.Path)
				continue
			}
		}
		merged = append(merged, cur)
	}

	for _, added := range shallowByPath {
		merged = append(merged, added)
		delta.added = append(delta.added, added)
	}
	for _, added := range newSubByPath {
		merged = append(merged, added)
		delta.added = append(delta.added, added)
	}

	if len(delta.added) > 0 || len(delta.updated) > 0 || len(delta.removed) > 0 {
		s.tree.files = merged
		s.tree.version++
		s.recordTreeDeltaLocked(delta)
	}
}

func (s *server) handleWatchTree(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Dirs []string `json:"dirs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if s.watcher == nil {
		writeJSON(w, http.StatusOK, map[string]any{"watched": 0, "capped": false})
		return
	}
	watched, capped := s.watcher.setDirs(body.Dirs)
	writeJSON(w, http.StatusOK, map[string]any{"watched": watched, "capped": capped})
}

func parentRelDir(relPath string) string {
	d := path.Dir(relPath)
	if d == "." || d == "/" {
		return ""
	}
	return d
}

func isUnderRelDir(entryPath, relDir string) bool {
	if relDir == "" {
		return strings.Contains(entryPath, "/")
	}
	return strings.HasPrefix(entryPath, relDir+"/")
}

func immediateChildSubdir(relDir, entryPath string) string {
	rest := entryPath
	if relDir != "" {
		rest = strings.TrimPrefix(entryPath, relDir+"/")
	}
	slash := strings.Index(rest, "/")
	if slash <= 0 {
		return ""
	}
	if relDir == "" {
		return rest[:slash]
	}
	return relDir + "/" + rest[:slash]
}

func isIgnoredWatchRel(rel string) bool {
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" {
			continue
		}
		if strings.HasPrefix(seg, ".") || seg == "node_modules" || seg == "vendor" {
			return true
		}
	}
	return false
}
