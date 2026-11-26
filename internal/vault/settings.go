package vault

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const settingsName = "settings.yaml"

// Settings are the cross-device UI preferences stored in .burley/settings.yaml.
type Settings struct {
	Theme         string `json:"theme"`         // system | light | dark
	LightTheme    string `json:"lightTheme"`    // parchment | white
	DarkTheme     string `json:"darkTheme"`     // ember | black | tron
	WideMode      bool   `json:"wideMode"`      // expanded reading measure
	MarkdownStyle string `json:"markdownStyle"` // default | github | academic | compact
	AutoSave      bool   `json:"autoSave"`
	CtrlClickLink string `json:"ctrlClickLink"` // toggle | open
	SpellCheck    bool   `json:"spellCheck"`
	// AgentModels pins a CLI model per agent ID (e.g. opencode). An empty or
	// missing entry means "use the agent's own default".
	AgentModels         map[string]string `json:"agentModels"`
	DisabledAgents      []string          `json:"disabledAgents"`
	FileTypes           []string          `json:"fileTypes"`
	BackgroundScan      bool              `json:"backgroundScan"`
	CommentHoverPreview bool              `json:"commentHoverPreview"`
	CommentAuthor       string            `json:"commentAuthor"`
	DemoSeen            bool              `json:"demoSeen"`
}

func defaultFileTypes() []string {
	return []string{"markdown", "html"}
}

func defaultSettings() Settings {
	return Settings{
		Theme:          "system",
		LightTheme:     "parchment",
		DarkTheme:      "ember",
		WideMode:       false,
		MarkdownStyle:  "default",
		AutoSave:       true,
		CtrlClickLink:  "toggle",
		SpellCheck:     false,
		AgentModels:         map[string]string{},
		DisabledAgents:      []string{},
		FileTypes:           defaultFileTypes(),
		CommentHoverPreview: true,
		CommentAuthor:       "",
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

	lightTheme := strings.ToLower(strings.TrimSpace(settings.LightTheme))
	if lightTheme == "" {
		lightTheme = "parchment"
	}
	switch lightTheme {
	case "parchment", "white":
	default:
		return Settings{}, ErrInvalidPath
	}

	darkTheme := strings.ToLower(strings.TrimSpace(settings.DarkTheme))
	if darkTheme == "" {
		darkTheme = "ember"
	}
	switch darkTheme {
	case "ember", "black", "tron":
	default:
		return Settings{}, ErrInvalidPath
	}

	return Settings{
		Theme:          theme,
		LightTheme:     lightTheme,
		DarkTheme:      darkTheme,
		WideMode:       settings.WideMode,
		MarkdownStyle:  style,
		AutoSave:       settings.AutoSave,
		CtrlClickLink:  ctrlClick,
		SpellCheck:     settings.SpellCheck,
		AgentModels:         normalizeAgentModels(settings.AgentModels),
		DisabledAgents:      normalizeDisabledAgents(settings.DisabledAgents),
		FileTypes:           normalizeFileTypes(settings.FileTypes),
		BackgroundScan:      settings.BackgroundScan,
		CommentHoverPreview: settings.CommentHoverPreview,
		CommentAuthor:       normalizeCommentAuthor(settings.CommentAuthor),
		DemoSeen:            settings.DemoSeen,
	}, nil
}

func normalizeCommentAuthor(author string) string {
	clean := strings.TrimSpace(author)
	clean = strings.TrimLeft(clean, "@")
	clean = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ", "(", "", ")", "").Replace(clean)
	clean = strings.TrimSpace(clean)
	if len(clean) > 60 {
		clean = strings.TrimSpace(clean[:60])
	}
	return clean
}

// normalizeFileTypes keeps only known file type IDs. A nil slice (omitted in
// partial payloads or legacy configs) defaults to markdown + html.
func normalizeFileTypes(types []string) []string {
	if types == nil {
		return defaultFileTypes()
	}
	seen := make(map[string]bool, len(types))
	for _, ft := range types {
		switch strings.ToLower(strings.TrimSpace(ft)) {
		case "markdown":
			seen["markdown"] = true
		case "html":
			seen["html"] = true
		}
	}
	out := make([]string, 0, len(seen))
	for _, ft := range []string{"markdown", "html"} {
		if seen[ft] {
			out = append(out, ft)
		}
	}
	return out
}

// normalizeDisabledAgents keeps only valid, unique, sorted agent IDs.
func normalizeDisabledAgents(ids []string) []string {
	if len(ids) == 0 {
		return []string{}
	}
	seen := make(map[string]struct{}, len(ids))
	clean := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" || len(id) > 40 || !isAgentID(id) {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		clean = append(clean, id)
	}
	sort.Strings(clean)
	return clean
}

// normalizeAgentModels keeps only well-formed agent IDs and model references so
// the CLI always receives a single, harmless argument.
func normalizeAgentModels(models map[string]string) map[string]string {
	clean := make(map[string]string, len(models))
	for id, model := range models {
		id = strings.ToLower(strings.TrimSpace(id))
		if id == "" || len(id) > 40 || !isAgentID(id) {
			continue
		}
		model = strings.TrimSpace(model)
		if model == "" || len(model) > 200 || !isModelID(model) {
			continue
		}
		clean[id] = model
	}
	return clean
}

