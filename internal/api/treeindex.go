package api

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"burley/internal/vault"
)

const (
	defaultBgScanInterval  = 3 * time.Minute
	defaultHotScanInterval = 5 * time.Second
	defaultBgScanPace      = 15 * time.Millisecond
)

type treeDelta struct {
	version uint64
	added   []vault.Entry
	updated []vault.Entry
	removed []string
}

// treeState keeps a progressively populated index of the vault. The scanner
// runs in the background; /api/tree returns the current snapshot with a `done`
// flag so the browser can repaint every second while large folders are walked.
type treeState struct {
	mu       sync.Mutex
	files    []vault.Entry
	done     bool
	scanning bool
	err      string
	gen      int
	version  uint64
	deltas   []treeDelta
	cancel   context.CancelFunc

	bgEnabled  bool
	bgLoopStop context.CancelFunc
	bgScanStop context.CancelFunc
	bgInterval time.Duration
	bgPace     time.Duration
}

type flatFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	ModTime int64  `json:"modTime"`
	Size    int64  `json:"size"`
}

// handleTree returns the current tree snapshot. It waits briefly for the first
// batch when a fresh scan starts, then returns immediately on follow-up polls.
func (s *server) handleTree(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "1"
	startedNow := s.startTreeScan(refresh)

	files, done, scanning, errMsg := s.treeSnapshot()
	if !refresh && done && !scanning {
		if sinceStr := r.URL.Query().Get("since"); sinceStr != "" {
			if since, err := strconv.ParseUint(sinceStr, 10, 64); err == nil && since != 0 {
				if curVer, delta, status := s.treeDeltaSince(since); status == "unchanged" {
					writeJSON(w, http.StatusOK, map[string]any{
						"unchanged": true,
						"version":   curVer,
						"done":      true,
						"scanning":  false,
					})
					return
				} else if status == "delta" {
					writeJSON(w, http.StatusOK, map[string]any{
						"delta":    true,
						"version":  curVer,
						"added":    toFlatFiles(delta.added),
						"updated":  toFlatFiles(delta.updated),
						"removed":  delta.removed,
						"done":     true,
						"scanning": false,
					})
					return
				}
			}
		}
	}
	if (len(files) == 0 || startedNow) && scanning && !done {
		deadline := time.Now().Add(300 * time.Millisecond)
		for time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
			files, done, scanning, errMsg = s.treeSnapshot()
			if done || !scanning {
				break
			}
		}
	}

	s.writeTreeSnapshot(w, files, done, scanning, errMsg)
}

func (s *server) writeTreeSnapshot(w http.ResponseWriter, files []vault.Entry, done, scanning bool, errMsg string) {
	flat := make([]flatFile, len(files))
	for i, file := range files {
		flat[i] = flatFile{Path: file.Path, Name: file.Name, ModTime: file.ModTime, Size: file.Size}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"tree":     buildTree(files),
		"files":    flat,
		"root":     s.opts.Root,
		"done":     done,
		"scanning": scanning,
		"scanned":  len(files),
		"version":  s.treeVersion(),
		"error":    errMsg,
	})
}

func toFlatFiles(entries []vault.Entry) []flatFile {
	flat := make([]flatFile, len(entries))
	for i, file := range entries {
		flat[i] = flatFile{Path: file.Path, Name: file.Name, ModTime: file.ModTime, Size: file.Size}
	}
	return flat
}

func (s *server) treeVersion() uint64 {
	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	return s.tree.version
}

func (s *server) recordTreeDeltaLocked(delta treeDelta) {
	delta.version = s.tree.version
	const maxDeltas = 64
	if len(s.tree.deltas) >= maxDeltas {
		copy(s.tree.deltas, s.tree.deltas[1:])
		s.tree.deltas[len(s.tree.deltas)-1] = delta
		return
	}
	s.tree.deltas = append(s.tree.deltas, delta)
}

