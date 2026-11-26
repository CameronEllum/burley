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
	favoritesDir       = ".burley"
	favoritesName      = "favorites.yaml"
	maxFavorites       = 500
	maxFavoriteGroups  = 100
)

// FavoriteGroup is a named topic grouping of vault-relative paths in `.burley/favorites.yaml`.
type FavoriteGroup struct {
	Name  string   `json:"name"`
	Items []string `json:"items"`
}

// FavoritesData holds ungrouped favorites and named topic groups.
type FavoritesData struct {
	Favorites []string        `json:"favorites"`
	Groups    []FavoriteGroup `json:"groups"`
}

func (v *LocalVault) favoritesPath() string {
	return filepath.Join(v.root, favoritesDir, favoritesName)
}

// ReadFavorites loads `.burley/favorites.yaml`. A missing file is an empty
// list, not an error.
func (v *LocalVault) ReadFavorites(ctx context.Context) ([]string, error) {
	data, err := v.ReadFavoritesData(ctx)
	if err != nil {
		return nil, err
	}
	return data.Favorites, nil
}

// ReadFavoritesData loads both ungrouped favorites and named groups from `.burley/favorites.yaml`.
func (v *LocalVault) ReadFavoritesData(ctx context.Context) (FavoritesData, error) {
	if err := ctx.Err(); err != nil {
		return FavoritesData{}, err
	}
	raw, err := os.ReadFile(v.favoritesPath())
	if errors.Is(err, fs.ErrNotExist) {
		return FavoritesData{Favorites: []string{}, Groups: []FavoriteGroup{}}, nil
	}
	if err != nil {
		return FavoritesData{}, err
	}
	content := string(raw)
	favorites := parseFavoritesYAML(content)
	if favorites == nil {
		favorites = []string{}
	}
	groups := parseFavoriteGroupsYAML(content)
	if groups == nil {
		groups = []FavoriteGroup{}
	}
	return FavoritesData{Favorites: favorites, Groups: groups}, nil
}

// WriteFavorites validates and atomically replaces the ungrouped favorites list
// while preserving any existing groups.
func (v *LocalVault) WriteFavorites(ctx context.Context, paths []string) error {
	existing, err := v.ReadFavoritesData(ctx)
	if err != nil {
		return err
	}
	return v.WriteFavoritesData(ctx, FavoritesData{
		Favorites: paths,
		Groups:    existing.Groups,
	})
}

// WriteFavoritesData validates and atomically replaces `.burley/favorites.yaml`.
func (v *LocalVault) WriteFavoritesData(ctx context.Context, data FavoritesData) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	cleaned, err := cleanFavorites(data.Favorites)
	if err != nil {
		return err
	}
	cleanedGroups, err := cleanFavoriteGroups(data.Groups)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(v.root, favoritesDir), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(v.favoritesPath(), []byte(favoritesDataYAML(cleaned, cleanedGroups)), 0o644)
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

func cleanFavoriteGroups(groups []FavoriteGroup) ([]FavoriteGroup, error) {
	if len(groups) > maxFavoriteGroups {
		return nil, ErrTooLarge
	}
	out := make([]FavoriteGroup, 0, len(groups))
	seen := make(map[string]struct{}, len(groups))
	for _, g := range groups {
		name := strings.TrimSpace(g.Name)
		if name == "" {
			return nil, ErrInvalidPath
		}
		key := strings.ToLower(name)
		if _, dup := seen[key]; dup {
			return nil, ErrInvalidPath
		}
		seen[key] = struct{}{}
		items, err := cleanFavorites(g.Items)
		if err != nil {
			return nil, err
		}
		out = append(out, FavoriteGroup{Name: name, Items: items})
	}
	return out, nil
}

func favoritesDataYAML(paths []string, groups []FavoriteGroup) string {
	var b strings.Builder
	b.WriteString("# Burley favorites — vault-relative paths, in display order.\n")
	b.WriteString("# Managed by the app; matching paths may be edited by hand.\n")
	if len(paths) == 0 {
		b.WriteString("favorites: []\n")
	} else {
		b.WriteString("favorites:\n")
		for _, p := range paths {
			fmt.Fprintf(&b, "  - %s\n", yamlQuote(p))
		}
	}
	if len(groups) > 0 {
		b.WriteString("groups:\n")
		for _, g := range groups {
			fmt.Fprintf(&b, "  - name: %s\n", yamlQuote(g.Name))
			if len(g.Items) == 0 {
				b.WriteString("    items: []\n")
			} else {
				b.WriteString("    items:\n")
				for _, item := range g.Items {
					fmt.Fprintf(&b, "      - %s\n", yamlQuote(item))
				}
			}
		}
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
	return parsePathListYAML(content, "favorites")
}

// parsePathListYAML reads a single block list of vault-relative path scalars.
func parsePathListYAML(content, listKey string) []string {
	out := []string{}
	inList := false
	seen := map[string]struct{}{}

	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		if !inList {
			field, value, ok := strings.Cut(line, ":")
			if !ok || strings.TrimSpace(field) != listKey {
				continue
			}
			rest := strings.TrimSpace(value)
			if rest == "[]" {
				return out
			}
			if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
				for _, part := range strings.Split(strings.Trim(rest, "[]"), ",") {
					addPath(&out, seen, parseYAMLScalar(part))
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
		addPath(&out, seen, parseYAMLScalar(strings.TrimSpace(strings.TrimPrefix(line, "-"))))
	}

	return out
}

func parseFavoriteGroupsYAML(content string) []FavoriteGroup {
	out := []FavoriteGroup{}
	inGroups := false
	inItems := false
	curIdx := -1
	seenNames := map[string]struct{}{}
	var curItemsSeen map[string]struct{}

	for _, raw := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if !inGroups {
			field, value, ok := strings.Cut(trimmed, ":")
			if !ok || strings.TrimSpace(field) != "groups" {
				continue
			}
			if strings.TrimSpace(value) == "[]" {
				return out
			}
			inGroups = true
			continue
		}
		// Top-level key ends the groups block.
		if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") {
			break
		}
		if strings.HasPrefix(trimmed, "- name:") {
			name := parseYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "- name:")))
			if name == "" {
				curIdx = -1
				inItems = false
				continue
			}
			key := strings.ToLower(name)
			if _, dup := seenNames[key]; dup {
				curIdx = -1
				inItems = false
				continue
			}
			seenNames[key] = struct{}{}
			out = append(out, FavoriteGroup{Name: name, Items: []string{}})
			curIdx = len(out) - 1
			curItemsSeen = map[string]struct{}{}
			inItems = false
			continue
		}
		if curIdx < 0 {
			continue
		}
		if strings.HasPrefix(trimmed, "items:") {
			rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "items:"))
			if rest == "[]" {
				inItems = false
			} else if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
				for _, part := range strings.Split(strings.Trim(rest, "[]"), ",") {
					addPath(&out[curIdx].Items, curItemsSeen, parseYAMLScalar(part))
				}
				inItems = false
			} else {
				inItems = true
			}
			continue
		}
		if inItems && strings.HasPrefix(trimmed, "-") {
			addPath(&out[curIdx].Items, curItemsSeen, parseYAMLScalar(strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))))
		}
	}
	return out
}

func addPath(out *[]string, seen map[string]struct{}, value string) {
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