func isAgentID(id string) bool {
	for _, r := range id {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

func isModelID(model string) bool {
	for _, r := range model {
		if r <= ' ' || r > '~' || r == '"' || r == '\'' || r == '\\' || r == '`' {
			return false
		}
	}
	return true
}

func settingsYAML(settings Settings) string {
	var b strings.Builder
	b.WriteString("# Burley settings — managed by the app, safe to edit by hand.\n")
	b.WriteString("# theme: system | light | dark; markdown_style: default | github | academic | compact\n")
	b.WriteString("# light_theme: parchment | white; dark_theme: ember | black | tron\n")
	b.WriteString("theme: ")
	b.WriteString(yamlQuote(settings.Theme))
	b.WriteString("\nlight_theme: ")
	b.WriteString(yamlQuote(settings.LightTheme))
	b.WriteString("\ndark_theme: ")
	b.WriteString(yamlQuote(settings.DarkTheme))
	b.WriteString("\nwide_mode: ")
	b.WriteString(boolYAML(settings.WideMode))
	b.WriteString("\nmarkdown_style: ")
	b.WriteString(yamlQuote(settings.MarkdownStyle))
	b.WriteString("\nauto_save: ")
	b.WriteString(boolYAML(settings.AutoSave))
	b.WriteString("\nctrl_click_link: ")
	b.WriteString(yamlQuote(settings.CtrlClickLink))
	b.WriteString("\nspell_check: ")
	b.WriteString(boolYAML(settings.SpellCheck))
	hasMD := false
	hasHTML := false
	for _, ft := range settings.FileTypes {
		if ft == "markdown" {
			hasMD = true
		} else if ft == "html" {
			hasHTML = true
		}
	}
	b.WriteString("\nfile_type_markdown: ")
	b.WriteString(boolYAML(hasMD))
	b.WriteString("\nfile_type_html: ")
	b.WriteString(boolYAML(hasHTML))
	b.WriteString("\nbackground_scan: ")
	b.WriteString(boolYAML(settings.BackgroundScan))
	b.WriteString("\ncomment_hover_preview: ")
	b.WriteString(boolYAML(settings.CommentHoverPreview))
	b.WriteString("\ncomment_author: ")
	b.WriteString(yamlQuote(settings.CommentAuthor))
	b.WriteString("\ndemo_seen: ")
	b.WriteString(boolYAML(settings.DemoSeen))
	if len(settings.AgentModels) > 0 {
		ids := make([]string, 0, len(settings.AgentModels))
		for id := range settings.AgentModels {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		b.WriteString("\n# Pinned CLI models; delete a line to use the agent's own default.")
		for _, id := range ids {
			b.WriteString("\nagent_model_")
			b.WriteString(id)
			b.WriteString(": ")
			b.WriteString(yamlQuote(settings.AgentModels[id]))
		}
	}
	if len(settings.DisabledAgents) > 0 {
		b.WriteString("\n# Disabled CLI agents.")
		for _, id := range settings.DisabledAgents {
			b.WriteString("\nagent_disabled_")
			b.WriteString(id)
			b.WriteString(": true")
		}
	}
	b.WriteByte('\n')
	return b.String()
}

func parseSettingsYAML(content string) Settings {
	settings := defaultSettings()
	mdEnabled := true
	htmlEnabled := true
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
		lowerKey := strings.ToLower(strings.TrimSpace(key))
		if strings.HasPrefix(lowerKey, "agent_model_") {
			id := strings.TrimSpace(strings.TrimPrefix(lowerKey, "agent_model_"))
			for name, model := range normalizeAgentModels(map[string]string{id: parsed}) {
				settings.AgentModels[name] = model
			}
			continue
		}
		if strings.HasPrefix(lowerKey, "agent_disabled_") {
			id := strings.TrimSpace(strings.TrimPrefix(lowerKey, "agent_disabled_"))
			if parsedBool, ok := parseYAMLBool(parsed); ok && parsedBool {
				settings.DisabledAgents = append(settings.DisabledAgents, id)
			}
			continue
		}
		switch lowerKey {
		case "theme":
			theme := strings.ToLower(parsed)
			if theme == "system" || theme == "light" || theme == "dark" {
				settings.Theme = theme
			}
		case "wide_mode", "wide":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.WideMode = parsedBool
			}
		case "light_theme", "light_palette":
			switch strings.ToLower(parsed) {
			case "parchment", "white":
				settings.LightTheme = strings.ToLower(parsed)
			}
		case "dark_theme", "dark_palette":
			switch strings.ToLower(parsed) {
			case "ember", "black", "tron":
				settings.DarkTheme = strings.ToLower(parsed)
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
		case "spell_check", "spellcheck":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.SpellCheck = parsedBool
			}
		case "file_type_markdown":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				mdEnabled = parsedBool
			}
		case "file_type_html":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				htmlEnabled = parsedBool
			}
		case "background_scan", "backgroundscan":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.BackgroundScan = parsedBool
			}
		case "comment_hover_preview", "comment_hover":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.CommentHoverPreview = parsedBool
			}
		case "comment_author":
			settings.CommentAuthor = normalizeCommentAuthor(parsed)
		case "demo_seen":
			if parsedBool, ok := parseYAMLBool(parsed); ok {
				settings.DemoSeen = parsedBool
			}
		}
	}
	fileTypes := make([]string, 0, 2)
	if mdEnabled {
		fileTypes = append(fileTypes, "markdown")
	}
	if htmlEnabled {
		fileTypes = append(fileTypes, "html")
	}
	settings.FileTypes = fileTypes
	settings.DisabledAgents = normalizeDisabledAgents(settings.DisabledAgents)
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