func (s *server) treeDeltaSince(since uint64) (uint64, treeDelta, string) {
	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if !s.tree.done || s.tree.scanning {
		return s.tree.version, treeDelta{}, "full"
	}
	if since == s.tree.version {
		return s.tree.version, treeDelta{}, "unchanged"
	}
	if since > s.tree.version || len(s.tree.deltas) == 0 {
		return s.tree.version, treeDelta{}, "full"
	}
	// Verify we have a contiguous delta chain covering (since, s.tree.version].
	startIdx := -1
	expected := since + 1
	for i, d := range s.tree.deltas {
		if d.version == expected {
			if startIdx == -1 {
				startIdx = i
			}
			expected++
		} else if startIdx != -1 {
			return s.tree.version, treeDelta{}, "full"
		}
	}
	if startIdx == -1 || expected-1 != s.tree.version {
		return s.tree.version, treeDelta{}, "full"
	}

	added := map[string]vault.Entry{}
	updated := map[string]vault.Entry{}
	removed := map[string]bool{}
	for _, d := range s.tree.deltas[startIdx:] {
		for _, p := range d.removed {
			delete(added, p)
			delete(updated, p)
			removed[p] = true
		}
		for _, e := range d.added {
			if removed[e.Path] {
				delete(removed, e.Path)
				updated[e.Path] = e
			} else {
				added[e.Path] = e
			}
		}
		for _, e := range d.updated {
			delete(removed, e.Path)
			if _, isNew := added[e.Path]; isNew {
				added[e.Path] = e
			} else {
				updated[e.Path] = e
			}
		}
	}

	out := treeDelta{version: s.tree.version}
	for _, e := range added {
		out.added = append(out.added, e)
	}
	for _, e := range updated {
		out.updated = append(out.updated, e)
	}
	for p := range removed {
		out.removed = append(out.removed, p)
	}
	sort.Slice(out.added, func(i, j int) bool { return out.added[i].Path < out.added[j].Path })
	sort.Slice(out.updated, func(i, j int) bool { return out.updated[i].Path < out.updated[j].Path })
	sort.Strings(out.removed)
	return s.tree.version, out, "delta"
}

// handleRescanFolder rescans a single folder in place without invalidating or
// re-walking the rest of the vault.
func (s *server) handleRescanFolder(w http.ResponseWriter, r *http.Request) {
	rawPath := r.URL.Query().Get("path")
	clean, err := vault.NormalizeRel(rawPath)
	if err != nil {
		vaultError(w, err)
		return
	}

	scanner, ok := s.vault.(interface {
		ScanFolder(context.Context, string, func(vault.Entry) error) error
	})
	if !ok {
		s.invalidateTree()
		s.startTreeScan(true)
		files, done, scanning, errMsg := s.treeSnapshot()
		s.writeTreeSnapshot(w, files, done, scanning, errMsg)
		return
	}

	var updated []vault.Entry
	err = scanner.ScanFolder(r.Context(), clean, func(entry vault.Entry) error {
		updated = append(updated, entry)
		return nil
	})
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			s.deleteTreeEntries(clean)
			files, done, scanning, errMsg := s.treeSnapshot()
			s.writeTreeSnapshot(w, files, done, scanning, errMsg)
			return
		}
		vaultError(w, err)
		return
	}

	prefix := clean + "/"
	s.tree.mu.Lock()
	kept := make([]vault.Entry, 0, len(s.tree.files)+len(updated))
	for _, entry := range s.tree.files {
		if entry.Path == clean || strings.HasPrefix(entry.Path, prefix) {
			continue
		}
		kept = append(kept, entry)
	}
	kept = append(kept, updated...)
	s.tree.files = kept
	s.tree.version++
	s.tree.mu.Unlock()

	files, done, scanning, errMsg := s.treeSnapshot()
	s.writeTreeSnapshot(w, files, done, scanning, errMsg)
}

