package vault

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const maxUploadBytes = 32 << 20

var imageExtByMime = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
	"image/avif": ".avif",
	"image/bmp":  ".bmp",
}

// SaveAsset writes an uploaded image to "<note>_assets/" beside the note and
// returns the vault-relative path of the new file.
func (v *LocalVault) SaveAsset(ctx context.Context, notePath, filename string, data []byte, mimeType string) (string, error) {
	if len(data) == 0 {
		return "", ErrInvalidPath
	}
	if len(data) > maxUploadBytes {
		return "", ErrTooLarge
	}
	ext, ok := imageExtByMime[strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))]
	if !ok {
		return "", ErrUnsupportedMedia
	}
	noteAbs, cleanNote, err := v.resolve(notePath)
	if err != nil {
		return "", err
	}
	if !IsMarkdownPath(cleanNote) {
		return "", ErrInvalidPath
	}

	noteBase := strings.TrimSuffix(path.Base(cleanNote), path.Ext(cleanNote))
	folder := noteBase + "_assets"
	assetsDir := filepath.Join(filepath.Dir(noteAbs), folder)
	if err := os.MkdirAll(assetsDir, 0o755); err != nil {
		return "", err
	}

	base := sanitizeAssetBase(filename)
	target := filepath.Join(assetsDir, base+ext)
	for index := 1; ; index++ {
		if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
			break
		}
		target = filepath.Join(assetsDir, base+"-"+itoa(index)+ext)
	}
	if err := writeFileAtomic(target, data, 0o644); err != nil {
		return "", err
	}
	rel, err := filepath.Rel(v.root, target)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

func sanitizeAssetBase(filename string) string {
	base := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(base) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case r == '-' || r == '_' || r == ' ':
			if !lastDash && b.Len() > 0 {
				b.WriteByte('-')
				lastDash = true
			}
		}
		if b.Len() >= 60 {
			break
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		result = "image"
	}
	return result
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

var (
	mdLinkOrImgRE = regexp.MustCompile(`!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))`)
	htmlImgSrcRE  = regexp.MustCompile(`(?i)<img\b[^>]*?\bsrc=["']([^"']+)["']`)
	fencedSrcRE   = regexp.MustCompile(`(?m)^\s*src\s*:\s*["']?([^"'\s#]+)["']?`)
)

// NoteAssets returns a sorted, deduplicated slice of vault-relative asset paths
// belonging to notePath: files inside "<noteBase>_assets/" plus existing
// relative non-Markdown assets referenced in the Markdown content.
func (v *LocalVault) NoteAssets(ctx context.Context, notePath string) ([]string, error) {
	noteAbs, cleanNote, err := v.resolve(notePath)
	if err != nil {
		return nil, err
	}
	if !IsMarkdownPath(cleanNote) {
		return nil, ErrInvalidPath
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rawNote, err := os.ReadFile(noteAbs)
	if err != nil {
		return nil, notFoundIfNeeded(err)
	}

	seen := make(map[string]struct{})
	addIfAsset := func(rel string) {
		abs, clean, rErr := v.resolve(rel)
		if rErr != nil || clean == cleanNote || hasHiddenSegment(clean) || IsMarkdownPath(clean) {
			return
		}
		if _, ok := assetTypes[strings.ToLower(path.Ext(clean))]; !ok {
			return
		}
		info, sErr := os.Stat(abs)
		if sErr != nil || !info.Mode().IsRegular() {
			return
		}
		seen[clean] = struct{}{}
	}

	noteDir := path.Dir(cleanNote)
	noteBase := strings.TrimSuffix(path.Base(cleanNote), path.Ext(cleanNote))
	assetsFolder := noteBase + "_assets"
	assetsDir := filepath.Join(filepath.Dir(noteAbs), assetsFolder)
	if info, sErr := os.Stat(assetsDir); sErr == nil && info.IsDir() {
		_ = filepath.WalkDir(assetsDir, func(p string, d fs.DirEntry, wErr error) error {
			if wErr != nil || ctx.Err() != nil {
				return wErr
			}
			name := d.Name()
			if d.IsDir() {
				if p != assetsDir && strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !d.Type().IsRegular() || strings.HasPrefix(name, ".") {
				return nil
			}
			rel, relErr := filepath.Rel(v.root, p)
			if relErr == nil {
				addIfAsset(filepath.ToSlash(rel))
			}
			return nil
		})
	}

	addRef := func(ref string) {
		ref = strings.TrimSpace(ref)
		if ref == "" || strings.HasPrefix(ref, "#") || strings.HasPrefix(ref, "/") {
			return
		}
		if idx := strings.IndexAny(ref, "#?"); idx >= 0 {
			ref = ref[:idx]
		}
		lower := strings.ToLower(ref)
		if ref == "" || strings.Contains(lower, "://") || strings.HasPrefix(lower, "data:") || strings.HasPrefix(lower, "mailto:") {
			return
		}
		joined := ref
		if noteDir != "." && noteDir != "" {
			joined = path.Join(noteDir, ref)
		} else {
			joined = path.Clean(ref)
		}
		addIfAsset(joined)
	}

	content := string(rawNote)
	for _, m := range mdLinkOrImgRE.FindAllStringSubmatch(content, -1) {
		ref := m[1]
		if ref == "" {
			ref = m[2]
		}
		addRef(ref)
	}
	for _, m := range htmlImgSrcRE.FindAllStringSubmatch(content, -1) {
		addRef(m[1])
	}
	for _, m := range fencedSrcRE.FindAllStringSubmatch(content, -1) {
		addRef(m[1])
	}

	out := make([]string, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sort.Strings(out)
	return out, nil
}

// AssetsStamp returns a fast metadata digest (path, size, modTime) for the
// given vault-relative asset paths so clients can detect asset changes on disk.
func (v *LocalVault) AssetsStamp(ctx context.Context, assetPaths []string) string {
	h := sha256.New()
	for _, rel := range assetPaths {
		if ctx.Err() != nil {
			break
		}
		abs, _, err := v.resolve(rel)
		if err != nil {
			continue
		}
		info, err := os.Stat(abs)
		if err != nil {
			_, _ = fmt.Fprintf(h, "%s:missing\n", rel)
			continue
		}
		_, _ = fmt.Fprintf(h, "%s:%d:%d\n", rel, info.Size(), info.ModTime().UnixNano())
	}
	return hex.EncodeToString(h.Sum(nil))
}
