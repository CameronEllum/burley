<script lang="ts">
  import { renderMarkdown } from '../lib/markdown'
  import { wordDiff } from '../lib/diff'
  import { cleanSuggestion, type SparkleAction } from '../lib/sparkle'

  interface Props {
    left: number
    top: number
    above: boolean
    width: number
    maxHeight: number
    selection: string
    agentName: string
    busy: boolean
    action: SparkleAction | ''
    output: string
    error: string
    canEdit: boolean
    onaction: (action: SparkleAction, question?: string) => void
    onreset: () => void
    onreplace: () => void
    oninsert: () => void
    oncopy: () => void
    ontalk: () => void
    onstop: () => void
    onclose: () => void
  }

  let {
    left,
    top,
    above,
    width,
    maxHeight,
    selection,
    agentName,
    busy,
    action,
    output,
    error,
    canEdit,
    onaction,
    onreset,
    onreplace,
    oninsert,
    oncopy,
    ontalk,
    onstop,
    onclose,
  }: Props = $props()

  const QUICK: Array<{ id: SparkleAction; label: string; hint: string }> = [
    { id: 'explain', label: 'Explain', hint: 'What does this mean?' },
    { id: 'summarize', label: 'Summarize', hint: 'Condense into bullets' },
    { id: 'shorten', label: 'Shorten', hint: 'Tighten the wording' },
    { id: 'rewrite', label: 'Rewrite', hint: 'Polish and compare' },
  ]

  const LABELS: Record<SparkleAction, string> = {
    ask: 'Answer',
    explain: 'Explanation',
    summarize: 'Summary',
    shorten: 'Shortened version',
    rewrite: 'Suggested rewrite',
  }

  let question = $state('')

  function clean(text: string): string {
    return cleanSuggestion(text)
  }

  const diff = $derived(action === 'rewrite' && output ? wordDiff(selection, clean(output)) : [])

  function submitQuestion(event: SubmitEvent) {
    event.preventDefault()
    const text = question.trim()
    if (!text) return
    onaction('ask', text)
    question = ''
  }
</script>

<div
  class="sparkle-popover"
  class:below={!above}
  role="dialog"
  aria-label="AI actions for the selection"
  style={`left:${left}px; top:${top}px; width:${width}px; max-height:${maxHeight}px`}