func (s *server) startTreeScan(refresh bool) bool {
	s.tree.mu.Lock()
	if s.tree.scanning {
		if !refresh {
			s.tree.mu.Unlock()
			return false
		}
		if s.tree.cancel != nil {
			s.tree.cancel()
		}
	} else if s.tree.done && !refresh {
		s.tree.mu.Unlock()
		return false
	}

	if s.tree.bgScanStop != nil {
		s.tree.bgScanStop()
		s.tree.bgScanStop = nil
	}
	coldStart := len(s.tree.files) == 0
	if coldStart {
		s.tree.files = nil
		s.tree.deltas = nil
	}
	s.tree.done = false
	s.tree.scanning = true
	s.tree.err = ""
	s.tree.gen++
	s.tree.version++
	gen := s.tree.gen
	ctx, cancel := context.WithCancel(context.Background())
	s.tree.cancel = cancel
	s.tree.mu.Unlock()

	scanner, ok := s.vault.(interface {
		ScanTree(context.Context, func(vault.Entry) error) error
	})
	if !ok {
		go s.scanFallback(ctx, gen, coldStart)
		return true
	}
	go func() {
		var collected []vault.Entry
		err := scanner.ScanTree(ctx, func(entry vault.Entry) error {
			if coldStart {
				s.tree.mu.Lock()
				if gen == s.tree.gen {
					s.tree.files = append(s.tree.files, entry)
					s.tree.version++
				}
				s.tree.mu.Unlock()
			} else {
				collected = append(collected, entry)
			}
			return nil
		})
		if coldStart {
			s.finishTreeScan(gen, ctx, err)
			return
		}
		s.finishTreeScanDiff(gen, ctx, collected, err)
	}()
	return true
}

func (s *server) scanFallback(ctx context.Context, gen int, coldStart bool) {
	entries, err := s.vault.Tree(ctx)
	files := []vault.Entry{}
	var flatten func([]vault.Entry)
	flatten = func(nodes []vault.Entry) {
		for _, node := range nodes {
			if node.IsDir {
				flatten(node.Children)
				continue
			}
			files = append(files, node)
		}
	}
	flatten(entries)

	if coldStart {
		s.tree.mu.Lock()
		if gen == s.tree.gen {
			s.tree.files = files
		}
		s.tree.mu.Unlock()
		s.finishTreeScan(gen, ctx, err)
		return
	}
	s.finishTreeScanDiff(gen, ctx, files, err)
}

func (s *server) finishTreeScanDiff(gen int, ctx context.Context, collected []vault.Entry, err error) {
	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if gen != s.tree.gen {
		return // superseded by a newer scan
	}
	s.tree.scanning = false
	ok := err == nil && ctx.Err() == nil
	s.tree.done = ok
	s.tree.cancel = nil
	if ok {
		if merged, delta, changed := mergeTreeDiff(s.tree.files, collected); changed {
			s.tree.files = merged
			s.tree.version++
			s.recordTreeDeltaLocked(delta)
		} else {
			s.tree.version++
		}
	} else {
		s.tree.version++
		if err != nil && ctx.Err() == nil {
			s.tree.err = err.Error()
		}
	}
}

func (s *server) finishTreeScan(gen int, ctx context.Context, err error) {
	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if gen != s.tree.gen {
		return // superseded by a newer scan
	}
	s.tree.scanning = false
	s.tree.done = err == nil && ctx.Err() == nil
	s.tree.version++
	s.tree.cancel = nil
	if err != nil && ctx.Err() == nil {
		s.tree.err = err.Error()
	}
}

func (s *server) treeSnapshot() ([]vault.Entry, bool, bool, string) {
	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	files := make([]vault.Entry, len(s.tree.files))
	copy(files, s.tree.files)
	sort.Slice(files, func(i, j int) bool {
		return strings.ToLower(files[i].Path) < strings.ToLower(files[j].Path)
	})
	return files, s.tree.done, s.tree.scanning, s.tree.err
}

// invalidateTree marks the cached index stale; the next /api/tree rescans.
func (s *server) invalidateTree() {
	s.tree.mu.Lock()
	s.tree.done = false
	s.tree.gen++
	s.tree.deltas = nil
	if s.tree.bgScanStop != nil {
		s.tree.bgScanStop()
		s.tree.bgScanStop = nil
	}
	s.tree.mu.Unlock()
}

