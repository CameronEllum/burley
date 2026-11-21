// Package demo embeds Burley's sample vault so any installed binary can launch
// an interactive `--demo` session or serve a read-only built-in feature tour.
package demo

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"burley/internal/vault"
)

//go:embed all:vault
var embedded embed.FS

// VirtualPrefix is the virtual path prefix used when serving embedded demo
// pages alongside a user's real vault.
const VirtualPrefix = "_demo/"

// FlatFile mirrors the flat file summary returned by `/api/tree`.
type FlatFile struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	ModTime int64  `json:"modTime"`
	Size    int64  `json:"size"`
}

// IsVirtualPath reports whether p targets the built-in virtual demo.
func IsVirtualPath(p string) bool {
	cleaned := path.Clean(strings.TrimPrefix(strings.ReplaceAll(p, "\\", "/"), "/"))
	return cleaned == "_demo" || strings.HasPrefix(cleaned, VirtualPrefix)
}

func subFS() fs.FS {
	sub, err := fs.Sub(embedded, "vault")
	if err != nil {
		return embedded
	}
	return sub
}

func cleanVirtualRel(p string) (string, bool) {
	cleaned := path.Clean(strings.TrimPrefix(strings.ReplaceAll(strings.TrimSpace(p), "\\", "/"), "/"))
	if !strings.HasPrefix(cleaned, VirtualPrefix) {
		return "", false
	}
	rel := strings.TrimPrefix(cleaned, VirtualPrefix)
	if rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return rel, true
}

func isNoteFile(name string) bool {
	ext := strings.ToLower(path.Ext(name))
	switch ext {
	case ".md", ".markdown", ".mdown", ".mkd", ".html", ".htm":
		return true
	default:
		return false
	}
}

// ExtractToTemp writes the embedded demo vault into a fresh temporary
// directory and returns its path plus a cleanup callback.
func ExtractToTemp() (string, func(), error) {
	tmpDir, err := os.MkdirTemp("", "burley-demo-*")
	if err != nil {
		return "", nil, fmt.Errorf("create temp demo dir: %w", err)
	}
	cleanup := func() {
		_ = os.RemoveAll(tmpDir)
	}

	rootFS := subFS()
	err = fs.WalkDir(rootFS, ".", func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if p == "." {
			return nil
		}
		dst := filepath.Join(tmpDir, filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, readErr := fs.ReadFile(rootFS, p)
		if readErr != nil {
			return readErr
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, data, 0o644)
	})
	if err != nil {
		cleanup()
		return "", nil, fmt.Errorf("extract demo vault: %w", err)
	}
	return tmpDir, cleanup, nil
}

// Tree builds the sorted virtual tree and flat file list rooted at `_demo/`.
func Tree() ([]vault.Entry, []FlatFile) {
	rootFS := subFS()
	var flat []FlatFile
	entries := buildEntries(rootFS, ".", &flat)
	sort.Slice(flat, func(i, j int) bool {
		return strings.ToLower(flat[i].Path) < strings.ToLower(flat[j].Path)
	})
	return entries, flat
}

func buildEntries(rootFS fs.FS, dir string, flat *[]FlatFile) []vault.Entry {
	dirEntries, err := fs.ReadDir(rootFS, dir)
	if err != nil {
		return nil
	}
	var dirs []vault.Entry
	var files []vault.Entry
	for _, de := range dirEntries {
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		rel := name
		if dir != "." {
			rel = path.Join(dir, name)
		}
		if de.IsDir() {
			children := buildEntries(rootFS, rel, flat)
			if len(children) == 0 {
				continue
			}
			dirs = append(dirs, vault.Entry{
				Name:     name,
				Path:     VirtualPrefix + rel,
				IsDir:    true,
				Children: children,
			})
			continue
		}
		if !isNoteFile(name) {
			continue
		}
		info, infoErr := de.Info()
		var size int64
		if infoErr == nil {
			size = info.Size()
		}
		vPath := VirtualPrefix + rel
		files = append(files, vault.Entry{
			Name: name,
			Path: vPath,
			Size: size,
		})
		*flat = append(*flat, FlatFile{
			Path: vPath,
			Name: name,
			Size: size,
		})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})
	sort.Slice(files, func(i, j int) bool {
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})
	return append(dirs, files...)
}

// Read returns a virtual `_demo/...` note from the embedded demo vault.
func Read(virtualPath string) (vault.FileData, error) {
	rel, ok := cleanVirtualRel(virtualPath)
	if !ok {
		return vault.FileData{}, vault.ErrInvalidPath
	}
	data, err := fs.ReadFile(subFS(), rel)
	if err != nil {
		return vault.FileData{}, vault.ErrNotFound
	}
	sum := sha256.Sum256(data)
	return vault.FileData{
		Path:    VirtualPrefix + rel,
		Content: string(data),
		Hash:    hex.EncodeToString(sum[:]),
	}, nil
}

// ReadAsset returns raw bytes for a virtual `_demo/...` asset.
func ReadAsset(virtualPath string) ([]byte, error) {
	rel, ok := cleanVirtualRel(virtualPath)
	if !ok {
		return nil, vault.ErrInvalidPath
	}
	data, err := fs.ReadFile(subFS(), rel)
	if err != nil {
		return nil, vault.ErrNotFound
	}
	return data, nil
}
