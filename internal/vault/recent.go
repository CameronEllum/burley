package vault

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	recentName = "recent.yaml"
	maxRecent  = 10
)

func (v *LocalVault) recentPath() string {
	return filepath.Join(v.root, favoritesDir, recentName)
}

// ReadRecent loads `.burley/recent.yaml`. Missing files are an empty list.
func (v *LocalVault) ReadRecent(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(v.recentPath())
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	recent := parsePathListYAML(string(data), "recent")
	if recent == nil {
		recent = []string{}
	}
	return recent, nil
}

// WriteRecent validates and atomically writes the recent-files list (max 10).
func (v *LocalVault) WriteRecent(ctx context.Context, paths []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(paths) > maxRecent {
		paths = paths[:maxRecent]
	}
	cleaned, err := cleanPathList(paths)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(v.root, favoritesDir), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(v.recentPath(), []byte(recentYAML(cleaned)), 0o644)
}

func cleanPathList(paths []string) ([]string, error) {
	out := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, raw := range paths {
		clean, err := NormalizeRel(raw)
		if err != nil {
			return nil, err
		}
		first := strings.SplitN(clean, "/", 2)[0]
		if strings.HasPrefix(first, ".") {
			return nil, ErrInvalidPath
		}
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
	}
	return out, nil
}

func recentYAML(paths []string) string {
	var b strings.Builder
	b.WriteString("# Burley recent files — vault-relative paths, most recent first.\n")
	b.WriteString("# Managed by the app; safe to edit by hand.\n")
	if len(paths) == 0 {
		b.WriteString("recent: []\n")
		return b.String()
	}
	b.WriteString("recent:\n")
	for _, p := range paths {
		b.WriteString("  - ")
		b.WriteString(yamlQuote(p))
		b.WriteByte('\n')
	}
	return b.String()
}
