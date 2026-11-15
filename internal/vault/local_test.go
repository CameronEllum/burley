package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func newTestVault(t *testing.T) (*LocalVault, string) {
	t.Helper()
	dir := t.TempDir()
	v, err := NewLocalVault(dir)
	if err != nil {
		t.Fatalf("NewLocalVault: %v", err)
	}
	v.DisableRipgrep = true
	return v, dir
}

func writeFile(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeRel(t *testing.T) {
	ok := map[string]string{
		"notes/todo.md":       "notes/todo.md",
		"./notes/todo.md":     "notes/todo.md",
		"a/./b/c.md":          "a/b/c.md",
		`notes\windows\a.md`:  "notes/windows/a.md",
		"deep/nested/file.md": "deep/nested/file.md",
	}
	for in, want := range ok {
		got, err := NormalizeRel(in)
		if err != nil {
			t.Errorf("NormalizeRel(%q) unexpected error: %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("NormalizeRel(%q) = %q, want %q", in, got, want)
		}
	}

	bad := []string{
		"", " ", "../secret.md", "../../etc/passwd", "a/../../b.md",
		"/etc/passwd", `C:\Windows\win.ini`, "C:/temp/a.md", "a\x00b.md", "..",
	}
	for _, in := range bad {
		if got, err := NormalizeRel(in); err == nil {
			t.Errorf("NormalizeRel(%q) = %q, want error", in, got)
		}
	}
}

func TestTreeAndRead(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "root.md", "# Root\n")
	writeFile(t, dir, "notes/todo.md", "# Todo\n")
	writeFile(t, dir, "notes/deep/more.md", "more\n")
	writeFile(t, dir, "notes/image.png", "not markdown")
	writeFile(t, dir, ".hidden/secret.md", "nope")
	writeFile(t, dir, "empty/readme.txt", "no markdown here")
	if err := os.MkdirAll(filepath.Join(dir, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}

	tree, err := v.Tree(context.Background())
	if err != nil {
		t.Fatalf("Tree: %v", err)
	}
	if len(tree) != 2 {
		t.Fatalf("tree top-level = %d entries, want 2: %+v", len(tree), tree)
	}
	if !tree[0].IsDir || tree[0].Name != "notes" {
		t.Fatalf("first entry = %+v, want notes dir", tree[0])
	}
	if len(tree[0].Children) != 2 {
		t.Fatalf("notes children = %+v", tree[0].Children)
	}
	if tree[1].Path != "root.md" {
		t.Fatalf("second entry = %+v, want root.md", tree[1])
	}
	for _, e := range tree {
		if e.Name == ".hidden" || e.Name == "empty" {
			t.Fatalf("unexpected entry %q in tree", e.Name)
		}
	}

	fd, err := v.Read(context.Background(), "notes/todo.md")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if fd.Content != "# Todo\n" || fd.Hash != HashBytes([]byte("# Todo\n")) || fd.ModTime == 0 {
		t.Fatalf("Read returned %+v", fd)
	}

	if _, err := v.Read(context.Background(), "notes/missing.md"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing read err = %v, want ErrNotFound", err)
	}
	if _, err := v.Read(context.Background(), "notes/image.png"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("non-markdown read err = %v, want ErrInvalidPath", err)
	}
	if _, err := v.Read(context.Background(), "../escape.md"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("traversal read err = %v, want ErrForbidden", err)
	}
}

func TestWriteAtomicConflictAndEOL(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "note.md", "line1\r\nline2\r\n")
	ctx := context.Background()

	before, err := v.Read(ctx, "note.md")
	if err != nil {
		t.Fatal(err)
	}

	// Lossless round-trip of CRLF + trailing newline.
	updated, err := v.Write(ctx, "note.md", []byte("line1\r\nline2\r\nline3\r\n"), before.Hash)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if updated.Hash != HashBytes([]byte("line1\r\nline2\r\nline3\r\n")) {
		t.Fatalf("hash mismatch: %s", updated.Hash)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "line1\r\nline2\r\nline3\r\n" {
		t.Fatalf("bytes on disk = %q", raw)
	}

	// Stale hash must conflict and return the server-side content.
	_, err = v.Write(ctx, "note.md", []byte("clobber"), before.Hash)
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("stale write err = %v, want ConflictError", err)
	}
	if conflict.Current.Content != "line1\r\nline2\r\nline3\r\n" {
		t.Fatalf("conflict current = %q", conflict.Current.Content)
	}
	raw, _ = os.ReadFile(filepath.Join(dir, "note.md"))
	if string(raw) != "line1\r\nline2\r\nline3\r\n" {
		t.Fatalf("file was overwritten despite conflict: %q", raw)
	}

	// New file creation (empty expected hash) and no temp files left behind.
	created, err := v.Write(ctx, "sub/new.md", []byte("new"), "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.Path != "sub/new.md" {
		t.Fatalf("created path = %q", created.Path)
	}
	entries, err := os.ReadDir(filepath.Join(dir, "sub"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".burley-tmp-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}

	// Non-markdown writes are rejected.
	if _, err := v.Write(ctx, "evil.txt", []byte("x"), ""); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("txt write err = %v, want ErrInvalidPath", err)
	}
}

func TestWritePreservesPermissions(t *testing.T) {
	v, dir := newTestVault(t)
	p := filepath.Join(dir, "perm.md")
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Write(context.Background(), "perm.md", []byte("y"), ""); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "windows" {
		// Windows only maps the read-only bit; the rest of the POSIX mode is
		// synthesized, so a full equality check is meaningless.
		t.Skip("POSIX permission bits are not enforced on Windows")
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("perm = %o, want 600", got)
	}
}

func TestReadAsset(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "img/plot.png", "PNGDATA")
	writeFile(t, dir, "data/results.json", `{"a":1}`)
	writeFile(t, dir, "bin/tool.exe", "MZ")

	b, mime, err := v.ReadAsset(context.Background(), "img/plot.png")
	if err != nil || string(b) != "PNGDATA" || mime != "image/png" {
		t.Fatalf("ReadAsset png = %q %q %v", b, mime, err)
	}
	if _, mime, err := v.ReadAsset(context.Background(), "data/results.json"); err != nil || !strings.Contains(mime, "json") {
		t.Fatalf("ReadAsset json = %q %v", mime, err)
	}
	if _, _, err := v.ReadAsset(context.Background(), "bin/tool.exe"); !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("exe asset err = %v, want ErrInvalidPath", err)
	}
	if _, _, err := v.ReadAsset(context.Background(), "../outside.png"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("traversal asset err = %v, want ErrForbidden", err)
	}
}

