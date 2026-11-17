package agent

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
)

// ErrModelsUnsupported means the CLI has no way to enumerate its models.
var ErrModelsUnsupported = errors.New("agent does not expose a model list")

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

// Models runs the adapter's model-listing command inside dir and returns the
// catalog IDs it printed. dir scopes availability the same way chat does.
func Models(ctx context.Context, id, dir string) ([]string, error) {
	adapter, executable, ok := Find(id)
	if !ok {
		return nil, fmt.Errorf("agent is not installed: %s", id)
	}
	if len(adapter.ModelsArgs) == 0 {
		return nil, ErrModelsUnsupported
	}
	cmd := exec.CommandContext(ctx, executable, adapter.ModelsArgs...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		message := ""
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			message = strings.TrimSpace(string(exit.Stderr))
		}
		if message == "" {
			message = err.Error()
		}
		return nil, errors.New(message)
	}
	return ParseModelList(string(out)), nil
}

// StripANSI removes terminal escape sequences from CLI output.
func StripANSI(s string) string {
	return ansiEscape.ReplaceAllString(s, "")
}

// ParseModelList keeps one model ID per line, strips ANSI codes and noise, and
// sorts the result so providers stay grouped.
func ParseModelList(raw string) []string {
	seen := make(map[string]struct{})
	models := make([]string, 0)
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(StripANSI(strings.TrimSuffix(line, "\r")))
		if line == "" || !strings.Contains(line, "/") || strings.ContainsAny(line, " \t") {
			continue
		}
		if _, ok := seen[line]; ok {
			continue
		}
		seen[line] = struct{}{}
		models = append(models, line)
	}
	sort.Strings(models)
	return models
}
