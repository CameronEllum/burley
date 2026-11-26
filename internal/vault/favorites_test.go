package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestFavoritesRoundTrip(t *testing.T) {
	v, dir := newTestVault(t)
	ctx := context.Background()

	initial, err := v.ReadFavorites(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(initial) != 0 {
		t.Fatalf("initial favorites = %v, want empty", initial)
	}

	paths := []string{"notes/todo.md", "notes/with space.md", "welcome.md", "notes/todo.md"}
	if err := v.WriteFavorites(ctx, paths); err != nil {
		t.Fatalf("WriteFavorites: %v", err)
	}

	got, err := v.ReadFavorites(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"notes/todo.md", "notes/with space.md", "welcome.md"}
	if len(got) != len(want) {
		t.Fatalf("favorites = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order mismatch: %v, want %v", got, want)
		}
	}

	raw, err := os.ReadFile(filepath.Join(dir, ".burley", "favorites.yaml"))
	if err != nil {
		t.Fatalf("read yaml: %v", err)
	}
	text := string(raw)
	for _, fragment := range []string{"favorites:", `- "notes/todo.md"`, `- "notes/with space.md"`} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("yaml missing %q:\n%s", fragment, text)
		}
	}
}

func TestFavoritesValidation(t *testing.T) {
	v, dir := newTestVault(t)
	ctx := context.Background()

	for _, bad := range [][]string{
		{"../escape.md"},
		{"/etc/passwd"},
		{".burley/favorites.yaml"},
	} {
		if err := v.WriteFavorites(ctx, bad); err == nil {
			t.Fatalf("WriteFavorites(%v) accepted an invalid path", bad)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".burley", "favorites.yaml")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid write still created favorites.yaml: %v", err)
	}

	if err := v.WriteFavorites(ctx, []string{}); err != nil {
		t.Fatalf("empty list: %v", err)
	}
	got, err := v.ReadFavorites(ctx)
	if err != nil || len(got) != 0 {
		t.Fatalf("empty read = %v %v", got, err)
	}
}

func TestFavoritesYAMLForms(t *testing.T) {
	v, dir := newTestVault(t)
	path := filepath.Join(dir, ".burley", "favorites.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}

	content := `# hand-edited
version: 1
favorites:
  - 'notes/single quoted.md'
  - "notes/double \"quoted\".md"
  - plain/path.md   # trailing comment
  - ../ignored.md
  - .hidden/ignored.md
  - notes/single quoted.md
other: value
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := v.ReadFavorites(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`notes/single quoted.md`, `notes/double "quoted".md`, "plain/path.md"}
	if len(got) != len(want) {
		t.Fatalf("favorites = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("favorites = %#v, want %#v", got, want)
		}
	}
}

func TestFavoritesInlineEmpty(t *testing.T) {
	v, dir := newTestVault(t)
	path := filepath.Join(dir, ".burley", "favorites.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("favorites: []\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := v.ReadFavorites(context.Background())
	if err != nil || len(got) != 0 {
		t.Fatalf("inline empty = %v %v", got, err)
	}
}

func TestFavoritesNoTempFiles(t *testing.T) {
	v, dir := newTestVault(t)
	if err := v.WriteFavorites(context.Background(), []string{"a.md", "b.md"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(dir, ".burley"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".burley-tmp-") {
			t.Fatalf("temp file left behind: %s", entry.Name())
		}
	}
}

func TestFavoriteGroupsRoundTrip(t *testing.T) {
	ctx := context.Background()
	v, err := NewLocalVault(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	want := FavoritesData{
		Favorites: []string{"welcome.md"},
		Groups: []FavoriteGroup{
			{Name: "Visualizations", Items: []string{"notes/plotly-charts.md", "notes/mermaid.md"}},
			{Name: "Empty Group", Items: []string{}},
		},
	}
	if err := v.WriteFavoritesData(ctx, want); err != nil {
		t.Fatalf("WriteFavoritesData: %v", err)
	}
	got, err := v.ReadFavoritesData(ctx)
	if err != nil {
		t.Fatalf("ReadFavoritesData: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}

	// WriteFavorites must preserve existing groups.
	if err := v.WriteFavorites(ctx, []string{"notes/todo.md"}); err != nil {
		t.Fatalf("WriteFavorites: %v", err)
	}
	got2, err := v.ReadFavoritesData(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got2.Favorites) != 1 || got2.Favorites[0] != "notes/todo.md" || !reflect.DeepEqual(got2.Groups, want.Groups) {
		t.Fatalf("WriteFavorites clobbered groups: %+v", got2)
	}
}
