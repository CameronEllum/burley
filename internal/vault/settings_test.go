package vault

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSettingsDefaultsWhenMissing(t *testing.T) {
	v, _ := newTestVault(t)
	settings, exists, err := v.ReadSettings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("exists = true, want false for a fresh vault")
	}
	if settings.Theme != "system" || settings.WideMode {
		t.Fatalf("defaults = %+v", settings)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	v, dir := newTestVault(t)
	ctx := context.Background()

	if err := v.WriteSettings(ctx, Settings{Theme: "dark", WideMode: true}); err != nil {
		t.Fatalf("WriteSettings: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".burley", "settings.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `theme: "dark"`) || !strings.Contains(text, "wide_mode: true") {
		t.Fatalf("unexpected yaml:\n%s", text)
	}

	settings, exists, err := v.ReadSettings(ctx)
	if err != nil || !exists {
		t.Fatalf("ReadSettings = %+v %v %v", settings, exists, err)
	}
	if settings.Theme != "dark" || !settings.WideMode {
		t.Fatalf("settings = %+v", settings)
	}

	// Empty theme falls back to system; explicit light is allowed.
	if err := v.WriteSettings(ctx, Settings{Theme: "", WideMode: false}); err != nil {
		t.Fatal(err)
	}
	settings, _, _ = v.ReadSettings(ctx)
	if settings.Theme != "system" || settings.WideMode {
		t.Fatalf("empty theme = %+v", settings)
	}

	if err := v.WriteSettings(ctx, Settings{Theme: "neon"}); err == nil {
		t.Fatal("invalid theme accepted")
	}
}

func TestSettingsYAMLForms(t *testing.T) {
	v, dir := newTestVault(t)
	path := filepath.Join(dir, ".burley", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "# hand edited\ntheme: 'Light'\nwide_mode: yes\nunknown: value\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	settings, exists, err := v.ReadSettings(context.Background())
	if err != nil || !exists {
		t.Fatalf("ReadSettings: %+v %v %v", settings, exists, err)
	}
	if settings.Theme != "light" || !settings.WideMode {
		t.Fatalf("settings = %+v", settings)
	}
}
