package vault

import (
	"context"
	"errors"
	"os"
	"path"
	"path/filepath"
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
