package vault

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	favoritesDir  = ".burley"
	favoritesName = "favorites.yaml"
	maxFavorites  = 500
)

func (v *LocalVault) favoritesPath() string {
	return filepath.Join(v.root, favoritesDir, favoritesName)
}

// ReadFavorites loads `.burley/favorites.yaml`. A missing file is an empty
// list, not an error.
func (v *LocalVault) ReadFavorites(ctx context.Context) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(v.favoritesPath())
	if errors.Is(err, fs.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	favorites := parseFavoritesYAML(string(data))
	if favorites == nil {
		favorites = []string{}
	}
	return favorites, nil
}

// WriteFavorites validates and atomically replaces the favorites file.
func (v *LocalVault) WriteFavorites(ctx context.Context, paths []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cleaned, err := cleanFavorites(paths)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(v.root, favoritesDir), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(v.favoritesPath(), []byte(favoritesYAML(cleaned)), 0o644)
}

func cleanFavorites(paths []string) ([]string, error) {
	if len(paths) > maxFavorites {
		return nil, ErrTooLarge
	}
	out := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, raw := range paths {
		clean, err := NormalizeRel(raw)
		if err != nil {
			return nil, err
		}
		// Never favorite Burley's own metadata (or other hidden top-level dirs).
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

func favoritesYAML(paths []string) string {
	var b strings.Builder
	b.WriteString("# Burley favorites — vault-relative paths, in display order.\n")
	b.WriteString("# Managed by the app; matching paths may be edited by hand.\n")
	if len(paths) == 0 {
		b.WriteString("favorites: []\n")
		return b.String()
	}
	b.WriteString("favorites:\n")
	for _, p := range paths {
		fmt.Fprintf(&b, "  - %s\n", yamlQuote(p))
	}
	return b.String()
}

func yamlQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func parseYAMLScalar(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		var b strings.Builder
		escaped := false
		for _, r := range s[1 : len(s)-1] {
			if escaped {
				switch r {
				case 'n':
					b.WriteByte('\n')
				case 'r':
					b.WriteByte('\r')
				case 't':
					b.WriteByte('\t')
				default:
					b.WriteRune(r)
				}
				escaped = false
				continue
			}
			if r == '\\' {
				escaped = true
				continue
			}
			b.WriteRune(r)
		}
		return b.String()
	}
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'")
	}
	// Plain scalar: drop an inline comment.
	if idx := strings.Index(s, " #"); idx >= 0 {
		s = s[:idx]
	}
	return strings.TrimSpace(s)
}

// parseFavoritesYAML understands the small subset of YAML Burley writes
// (a `favorites:` block list of scalars), plus hand-edited inline [] lists.
func parseFavoritesYAML(content string) []string {
	out := []string{}
	inList := false
	seen := map[string]struct{}{}

	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if !inList {
			key, value, ok := strings.Cut(line, ":")
			if !ok || strings.TrimSpace(key) != "favorites" {
				continue
			}
			rest := strings.TrimSpace(value)
			if rest == "[]" {
				return out
			}
			if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
				for _, part := range strings.Split(strings.Trim(rest, "[]"), ",") {
					addFavorite(&out, seen, parseYAMLScalar(part))
				}
				return out
			}
			inList = true
			continue
		}

		if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") && !strings.HasPrefix(line, "-") {
			break
		}
		if !strings.HasPrefix(line, "-") {
			break
		}
		addFavorite(&out, seen, parseYAMLScalar(strings.TrimSpace(strings.TrimPrefix(line, "-"))))
	}

	return out
}

func addFavorite(out *[]string, seen map[string]struct{}, value string) {
	if value == "" {
		return
	}
	clean, err := NormalizeRel(value)
	if err != nil {
		return
	}
	first := strings.SplitN(clean, "/", 2)[0]
	if strings.HasPrefix(first, ".") {
		return
	}
	if _, ok := seen[clean]; ok {
		return
	}
	seen[clean] = struct{}{}
	*out = append(*out, clean)
}