// configureBackgroundScan enables or disables the very-low-priority periodic
// vault scan. When disabled, any in-flight background scan is canceled immediately.
func (s *server) configureBackgroundScan(enabled bool) {
	s.tree.mu.Lock()
	if s.tree.bgEnabled == enabled {
		s.tree.mu.Unlock()
		return
	}
	s.tree.bgEnabled = enabled
	if !enabled {
		if s.tree.bgLoopStop != nil {
			s.tree.bgLoopStop()
			s.tree.bgLoopStop = nil
		}
		if s.tree.bgScanStop != nil {
			s.tree.bgScanStop()
			s.tree.bgScanStop = nil
		}
		s.tree.mu.Unlock()
		return
	}
	if s.tree.bgInterval <= 0 {
		s.tree.bgInterval = defaultBgScanInterval
	}
	if s.tree.bgPace <= 0 {
		s.tree.bgPace = defaultBgScanPace
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.tree.bgLoopStop = cancel
	interval := s.tree.bgInterval
	pace := s.tree.bgPace
	s.tree.mu.Unlock()

	go s.backgroundScanLoop(ctx, interval, pace)
}

func (s *server) backgroundScanLoop(ctx context.Context, interval, pace time.Duration) {
	hotInterval := defaultHotScanInterval
	if interval < hotInterval {
		hotInterval = interval
	}
	timer := time.NewTimer(interval)
	hotTicker := time.NewTicker(hotInterval)
	defer timer.Stop()
	defer hotTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-hotTicker.C:
			s.runHotFolderScan()
		case <-timer.C:
			s.runBackgroundScanOnce(ctx, pace)
			timer.Reset(interval)
		}
	}
}

func (s *server) runHotFolderScan() {
	s.tree.mu.Lock()
	enabled := s.tree.bgEnabled && !s.tree.scanning && s.tree.done
	s.tree.mu.Unlock()
	if !enabled {
		return
	}
	dirs := []string{""}
	if s.watcher != nil {
		if watched := s.watcher.watchedDirs(); len(watched) > 0 {
			dirs = watched
		}
	}
	for _, dir := range dirs {
		s.refreshWatchedDir(dir)
	}
}

func (s *server) runBackgroundScanOnce(loopCtx context.Context, pace time.Duration) {
	s.tree.mu.Lock()
	if !s.tree.bgEnabled || s.tree.scanning || !s.tree.done {
		s.tree.mu.Unlock()
		return
	}
	gen := s.tree.gen
	scanCtx, cancel := context.WithCancel(loopCtx)
	s.tree.bgScanStop = cancel
	s.tree.mu.Unlock()

	defer func() {
		cancel()
		s.tree.mu.Lock()
		s.tree.bgScanStop = nil
		s.tree.mu.Unlock()
	}()

	var collected []vault.Entry
	var err error
	if scanner, ok := s.vault.(interface {
		ScanTree(context.Context, func(vault.Entry) error) error
	}); ok {
		err = scanner.ScanTree(scanCtx, func(entry vault.Entry) error {
			collected = append(collected, entry)
			runtime.Gosched()
			if pace > 0 {
				t := time.NewTimer(pace)
				select {
				case <-scanCtx.Done():
					t.Stop()
					return scanCtx.Err()
				case <-t.C:
				}
			}
			return nil
		})
	} else {
		var entries []vault.Entry
		entries, err = s.vault.Tree(scanCtx)
		if err == nil {
			var flatten func([]vault.Entry)
			flatten = func(nodes []vault.Entry) {
				for _, node := range nodes {
					if node.IsDir {
						flatten(node.Children)
						continue
					}
					collected = append(collected, node)
				}
			}
			flatten(entries)
		}
	}
	if err != nil || scanCtx.Err() != nil {
		return
	}

	s.tree.mu.Lock()
	if s.tree.bgEnabled && s.tree.gen == gen && !s.tree.scanning && s.tree.done {
		if merged, delta, changed := mergeTreeDiff(s.tree.files, collected); changed {
			s.tree.files = merged
			s.tree.version++
			s.recordTreeDeltaLocked(delta)
		}
	}
	s.tree.mu.Unlock()
}

