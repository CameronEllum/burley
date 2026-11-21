package agent

import (
	"strings"
	"testing"
)

func TestParseModelList(t *testing.T) {
	raw := "\x1b[32mopencode-go/deepseek-v4.1-flash\x1b[0m\r\n" +
		"  opencode-go/deepseek-v4-pro  \n" +
		"\n" +
		"not a model\n" +
		"opencode-go/deepseek-v4.1-flash\n" +
		"anthropic/claude-sonnet-5-5\n"
	models := ParseModelList(raw)
	want := []string{
		"anthropic/claude-sonnet-5-5",
		"opencode-go/deepseek-v4-pro",
		"opencode-go/deepseek-v4.1-flash",
	}
	if len(models) != len(want) {
		t.Fatalf("models = %v, want %v", models, want)
	}
	for i := range want {
		if models[i] != want[i] {
			t.Fatalf("models = %v, want %v", models, want)
		}
	}
}

func adapterByID(id string) (Adapter, bool) {
	for _, adapter := range adapters {
		if adapter.ID == id {
			return adapter, true
		}
	}
	return Adapter{}, false
}

func TestAdapterArgsPinModel(t *testing.T) {
	cases := []struct {
		id    string
		flag  string
		first string
	}{
		{id: "opencode", flag: "--model", first: "run"},
		{id: "claude", flag: "--model", first: "-p"},
		{id: "gemini", flag: "-m", first: "-p"},
		{id: "codex", flag: "-m", first: "exec"},
	}
	for _, tc := range cases {
		adapter, ok := adapterByID(tc.id)
		if !ok {
			t.Fatalf("adapter %s missing", tc.id)
		}
		plain := adapter.Args("hello", "")
		if plain[0] != tc.first {
			t.Fatalf("%s plain args = %v", tc.id, plain)
		}
		if contains(plain, tc.flag) {
			t.Fatalf("%s plain args should not pin a model: %v", tc.id, plain)
		}
		pinned := adapter.Args("hello", "provider/model")
		index := indexOf(pinned, tc.flag)
		if index < 0 || index+1 >= len(pinned) || pinned[index+1] != "provider/model" {
			t.Fatalf("%s pinned args = %v", tc.id, pinned)
		}
		if !contains(pinned, "hello") {
			t.Fatalf("%s pinned args lost the prompt: %v", tc.id, pinned)
		}
	}
}

func TestClaudeStreamJSONIncludesVerbose(t *testing.T) {
	adapter, ok := adapterByID("claude")
	if !ok {
		t.Fatal("claude adapter missing")
	}
	args := adapter.Args("hello", "")
	if !contains(args, "--verbose") {
		t.Fatalf("claude args missing --verbose for stream-json: %v", args)
	}
}

func TestClaudeStreamJSONSkipsDuplicateResult(t *testing.T) {
	assistantLine := `{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}`
	resultLine := `{"type":"result","subtype":"success","result":"Hello world"}`

	if got := ExtractStreamText("claude", assistantLine, false); got != "Hello world" {
		t.Fatalf("assistant line = %q, want %q", got, "Hello world")
	}
	if got := ExtractStreamText("claude", resultLine, true); got != "" {
		t.Fatalf("result line after emitted assistant text = %q, want empty", got)
	}
	if got := ExtractStreamText("claude", resultLine, false); got != "Hello world" {
		t.Fatalf("result line when nothing emitted = %q, want %q", got, "Hello world")
	}
}

func TestOpenCodePromptsViaStdin(t *testing.T) {
	adapter, _ := adapterByID("opencode")
	if !adapter.StdinPrompt {
		t.Fatal("opencode should send the prompt over stdin")
	}
	for _, other := range adapters {
		if other.ID != "opencode" && other.StdinPrompt {
			t.Fatalf("%s should pass the prompt in argv", other.ID)
		}
	}
}

func TestOnlyOpenCodeListsModels(t *testing.T) {
	for _, adapter := range adapters {
		if adapter.ID == "opencode" {
			if strings.Join(adapter.ModelsArgs, " ") != "models" {
				t.Fatalf("opencode models args = %v", adapter.ModelsArgs)
			}
			continue
		}
		if len(adapter.ModelsArgs) != 0 {
			t.Fatalf("%s unexpectedly lists models via %v", adapter.ID, adapter.ModelsArgs)
		}
	}
}

func contains(values []string, target string) bool {
	return indexOf(values, target) >= 0
}

func indexOf(values []string, target string) int {
	for i, value := range values {
		if value == target {
			return i
		}
	}
	return -1
}
