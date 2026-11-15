// Package vault defines the storage abstraction used by Burley.
//
// All file access goes through the Vault interface so that a local
// implementation (this package) and a future SSH/SFTP implementation are
// interchangeable.
package vault

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path"
	"strings"
)

// Entry is a node in the folder tree. Paths are always forward-slash relative
// paths from the vault root.
type Entry struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	IsDir    bool    `json:"isDir"`
	ModTime  int64   `json:"modTime"` // Unix milliseconds
	Size     int64   `json:"size"`
	Children []Entry `json:"children,omitempty"`
}

// FileData is the full content of a Markdown file plus the metadata needed for
// optimistic concurrency (mod time + content hash).
type FileData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	ModTime int64  `json:"modTime"` // Unix milliseconds
	Hash    string `json:"hash"`    // SHA-256 hex of the raw bytes
}

// SearchMatch is a single line matching a full-text query.
type SearchMatch struct {
	Path    string `json:"path"`
	Line    int    `json:"line"`   // 1-based
	Column  int    `json:"column"` // 1-based byte column
	Text    string `json:"text"`   // full line, trimmed to a sane length
	Snippet string `json:"snippet"`
}

// Vault is the storage abstraction.
type Vault interface {
	Tree(ctx context.Context) ([]Entry, error)
	Read(ctx context.Context, relPath string) (FileData, error)
	Write(ctx context.Context, relPath string, content []byte, expectedHash string) (FileData, error)
	ReadAsset(ctx context.Context, relPath string) ([]byte, string, error)
	ReadFavorites(ctx context.Context) ([]string, error)
	WriteFavorites(ctx context.Context, paths []string) error
	SearchContent(ctx context.Context, query string, max int) ([]SearchMatch, error)
}

// ConflictError is returned by Write when the file on disk no longer matches the
// hash the client last saw. Current holds the server-side state so the UI can
// offer "keep mine" / "take theirs".
type ConflictError struct {
	Current FileData
}

func (e *ConflictError) Error() string {
	return "file changed on disk: " + e.Current.Path
}

var (
	// ErrForbidden means the requested path escapes the vault root.
	ErrForbidden = errors.New("path is outside the vault root")
	// ErrInvalidPath means the path is malformed or not an allowed file type.
	ErrInvalidPath = errors.New("invalid path")
	// ErrNotFound means the path does not exist.
	ErrNotFound = errors.New("not found")
	// ErrTooLarge means the file exceeds the configured size limit.
	ErrTooLarge = errors.New("file is too large")
)

// HashBytes returns the lowercase SHA-256 hex digest of b.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// IsMarkdownPath reports whether p has a Markdown extension.
func IsMarkdownPath(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".md", ".markdown", ".mdown", ".mkd":
		return true
	}
	return false
}

// NormalizeRel converts a client supplied relative path to a clean,
// forward-slash path, rejecting absolute paths, drive letters, NUL bytes and any
// ".." traversal.
func NormalizeRel(rel string) (string, error) {
	rel = strings.TrimSpace(rel)
	if rel == "" {
		return "", ErrInvalidPath
	}
	if strings.ContainsRune(rel, 0) {
		return "", ErrInvalidPath
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	if strings.HasPrefix(rel, "/") {
		return "", ErrForbidden
	}
	// Windows drive letter (C:/...) or UNC-ish input.
	if len(rel) >= 2 && rel[1] == ':' {
		return "", ErrForbidden
	}
	clean := path.Clean(rel)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", ErrForbidden
	}
	for _, seg := range strings.Split(clean, "/") {
		if seg == ".." {
			return "", ErrForbidden
		}
	}
	return clean, nil
}