func TestSearchFallback(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "a.md", "first line\nEigenvalue problem\nlast\n")
	writeFile(t, dir, "nested/b.md", "an eigenvalue appears here too\n")
	writeFile(t, dir, "nested/skip.txt", "eigenvalue in text file\n")
	writeFile(t, dir, ".private/c.md", "eigenvalue hidden\n")

	matches, err := v.SearchContent(context.Background(), "eigenvalue", 10)
	if err != nil {
		t.Fatalf("SearchContent: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("matches = %+v, want 2", matches)
	}
	if matches[0].Path != "a.md" || matches[0].Line != 2 {
		t.Fatalf("first match = %+v", matches[0])
	}
	if matches[1].Path != "nested/b.md" || matches[1].Line != 1 {
		t.Fatalf("second match = %+v", matches[1])
	}

	limited, err := v.SearchContent(context.Background(), "eigenvalue", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(limited) != 1 {
		t.Fatalf("limited matches = %d, want 1", len(limited))
	}

	none, err := v.SearchContent(context.Background(), "zzz-not-present", 10)
	if err != nil || len(none) != 0 {
		t.Fatalf("no matches = %+v %v", none, err)
	}
}

func TestSymlinkEscapeRejected(t *testing.T) {
	v, dir := newTestVault(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := v.Read(context.Background(), "link/secret.md"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("symlink read err = %v, want ErrForbidden", err)
	}
}
