// Package syntax embeds Burley's specialized Markdown flavour reference so the
// CLI, Talk agent prompts, and vault documentation stay in sync.
package syntax

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed SYNTAX.md
var Full string

// Compact is a token-minimal summary injected into Talk agent prompts.
const Compact = `Burley Markdown extensions:
- Comments (invisible in GitHub): <!-- edit -->text<!-- /edit @user (YYYY-MM-DD): note --> or point <!-- edit @user (YYYY-MM-DD): note -->; threaded <!-- discussion -->text<!-- /discussion @user (YYYY-MM-DD): msg --> (replies: > @user (YYYY-MM-DD): reply; escape -- as -&#45;). When applying edit comments, update prose and remove the edit tags; keep discussion threads unless asked.
- Colours: ==highlight==, [text]{.green}/{.bg-amber}/{color=#hex bg=#hex}, table cell prefix {.red} text.
- Math: $...$ or \(...\) inline; $$...$$ or \[...\] display.
- Fences: table (src: ./file.csv), plotly (src: ./spec.json), mermaid, lua. Slides split on ---.`

const (
	markerStart = "<!-- burley-syntax:start -->"
	markerEnd   = "<!-- burley-syntax:end -->"
)

// WriteAgentDocs creates or updates the Burley syntax section in <root>/AGENTS.md.
func WriteAgentDocs(root string) (string, error) {
	target := filepath.Join(root, "AGENTS.md")
	section := markerStart + "\n" + strings.TrimSpace(Full) + "\n" + markerEnd

	existingBytes, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return "", fmt.Errorf("read %s: %w", target, err)
	}

	var next string
	existing := string(existingBytes)
	if start := strings.Index(existing, markerStart); start >= 0 {
		if end := strings.Index(existing[start:], markerEnd); end >= 0 {
			endIdx := start + end + len(markerEnd)
			next = existing[:start] + section + existing[endIdx:]
		}
	}
	if next == "" {
		trimmed := strings.TrimRight(existing, "\r\n")
		if trimmed == "" {
			next = section + "\n"
		} else {
			next = trimmed + "\n\n" + section + "\n"
		}
	}

	if err := os.WriteFile(target, []byte(next), 0o644); err != nil {
		return "", fmt.Errorf("write %s: %w", target, err)
	}
	return target, nil
}
