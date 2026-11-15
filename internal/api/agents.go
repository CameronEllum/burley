package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"burley/internal/agent"
)

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Agent     string        `json:"agent"`
	Prompt    string        `json:"prompt"`
	Path      string        `json:"path"`
	Mode      string        `json:"mode"` // ask | edit
	Selection string        `json:"selection"`
	History   []chatMessage `json:"history"`
}

func (s *server) handleAgents(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"agents": agent.Detect()})
}

// handleAgentModels lists the models a CLI can serve and reports the pinned one.
// Detection failures are returned in-band so the UI can fall back to manual input.
func (s *server) handleAgentModels(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("agent")))
	if id == "" {
		writeError(w, http.StatusBadRequest, "agent is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()

	models, err := agent.Models(ctx, id, s.opts.Root)
	if models == nil {
		models = []string{}
	}
	pinned := ""
	if settings, _, readErr := s.vault.ReadSettings(ctx); readErr == nil {
		pinned = settings.AgentModels[id]
	}
	payload := map[string]any{
		"agent":       id,
		"models":      models,
		"pinned":      pinned,
		"unsupported": errors.Is(err, agent.ErrModelsUnsupported),
	}
	if err != nil {
		payload["error"] = err.Error()
	}
	writeJSON(w, http.StatusOK, payload)
}

// handleAgentChat runs a local CLI and streams its output over SSE.
func (s *server) handleAgentChat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	if req.Prompt == "" {
		writeError(w, http.StatusBadRequest, "prompt is required")
		return
	}
	if len(req.Prompt) > 20000 {
		writeError(w, http.StatusBadRequest, "prompt is too long")
		return
	}
	adapter, executable, ok := agent.Find(req.Agent)
	if !ok {
		writeError(w, http.StatusNotFound, "agent is not installed: "+req.Agent)
		return
	}
	pinnedModel := ""
	if settings, _, err := s.vault.ReadSettings(r.Context()); err == nil {
		pinnedModel = settings.AgentModels[adapter.ID]
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode != "edit" {
		mode = "ask"
	}

	var fileBefore string
	var fileHashBefore string
	if req.Path != "" {
		if data, err := s.vault.Read(r.Context(), req.Path); err == nil {
			fileBefore = data.Content
			fileHashBefore = data.Hash
		}
	}

	prompt := buildAgentPrompt(req, fileBefore, mode)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()

	argsPrompt := prompt
	if adapter.StdinPrompt {
		argsPrompt = ""
	}
	cmd := exec.CommandContext(ctx, executable, adapter.Args(argsPrompt, pinnedModel)...)
	cmd.Dir = s.opts.Root
	if adapter.StdinPrompt {
		cmd.Stdin = strings.NewReader(prompt)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent pipe: "+err.Error())
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		writeError(w, http.StatusInternalServerError, "agent start: "+err.Error())
		return
	}

	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	send := func(event string, payload any) {
		data, err := json.Marshal(payload)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	send("meta", map[string]any{"agent": adapter.ID, "mode": mode, "path": req.Path, "model": pinnedModel})

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4<<20)
	emitted := false
	for scanner.Scan() {
		text := agent.ExtractText(adapter.ID, scanner.Text())
		if text == "" {
			continue
		}
		emitted = true
		send("delta", map[string]string{"text": text})
	}
	scanErr := scanner.Err()
	waitErr := cmd.Wait()

	if waitErr != nil && ctx.Err() == nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = waitErr.Error()
		}
		send("error", map[string]string{"message": message})
		return
	}
	if scanErr != nil && !emitted {
		send("error", map[string]string{"message": scanErr.Error()})
		return
	}

	if mode == "edit" && req.Path != "" {
		if data, err := s.vault.Read(r.Context(), req.Path); err == nil && data.Hash != fileHashBefore {
			send("done", map[string]any{"file": data})
			return
		}
	}
	send("done", map[string]any{})
}

func buildAgentPrompt(req chatRequest, fileContent, mode string) string {
	var b strings.Builder
	if mode == "edit" {
		b.WriteString("You are Burley's editing assistant. You may modify the current Markdown file on disk when the user asks for a change. Keep edits minimal and preserve unrelated formatting.\n\n")
	} else {
		b.WriteString("You are Burley's read-only research assistant. Answer questions about the current Markdown file. Do not modify any files.\n\n")
	}
	if req.Path != "" {
		b.WriteString("Current file: ")
		b.WriteString(req.Path)
		b.WriteString("\n")
		if fileContent != "" {
			content := fileContent
			if len(content) > 24000 {
				content = content[:24000] + "\n…[truncated]"
			}
			b.WriteString("Current file content:\n```markdown\n")
			b.WriteString(content)
			b.WriteString("\n```\n")
		}
	}
	if strings.TrimSpace(req.Selection) != "" {
		selection := req.Selection
		if len(selection) > 4000 {
			selection = selection[:4000] + "…"
		}
		b.WriteString("\nSelected text:\n```\n")
		b.WriteString(selection)
		b.WriteString("\n```\n")
	}
	if len(req.History) > 0 {
		b.WriteString("\nConversation so far:\n")
		start := 0
		if len(req.History) > 8 {
			start = len(req.History) - 8
		}
		for _, message := range req.History[start:] {
			role := message.Role
			if role != "assistant" {
				role = "user"
			}
			fmt.Fprintf(&b, "%s: %s\n", strings.Title(role), message.Content)
		}
	}
	b.WriteString("\nUser: ")
	b.WriteString(req.Prompt)
	b.WriteString("\n")
	if mode == "edit" {
		b.WriteString("Make the requested file changes now. Do not print the entire file unless asked.\n")
	}
	return b.String()
}
