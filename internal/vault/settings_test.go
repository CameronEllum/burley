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
	if settings.Theme != "system" || settings.WideMode || settings.MarkdownZoom != 100 || settings.HtmlZoom != 100 {
		t.Fatalf("defaults = %+v", settings)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	v, dir := newTestVault(t)
	ctx := context.Background()

	if err := v.WriteSettings(ctx, Settings{Theme: "dark", LightTheme: "white", DarkTheme: "black", WideMode: true, MarkdownZoom: 120, HtmlZoom: 90}); err != nil {
		t.Fatalf("WriteSettings: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".burley", "settings.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `theme: "dark"`) ||
		!strings.Contains(text, `light_theme: "white"`) ||
		!strings.Contains(text, `dark_theme: "black"`) ||
		!strings.Contains(text, "wide_mode: true") ||
		!strings.Contains(text, "markdown_zoom: 120") ||
		!strings.Contains(text, "html_zoom: 90") {
		t.Fatalf("unexpected yaml:\n%s", text)
	}

	settings, exists, err := v.ReadSettings(ctx)
	if err != nil || !exists {
		t.Fatalf("ReadSettings = %+v %v %v", settings, exists, err)
	}
	if settings.Theme != "dark" || !settings.WideMode || settings.MarkdownZoom != 120 || settings.HtmlZoom != 90 {
		t.Fatalf("settings = %+v", settings)
	}
	if settings.LightTheme != "white" || settings.DarkTheme != "black" {
		t.Fatalf("palettes = %+v", settings)
	}

	// Empty theme falls back to system; explicit light is allowed.
	if err := v.WriteSettings(ctx, Settings{Theme: "", WideMode: false}); err != nil {
		t.Fatal(err)
	}
	settings, _, _ = v.ReadSettings(ctx)
	if settings.Theme != "system" || settings.WideMode {
		t.Fatalf("empty theme = %+v", settings)
	}
	if settings.LightTheme != "parchment" || settings.DarkTheme != "ember" {
		t.Fatalf("default palettes = %+v", settings)
	}

	if err := v.WriteSettings(ctx, Settings{Theme: "neon"}); err == nil {
		t.Fatal("invalid theme accepted")
	}
	if err := v.WriteSettings(ctx, Settings{LightTheme: "sepia"}); err == nil {
		t.Fatal("invalid light theme accepted")
	}
	if err := v.WriteSettings(ctx, Settings{DarkTheme: "midnight"}); err == nil {
		t.Fatal("invalid dark theme accepted")
	}
}

func TestSettingsAgentModels(t *testing.T) {
	v, dir := newTestVault(t)
	ctx := context.Background()

	settings := Settings{
		Theme:       "system",
		AgentModels: map[string]string{"opencode": "opencode-go/deepseek-v4.1-flash", "Claude": "sonnet"},
	}
	if err := v.WriteSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".burley", "settings.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `agent_model_opencode: "opencode-go/deepseek-v4.1-flash"`) {
		t.Fatalf("unexpected yaml:\n%s", raw)
	}

	loaded, _, err := v.ReadSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AgentModels["opencode"] != "opencode-go/deepseek-v4.1-flash" {
		t.Fatalf("opencode pin = %q", loaded.AgentModels["opencode"])
	}
	if loaded.AgentModels["claude"] != "sonnet" {
		t.Fatalf("agent ids should be lowercased: %+v", loaded.AgentModels)
	}

	// Invalid pins are dropped instead of reaching the CLI.
	bad := Settings{Theme: "system", AgentModels: map[string]string{
		"opencode": "model with spaces",
		"bad id":   "opencode-go/ok",
		"":         "opencode-go/ok",
	}}
	if err := v.WriteSettings(ctx, bad); err != nil {
		t.Fatal(err)
	}
	loaded, _, _ = v.ReadSettings(ctx)
	if len(loaded.AgentModels) != 0 {
		t.Fatalf("invalid pins kept: %+v", loaded.AgentModels)
	}

	// Hand-edited YAML is parsed the same way.
	path := filepath.Join(dir, ".burley", "settings.yaml")
	if err := os.WriteFile(path, []byte("theme: dark\nagent_model_opencode: 'opencode-go/deepseek-v4-pro'\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	loaded, _, _ = v.ReadSettings(ctx)
	if loaded.AgentModels["opencode"] != "opencode-go/deepseek-v4-pro" {
		t.Fatalf("parsed pins = %+v", loaded.AgentModels)
	}
}

func TestSettingsYAMLForms(t *testing.T) {
	v, dir := newTestVault(t)
	path := filepath.Join(dir, ".burley", "settings.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "# hand edited\ntheme: 'Light'\nlight_theme: 'White'\ndark_theme: 'Black'\nwide_mode: yes\nunknown: value\n"
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
	if settings.LightTheme != "white" || settings.DarkTheme != "black" {
		t.Fatalf("palettes = %+v", settings)
	}
}
