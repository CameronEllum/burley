package vault

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const settingsName = "settings.yaml"

// Settings are the cross-device UI preferences stored in .burley/settings.yaml.
type Settings struct {
	Theme         string `json:"theme"`         // system | light | dark
	WideMode      bool   `json:"wideMode"`      // expanded reading measure
	MarkdownStyle string `json:"markdownStyle"` // default | github | academic | compact
	AutoSave      bool   `json:"autoSave"`
	CtrlClickLink string `json:"ctrlClickLink"` // toggle | open
}

func defaultSettings() Settings {
	return Settings{
		Theme:         "system",
		WideMode:      false,
		MarkdownStyle: "default",
		AutoSave:      true,
		CtrlClickLink: "toggle",
	}
}

func (v *LocalVault) settingsPath() string {
	return filepath.Join(v.root, favoritesDir, settingsName)
}

// ReadSettings loads .burley/settings.yaml. The bool reports whether the file
// existed, so the client can migrate local preferences on first run.
func (v *LocalVault) ReadSettings(ctx context.Context) (Settings, bool, error) {
	if err := ctx.Err(); err != nil {
		return defaultSettings(), false, err
	}
	data, err := os.ReadFile(v.settingsPath())
	if errors.Is(err, fs.ErrNotExist) {
		return defaultSettings(), false, nil
	}
	if err != nil {
		return defaultSettings(), false, err
	}
	return parseSettingsYAML(string(data)), true, nil
}

// WriteSettings validates and atomically writes .burley/settings.yaml.
func (v *LocalVault) WriteSettings(ctx context.Context, settings Settings) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	clean, err := normalizeSettings(settings)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(v.root, favoritesDir), 0o755); err != nil {
		return err
	}
	return writeFileAtomic(v.settingsPath(), []byte(settingsYAML(clean)), 0o644)
}

func normalizeSettings(settings Settings) (Settings, error) {
	theme := strings.ToLower(strings.TrimSpace(settings.Theme))
	if theme == "" {
		theme = "system"
	}
	switch theme {
	case "system", "light", "dark":
	default:
		return Settings{}, ErrInvalidPath
	}

	style := strings.ToLower(strings.TrimSpace(settings.MarkdownStyle))
	if style == "" {
		style = "default"
	}
	switch style {
	case "default", "github", "academic", "compact":
	default:
		return Settings{}, ErrInvalidPath
	}

	ctrlClick := strings.ToLower(strings.TrimSpace(settings.CtrlClickLink))
	if ctrlClick == "" {
		ctrlClick = "toggle"
	}
	switch ctrlClick {
	case "toggle", "open":
	default:
		return Settings{}, ErrInvalidPath
	}

	return Settings{
		Theme:         theme,
		WideMode:      settings.WideMode,
		MarkdownStyle: style,
		AutoSave:      settings.AutoSave,
		CtrlClickLink: ctrlClick,
	}, nil
}

func settingsYAML(settings Settings) string {
	var b strings.Builder
	b.WriteString("# Burley settings — managed by the app, safe to edit by hand.\n")
	b.WriteString("# theme: system | light | dark; markdown_style: default | github | academic | compact\n")
	b.WriteString("theme: ")
	b.WriteString(yamlQuote(settings.Theme))
	b.WriteString("\nwide_mode: ")
	b.WriteString(boolYAML(settings.WideMode))
	b.WriteString("\nmarkdown_style: ")
	b.WriteString(yamlQuote(settings.MarkdownStyle))
	b.WriteString("\nauto_save: ")
	b.WriteString(boolYAML(settings.AutoSave))
	b.WriteString("\nctrl_click_link: ")
	b.WriteString(yamlQuote(settings.CtrlClickLink))
	b.WriteByte('\n')
	return b.String()
}

func parseSettingsYAML(content string) Settings {
	settings := defaultSettings()
	for _, raw := range strings.Split(content, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		parsed := parseYAMLScalar(value)
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "theme":
			theme := strings.ToLower(parsed)
			if theme == "system" || theme == "light" || theme == "dark" {
				settings.Theme = theme
			}
		case "wide_mode", "wide":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.WideMode = parsedBool
			}
		case "markdown_style", "style":
			style := strings.ToLower(parsed)
			switch style {
			case "default", "github", "academic", "compact":
				settings.MarkdownStyle = style
			}
		case "auto_save", "autosave":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.AutoSave = parsedBool
			}
		case "ctrl_click_link", "ctrl_click":
			behavior := strings.ToLower(parsed)
			if behavior == "toggle" || behavior == "open" {
				settings.CtrlClickLink = behavior
			}
		}
	}
	return settings
}

func parseYAMLBool(value string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "true", "yes", "on", "1":
		return true, true
	case "false", "no", "off", "0":
		return false, true
	}
	return false, false
}

func boolYAML(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
