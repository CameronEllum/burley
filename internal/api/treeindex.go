package api

import (
	"context"
	"errors"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"burley/internal/vault"
)

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
	cancel   context.CancelFunc
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
	s.startTreeScan(refresh)

	files, done, scanning, errMsg := s.treeSnapshot()
	if len(files) == 0 && scanning && !done {
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
		"error":    errMsg,
	})
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
	s.tree.mu.Unlock()

	files, done, scanning, errMsg := s.treeSnapshot()
	s.writeTreeSnapshot(w, files, done, scanning, errMsg)
}

func (s *server) startTreeScan(refresh bool) {
	s.tree.mu.Lock()
	if s.tree.scanning {
		if !refresh {
			s.tree.mu.Unlock()
			return
		}
		if s.tree.cancel != nil {
			s.tree.cancel()
		}
	} else if s.tree.done && !refresh {
		s.tree.mu.Unlock()
		return
	}

	s.tree.files = nil
	s.tree.done = false
	s.tree.scanning = true
	s.tree.err = ""
	s.tree.gen++
	gen := s.tree.gen
	ctx, cancel := context.WithCancel(context.Background())
	s.tree.cancel = cancel
	s.tree.mu.Unlock()

	scanner, ok := s.vault.(interface {
		ScanTree(context.Context, func(vault.Entry) error) error
	})
	if !ok {
		go s.scanFallback(ctx, gen)
		return
	}
	go func() {
		err := scanner.ScanTree(ctx, func(entry vault.Entry) error {
			s.tree.mu.Lock()
			if gen == s.tree.gen {
				s.tree.files = append(s.tree.files, entry)
			}
			s.tree.mu.Unlock()
			return nil
		})
		s.finishTreeScan(gen, ctx, err)
	}()
}

func (s *server) scanFallback(ctx context.Context, gen int) {
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

	s.tree.mu.Lock()
	if gen == s.tree.gen {
		s.tree.files = files
	}
	s.tree.mu.Unlock()
	s.finishTreeScan(gen, ctx, err)
}

func (s *server) finishTreeScan(gen int, ctx context.Context, err error) {
	s.tree.mu.Lock()
	defer s.tree.mu.Unlock()
	if gen != s.tree.gen {
		return // superseded by a newer scan
	}
	s.tree.scanning = false
	s.tree.done = err == nil && ctx.Err() == nil
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
	s.tree.mu.Unlock()
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
