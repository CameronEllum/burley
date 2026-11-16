<script lang="ts">
  import type { SparkleAction } from '../lib/sparkle'

  interface Props {
    left: number
    top: number
    above: boolean
    width: number
    selection: string
    agentName: string
    model: string
    onaction: (action: SparkleAction, question?: string) => void
    onclose: () => void
  }

  let {
    left,
    top,
    above,
    width,
    selection,
    agentName,
    model,
    onaction,
    onclose,
  }: Props = $props()

  const QUICK: Array<{ id: SparkleAction; label: string; hint: string }> = [
    { id: 'explain', label: 'Explain', hint: 'What does this mean?' },
    { id: 'summarize', label: 'Summarize', hint: 'Condense into bullets' },
    { id: 'shorten', label: 'Shorten', hint: 'Tighten the wording' },
    { id: 'rewrite', label: 'Rewrite', hint: 'Polish and compare' },
  ]

  let question = $state('')

  const modelLabel = $derived(model ? (model.split('/').pop() ?? model) : '')
  const wordCount = $derived(selection.trim().split(/\s+/).filter(Boolean).length)

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
  style={`left:${left}px; top:${top}px; width:${width}px`}
>
  <header class="sparkle-head">
    <span class="sparkle-glyph" aria-hidden="true">✦</span>
    <span class="sparkle-agent">{agentName || 'Agent'}</span>
    {#if modelLabel}
      <span class="sparkle-model" title={`Pinned model: ${model}`}>{modelLabel}</span>
    {/if}
    <span class="sparkle-context">{wordCount} words selected</span>
    <span class="sparkle-spacer"></span>
    <button class="sparkle-close" title="Close (Esc)" aria-label="Close" onclick={onclose}>×</button>
  </header>

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

  <p class="sparkle-hint">Answers stream into the Talk panel.</p>
</div>

<style>
  .sparkle-popover {
    position: fixed;
    z-index: 120;
    transform: translate(-50%, -100%);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-strong);
    border-radius: 11px;
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
  .sparkle-model {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 9px;
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
    padding: 4px 10px 4px;
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
  .sparkle-hint {
    margin: 0;
    padding: 2px 12px 8px;
    color: var(--text-muted);
    font-size: 9.5px;
    letter-spacing: 0.01em;
  }
</style>
