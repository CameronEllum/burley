// Package agent detects local CLI agents and builds non-interactive invocations.
package agent

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// Adapter describes a CLI that can answer prompts headlessly.
type Adapter struct {
	ID               string
	Name             string
	Command          string
	FallbackCommands []string
	// Args builds the non-interactive invocation. model is empty when the user
	// follows the CLI's own default.
	Args func(prompt, model string) []string
	// StdinPrompt sends the prompt over stdin instead of argv. npm-installed
	// CLIs are .cmd shims on Windows, where cmd.exe truncates multi-line
	// arguments at the first newline; stdin keeps the whole prompt intact.
	StdinPrompt bool
	// ModelsArgs is the subcommand that lists catalog models, when supported.
	ModelsArgs []string
}

// Info is the API representation returned by GET /api/agents.
type Info struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Available bool   `json:"available"`
}

var adapters = []Adapter{
	{
		ID:      "claude",
		Name:    "Claude Code",
		Command: "claude",
		Args: func(prompt, model string) []string {
			args := []string{"-p", prompt, "--output-format", "stream-json", "--verbose"}
			if model != "" {
				args = append(args, "--model", model)
			}
			return args
		},
	},
	{
		ID:      "codex",
		Name:    "Codex",
		Command: "codex",
		Args: func(prompt, model string) []string {
			args := []string{"exec"}
			if model != "" {
				args = append(args, "-m", model)
			}
			return append(args, prompt)
		},
	},
	{
		ID:      "gemini",
		Name:    "Gemini CLI",
		Command: "gemini",
		Args: func(prompt, model string) []string {
			var args []string
			if model != "" {
				args = append(args, "-m", model)
			}
			return append(args, "-p", prompt)
		},
	},
	{
		ID:      "opencode",
		Name:    "OpenCode",
		Command: "opencode",
		Args: func(prompt, model string) []string {
			args := []string{"run"}
			if model != "" {
				args = append(args, "--model", model)
			}
			if prompt != "" {
				args = append(args, prompt)
			}
			return args
		},
		StdinPrompt: true,
		ModelsArgs:  []string{"models"},
	},
	{
		ID:               "cursor",
		Name:             "Cursor",
		Command:          "cursor-agent",
		FallbackCommands: []string{"agent"},
		Args: func(prompt, model string) []string {
			args := []string{"-p", prompt}
			if model != "" {
				args = append(args, "--model", model)
			}
			return args
		},
	},
	{
		ID:      "devin",
		Name:    "Devin",
		Command: "devin",
		Args: func(prompt, model string) []string {
			args := []string{"-p", prompt}
			if model != "" {
				args = append(args, "--model", model)
			}
			return args
		},
	},
	{
		ID:      "pi",
		Name:    "Pi",
		Command: "pi",
		Args: func(prompt, model string) []string {
			args := []string{"-p", prompt}
			if model != "" {
				args = append(args, "--model", model)
			}
			return args
		},
	},
}

// Adapters returns the supported adapter table.
func Adapters() []Adapter {
	return adapters
}

func lookPath(adapter Adapter) (string, bool) {
	if path, err := exec.LookPath(adapter.Command); err == nil {
		return path, true
	}
	for _, alt := range adapter.FallbackCommands {
		if path, err := exec.LookPath(alt); err == nil {
			return path, true
		}
	}
	return "", false
}

// Detect probes PATH for each supported CLI.
func Detect() []Info {
	out := make([]Info, 0, len(adapters))
	for _, adapter := range adapters {
		info := Info{ID: adapter.ID, Name: adapter.Name}
		if path, ok := lookPath(adapter); ok {
			info.Path = path
			info.Available = true
		}
		out = append(out, info)
	}
	return out
}

// Find returns the adapter and executable path for an available agent ID.
func Find(id string) (Adapter, string, bool) {
	id = strings.ToLower(strings.TrimSpace(id))
	for _, adapter := range adapters {
		if adapter.ID != id {
			continue
		}
		path, ok := lookPath(adapter)
		if !ok {
			return Adapter{}, "", false
		}
		return adapter, path, true
	}
	return Adapter{}, "", false
}

// ExtractText pulls human-readable text from one line of CLI output. Claude's
// stream-json output is unwrapped; other CLIs emit plain text lines.
func ExtractText(id, line string) string {
	return ExtractStreamText(id, line, false)
}

// ExtractStreamText extracts text from one line of CLI output while avoiding
// duplicate final `result` payloads when Claude has already streamed assistant text.
func ExtractStreamText(id, line string, emitted bool) string {
	if id != "claude" {
		return line
	}
	var event struct {
		Type    string `json:"type"`
		Result  string `json:"result"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		return line
	}
	if event.Type == "result" || (event.Result != "" && len(event.Message.Content) == 0) {
		if emitted {
			return ""
		}
		return event.Result
	}
	var b strings.Builder
	for _, content := range event.Message.Content {
		if content.Type == "text" {
			b.WriteString(content.Text)
		}
	}
	return b.String()
}
