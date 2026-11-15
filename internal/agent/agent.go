// Package agent detects local CLI agents and builds non-interactive invocations.
package agent

import (
	"encoding/json"
	"os/exec"
	"strings"
)

// Adapter describes a CLI that can answer prompts headlessly.
type Adapter struct {
	ID      string
	Name    string
	Command string
	// Args builds the non-interactive invocation. model is empty when the user
	// follows the CLI's own default.
	Args func(prompt, model string) []string
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
			args := []string{"-p", prompt, "--output-format", "stream-json"}
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
			return append(args, prompt)
		},
		ModelsArgs: []string{"models"},
	},
}

// Adapters returns the supported adapter table.
func Adapters() []Adapter {
	return adapters
}

// Detect probes PATH for each supported CLI.
func Detect() []Info {
	out := make([]Info, 0, len(adapters))
	for _, adapter := range adapters {
		info := Info{ID: adapter.ID, Name: adapter.Name}
		if path, err := exec.LookPath(adapter.Command); err == nil {
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
		path, err := exec.LookPath(adapter.Command)
		if err != nil {
			return Adapter{}, "", false
		}
		return adapter, path, true
	}
	return Adapter{}, "", false
}

// ExtractText pulls human-readable text from one line of CLI output. Claude's
// stream-json output is unwrapped; other CLIs emit plain text lines.
func ExtractText(id, line string) string {
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
	if event.Result != "" {
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