>
  <header class="sparkle-head">
    <span class="sparkle-glyph" aria-hidden="true">✦</span>
    <span class="sparkle-agent">{agentName || 'Agent'}</span>
    <span class="sparkle-context">{selection.trim().split(/\s+/).length} words selected</span>
    <span class="sparkle-spacer"></span>
    <button class="sparkle-close" title="Close (Esc)" aria-label="Close" onclick={onclose}>×</button>
  </header>

  {#if !action}
    <div class="sparkle-actions">
      {#each QUICK as item (item.id)}
        <button class="sparkle-action" title={item.hint} onclick={() => onaction(item.id)}>
          {item.label}
        </button>
      {/each}
    </div>
    <form class="sparkle-ask" onsubmit={submitQuestion}>
      <input
        class="sparkle-input"
        bind:value={question}
        placeholder="Ask about this selection…"
        aria-label="Ask about this selection"
      />
      <button class="sparkle-send" type="submit" disabled={!question.trim()}>Ask</button>
    </form>
  {:else}
    <div class="sparkle-result">
      <div class="sparkle-result-head">
        <span>{LABELS[action]}</span>
        {#if busy}<span class="sparkle-typing">working…</span>{/if}
      </div>
      {#if action === 'rewrite' && output}
        <div class="sparkle-diff">
          {#each diff as part, i (i)}
            <span
              class:sparkle-add={part.kind === 'add'}
              class:sparkle-del={part.kind === 'del'}
            >{part.text}</span>
          {/each}
        </div>
      {:else if output}
        <div class="sparkle-markdown">{@html renderMarkdown(output)}</div>
      {:else if busy}
        <div class="sparkle-typing-block">Thinking…</div>
      {/if}
      {#if error}<p class="sparkle-error">{error}</p>{/if}
    </div>
    <footer class="sparkle-foot">
      {#if busy}
        <button class="sparkle-btn" onclick={onstop}>Stop</button>
      {:else}
        {#if action === 'rewrite' && output && canEdit}
          <button class="sparkle-btn primary" onclick={onreplace}>Replace selection</button>
        {/if}
        {#if output && canEdit}
          <button class="sparkle-btn" onclick={oninsert}>Insert below</button>
        {/if}
        {#if output}
          <button class="sparkle-btn" onclick={oncopy}>Copy</button>
        {/if}
        <button class="sparkle-btn" onclick={ontalk}>Open in Talk</button>
        <span class="sparkle-spacer"></span>
        <button class="sparkle-btn ghost" onclick={onreset}>Back</button>
      {/if}
    </footer>
  {/if}
</div>

<style>
  .sparkle-popover {
    position: fixed;
    z-index: 120;
    transform: translate(-50%, -100%);
    display: flex;
    flex-direction: column;
    max-height: min(460px, 70vh);
    border: 1px solid var(--border-strong);    border-radius: 11px;
    background: color-mix(in srgb, var(--bg-chrome) 96%, transparent);
    color: var(--text-primary);
    box-shadow: 0 22px 60px -24px rgb(0 0 0 / 0.55);
    backdrop-filter: blur(8px);
    overflow: hidden;
    animation: sparkle-in 120ms ease-out;
  }
  .sparkle-popover.below {
    transform: translate(-50%, 0);
    animation-name: sparkle-in-below;
  }
  @keyframes sparkle-in {
    from {
      opacity: 0;
      transform: translate(-50%, calc(-100% + 4px));
    }
    to {
      opacity: 1;
    }
  }
  @keyframes sparkle-in-below {
    from {
      opacity: 0;
      transform: translate(-50%, 4px);
    }
    to {
      opacity: 1;
    }
  }
  .sparkle-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px 6px 11px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-app);
    font-size: 10.5px;
    letter-spacing: 0.02em;
    color: var(--text-muted);
  }
  .sparkle-glyph {
    color: var(--accent);
    font-size: 13px;
  }
  .sparkle-agent {
    font-weight: 700;
    color: var(--text-primary);
  }
  .sparkle-context {
    opacity: 0.8;
  }
  .sparkle-spacer {
    flex: 1;
  }
  .sparkle-close {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 15px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .sparkle-close:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .sparkle-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 10px 6px;
  }
  .sparkle-action {
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 11px;
    cursor: pointer;
  }
  .sparkle-action:hover {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--active);
  }
  .sparkle-ask {
    display: flex;
    gap: 6px;
    padding: 4px 10px 10px;
  }
  .sparkle-input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    padding: 5px 8px;
    outline: none;
  }
  .sparkle-input:focus {
    border-color: var(--accent);
  }
  .sparkle-send {
    border: 1px solid var(--accent);
    border-radius: 7px;
    background: var(--accent);
    color: #fff;
    font: inherit;
    font-size: 11.5px;
    font-weight: 700;
    padding: 4px 10px;
    cursor: pointer;
  }
  .sparkle-send:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .sparkle-result {
    flex: 1;
    min-height: 0;
    padding: 9px 12px;
    overflow-y: auto;
  }
  .sparkle-result-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 5px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    color: var(--text-muted);
  }
  .sparkle-typing {
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
    color: var(--accent);
  }
  .sparkle-typing-block {
    color: var(--text-muted);
    font-size: 12px;
    padding: 4px 0;
  }
  .sparkle-markdown {
    font-size: 13px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .sparkle-markdown :global(*:first-child) {
    margin-top: 0;
  }
  .sparkle-markdown :global(*:last-child) {
    margin-bottom: 0;
  }
  .sparkle-diff {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 260px;
    overflow-y: auto;
    font-size: 12.8px;
    line-height: 1.6;
    padding: 2px 0;
  }
  .sparkle-add {
    background: var(--ok-bg);
    color: var(--ok-fg);
    border-radius: 3px;
  }
  .sparkle-del {
    background: var(--danger-bg);
    color: var(--danger-fg);
    text-decoration: line-through;
    border-radius: 3px;
  }
  .sparkle-error {
    margin: 6px 0 0;
    color: var(--danger-fg);
    font-size: 12px;
  }
  .sparkle-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 7px 10px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-app);
  }
  .sparkle-btn {
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    padding: 4px 8px;
    cursor: pointer;
  }
  .sparkle-btn:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .sparkle-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .sparkle-btn.primary:hover {
    background: var(--accent-strong);
    color: #fff;
  }
  .sparkle-btn.ghost {
    border-color: transparent;
  }
</style>
