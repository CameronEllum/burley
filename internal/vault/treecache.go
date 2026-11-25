package vault

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
)

const (
	treeCacheName  = "tree-cache.bin"
	treeCacheMagic = "BLT1"
)

func (v *LocalVault) treeCachePath() string {
	return filepath.Join(v.root, favoritesDir, treeCacheName)
}

// ReadTreeCache loads `.burley/tree-cache.bin` if it exists, is valid, and
// matches the vault's currently enabled file types. Any missing, corrupt, or
// mismatched cache returns (nil, false, nil) so the caller falls back cleanly.
func (v *LocalVault) ReadTreeCache(ctx context.Context) ([]Entry, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	f, err := os.Open(v.treeCachePath())
	if err != nil {
		return nil, false, nil
	}
	defer f.Close()

	r := bufio.NewReaderSize(f, 32*1024)
	var magic [4]byte
	if _, err := io.ReadFull(r, magic[:]); err != nil || string(magic[:]) != treeCacheMagic {
		return nil, false, nil
	}

	typeCount, err := binary.ReadUvarint(r)
	if err != nil || typeCount > 32 {
		return nil, false, nil
	}
	cachedTypes := make([]string, 0, typeCount)
	for range typeCount {
		s, err := readBinString(r, 64)
		if err != nil {
			return nil, false, nil
		}
		cachedTypes = append(cachedTypes, s)
	}
	if !slices.Equal(cachedTypes, v.enabledFileTypes(ctx)) {
		return nil, false, nil
	}

	count, err := binary.ReadUvarint(r)
	if err != nil || count > 2_000_000 {
		return nil, false, nil
	}
	entries := make([]Entry, 0, count)
	for range count {
		p, err := readBinString(r, 4096)
		if err != nil {
			return nil, false, nil
		}
		name, err := readBinString(r, 1024)
		if err != nil {
			return nil, false, nil
		}
		var meta [16]byte
		if _, err := io.ReadFull(r, meta[:]); err != nil {
			return nil, false, nil
		}
		modTime := int64(binary.LittleEndian.Uint64(meta[:8]))
		size := int64(binary.LittleEndian.Uint64(meta[8:]))
		entries = append(entries, Entry{
			Name:    name,
			Path:    p,
			IsDir:   false,
			ModTime: modTime,
			Size:    size,
		})
	}
	return entries, true, nil
}

// WriteTreeCache atomically persists the flat file index to `.burley/tree-cache.bin`.
func (v *LocalVault) WriteTreeCache(ctx context.Context, entries []Entry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(v.root, favoritesDir), 0o755); err != nil {
		return err
	}

	var buf bytes.Buffer
	buf.Grow(64 + len(entries)*48)
	buf.WriteString(treeCacheMagic)

	types := v.enabledFileTypes(ctx)
	var ubuf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(ubuf[:], uint64(len(types)))
	buf.Write(ubuf[:n])
	for _, t := range types {
		writeBinString(&buf, t)
	}

	n = binary.PutUvarint(ubuf[:], uint64(len(entries)))
	buf.Write(ubuf[:n])
	var meta [16]byte
	for _, entry := range entries {
		if entry.IsDir {
			continue
		}
		writeBinString(&buf, entry.Path)
		writeBinString(&buf, entry.Name)
		binary.LittleEndian.PutUint64(meta[:8], uint64(entry.ModTime))
		binary.LittleEndian.PutUint64(meta[8:], uint64(entry.Size))
		buf.Write(meta[:])
	}

	return writeFileAtomic(v.treeCachePath(), buf.Bytes(), 0o644)
}

func writeBinString(buf *bytes.Buffer, s string) {
	var ubuf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(ubuf[:], uint64(len(s)))
	buf.Write(ubuf[:n])
	buf.WriteString(s)
}

func readBinString(r *bufio.Reader, maxLen uint64) (string, error) {
	length, err := binary.ReadUvarint(r)
	if err != nil {
		return "", err
	}
	if length > maxLen {
		return "", errors.New("string too long")
	}
	if length == 0 {
		return "", nil
	}
	b := make([]byte, length)
	if _, err := io.ReadFull(r, b); err != nil {
		return "", err
	}
	return string(b), nil
}