// mergeTreeDiff reconciles an existing file list against a fresh scan, keeping
// unchanged entries intact and returning the exact added/updated/removed delta.
func mergeTreeDiff(existing, collected []vault.Entry) ([]vault.Entry, treeDelta, bool) {
	byPath := make(map[string]vault.Entry, len(collected))
	for _, entry := range collected {
		byPath[entry.Path] = entry
	}
	merged := make([]vault.Entry, 0, len(collected))
	var delta treeDelta
	for _, cur := range existing {
		next, ok := byPath[cur.Path]
		if !ok {
			delta.removed = append(delta.removed, cur.Path)
			continue
		}
		if next.ModTime != cur.ModTime || next.Size != cur.Size || next.Name != cur.Name {
			merged = append(merged, next)
			delta.updated = append(delta.updated, next)
		} else {
			merged = append(merged, cur)
		}
		delete(byPath, cur.Path)
	}
	for _, entry := range byPath {
		merged = append(merged, entry)
		delta.added = append(delta.added, entry)
	}
	changed := len(delta.added) > 0 || len(delta.updated) > 0 || len(delta.removed) > 0
	if !changed {
		return existing, treeDelta{}, false
	}
	return merged, delta, true
}

// renameTreeEntries updates cached paths in place so renames do not trigger a
// full vault rescan.
func (s *server) renameTreeEntries(fromPath, toPath string) {
	fromClean, err := vault.NormalizeRel(fromPath)
	if err != nil {
		return
	}
	toClean, err := vault.NormalizeRel(toPath)
	if err != nil {
		return
	}

	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if len(s.tree.files) == 0 {
		return
	}
	prefix := fromClean + "/"
	for i := range s.tree.files {
		p := s.tree.files[i].Path
		if p == fromClean {
			s.tree.files[i].Path = toClean
			if slash := strings.LastIndex(toClean, "/"); slash >= 0 {
				s.tree.files[i].Name = toClean[slash+1:]
			} else {
				s.tree.files[i].Name = toClean
			}
		} else if strings.HasPrefix(p, prefix) {
			s.tree.files[i].Path = toClean + p[len(fromClean):]
		}
	}
}

// deleteTreeEntries removes deleted file or folder entries from the cached
// index in place so deletions do not trigger a full vault rescan.
func (s *server) deleteTreeEntries(targetPath string) {
	clean, err := vault.NormalizeRel(targetPath)
	if err != nil {
		return
	}

	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if len(s.tree.files) == 0 {
		return
	}
	prefix := clean + "/"
	kept := s.tree.files[:0]
	for _, entry := range s.tree.files {
		if entry.Path == clean || strings.HasPrefix(entry.Path, prefix) {
			continue
		}
		kept = append(kept, entry)
	}
	s.tree.files = kept
}

type treeNode struct {
	entry    vault.Entry
	children []*treeNode
}

// buildTree turns a flat list of Markdown files into the nested folder tree.
// Only folders that contain at least one Markdown file are included, matching
// the blocking walker's behaviour.
func buildTree(files []vault.Entry) []vault.Entry {
	root := &treeNode{entry: vault.Entry{IsDir: true}}
	dirs := map[string]*treeNode{"": root}

	for _, file := range files {
		parts := strings.Split(file.Path, "/")
		if len(parts) == 0 {
			continue
		}
		parent := root
		prefix := ""
		for i := 0; i < len(parts)-1; i++ {
			if prefix == "" {
				prefix = parts[i]
			} else {
				prefix += "/" + parts[i]
			}
			node := dirs[prefix]
			if node == nil {
				node = &treeNode{entry: vault.Entry{Name: parts[i], Path: prefix, IsDir: true}}
				dirs[prefix] = node
				parent.children = append(parent.children, node)
			}
			parent = node
		}
		parent.children = append(parent.children, &treeNode{entry: file})
	}

	result := make([]vault.Entry, 0, len(root.children))
	for _, child := range root.children {
		result = append(result, finalizeTreeNode(child))
	}
	sortEntries(result)
	return result
}

func finalizeTreeNode(node *treeNode) vault.Entry {
	entry := node.entry
	if node.children != nil {
		entry.Children = make([]vault.Entry, 0, len(node.children))
		for _, child := range node.children {
			entry.Children = append(entry.Children, finalizeTreeNode(child))
		}
		sortEntries(entry.Children)
	}
	return entry
}

func sortEntries(entries []vault.Entry) {
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
}
