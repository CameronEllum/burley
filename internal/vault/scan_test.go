package vault

import (
	"context"
	"sort"
	"testing"
)

func TestScanTreeVisitsMarkdownFiles(t *testing.T) {
	v, dir := newTestVault(t)
	writeFile(t, dir, "notes/a.md", "# A\n")
	writeFile(t, dir, "notes/deep/b.md", "# B\n")
	writeFile(t, dir, "notes/deep/skip.txt", "nope\n")
	writeFile(t, dir, "notes/data.json", "{}\n")

	var paths []string
	if err := v.ScanTree(context.Background(), func(entry Entry) error {
		if entry.IsDir {
			t.Fatalf("ScanTree should only emit files, got dir %q", entry.Path)
		}
		paths = append(paths, entry.Path)
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	sort.Strings(paths)
	want := []string{"notes/a.md", "notes/deep/b.md"}
	if len(paths) != len(want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
	for i := range want {
		if paths[i] != want[i] {
			t.Fatalf("paths = %v, want %v", paths, want)
		}
	}
}
