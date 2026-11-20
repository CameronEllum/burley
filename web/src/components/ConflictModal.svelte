<script lang="ts">
  import type { FileData } from '../lib/api'
  import { lineDiff } from '../lib/diff'

  let {
    path,
    mine,
    theirs,
    theirsText,
    onkeep,
    ontheirs,
    onclose,
  }: {
    path: string
    mine: string
    theirs: FileData
    theirsText: string
    onkeep: () => void
    ontheirs: () => void
    onclose: () => void
  } = $props()

  let viewMode = $state<'diff' | 'split'>('diff')

  const changedAt = $derived(
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(theirs.modTime)),
  )

  const mineLines = $derived(mine.split('\n').length)
  const theirsLines = $derived(theirsText.split('\n').length)
  const diffRows = $derived(lineDiff(mine, theirsText))
  const addedCount = $derived(diffRows.filter((r) => r.kind === 'add').length)
  const removedCount = $derived(diffRows.filter((r) => r.kind === 'del').length)
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal conflict-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
    <header class="conflict-head">
      <span class="warn" aria-hidden="true">⚠</span>
      <div class="head-copy">
        <h2 id="conflict-title">File changed on disk</h2>
        <p>
          <code>{path}</code> was modified outside Burley at {changedAt}. Nothing has been overwritten — choose how to
          resolve the conflict.
        </p>
      </div>
      <div class="mode-switch" role="tablist" aria-label="Conflict view">
        <button
          type="button"
          class="mode-btn"
          class:active={viewMode === 'diff'}
          role="tab"
          aria-selected={viewMode === 'diff'}
          onclick={() => (viewMode = 'diff')}
        >
          Visual diff
        </button>
        <button
          type="button"
          class="mode-btn"
          class:active={viewMode === 'split'}
          role="tab"
          aria-selected={viewMode === 'split'}
          onclick={() => (viewMode = 'split')}
        >
          Side by side
        </button>
      </div>
    </header>

    {#if viewMode === 'diff'}
      <div class="diff-pane">
        <div class="diff-summary">
          <span>Comparing <strong>Yours (unsaved)</strong> → <strong>On disk</strong></span>
          <span class="diff-counts">
            <span class="count-del">-{removedCount}</span>
            <span class="count-add">+{addedCount}</span>
          </span>
        </div>
        <div class="diff-scroll" role="region" aria-label="Visual line diff">
          {#each diffRows as row}
            <div class={`diff-row ${row.kind}`}>
              <span class="ln">{row.oldLine ?? ''}</span>
              <span class="ln">{row.newLine ?? ''}</span>
              <span class="sigil">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
              <span class="line-text">{row.text || ' '}</span>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div class="columns">
        <section class="column">
          <h3>Yours (unsaved) <span>{mineLines} lines</span></h3>
          <pre>{mine}</pre>
        </section>
        <section class="column">
          <h3>On disk <span>{theirsLines} lines</span></h3>
          <pre>{theirsText}</pre>
        </section>
      </div>
    {/if}

    <footer class="conflict-actions">
      <button class="ghost" onclick={onclose}>Decide later</button>
      <span class="grow"></span>
      <button class="secondary" onclick={ontheirs}>Take theirs</button>
      <button class="primary" onclick={onkeep}>Keep mine &amp; overwrite</button>
    </footer>
  </div>
</div>

<style>
  .conflict-modal {
    width: min(980px, calc(100vw - 40px));
    max-height: 86vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .conflict-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 18px 20px 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .head-copy {
    flex: 1;
    min-width: 0;
  }
  .mode-switch {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 2px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--border-soft);
    gap: 2px;
  }
  .mode-btn {
    padding: 4px 10px;
    font-size: 11.5px;
    font-weight: 600;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
  }
  .mode-btn.active {
    background: var(--bg-app);
    color: var(--text-primary);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }
  .diff-pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .diff-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 14px;
    font-size: 12px;
    color: var(--text-muted);
    background: var(--panel);
    border-bottom: 1px solid var(--border-soft);
  }
  .diff-counts {
    display: inline-flex;
    gap: 8px;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .count-add {
    color: var(--ok-fg);
  }
  .count-del {
    color: var(--danger-fg);
  }
  .diff-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .diff-row {
    display: grid;
    grid-template-columns: 42px 42px 20px 1fr;
    padding: 0 10px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .diff-row.add {
    background: var(--ok-bg);
    color: var(--ok-fg);
  }
  .diff-row.del {
    background: var(--danger-bg);
    color: var(--danger-fg);
  }
  .diff-row .ln {
    padding: 1px 6px;
    text-align: right;
    color: var(--text-muted);
    user-select: none;
    opacity: 0.7;
  }
  .diff-row .sigil {
    text-align: center;
    font-weight: 700;
    user-select: none;
  }
  .diff-row .line-text {
    padding: 1px 4px;
  }
  .warn {
    font-size: 20px;
    color: var(--warn-fg);
    line-height: 1.2;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 650;
  }
  .conflict-head p {
    margin: 0;
    color: var(--text-muted);
    font-size: 12.5px;
    line-height: 1.5;
  }
  code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    background: var(--panel);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    background: var(--border-soft);
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }
  .column {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-app);
  }
  h3 {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    margin: 0;
    padding: 8px 14px;
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-soft);
  }
  h3 span {
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
  }
  pre {
    margin: 0;
    padding: 12px 14px;
    overflow: auto;
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .conflict-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-soft);
    background: var(--panel);
  }
  .grow {
    flex: 1;
  }
  button {
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 7px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .ghost {
    background: transparent;
    color: var(--text-muted);
    border-color: transparent;
  }
  .ghost:hover {
    background: var(--hover);
  }
  .secondary {
    background: var(--panel);
    color: var(--text-primary);
    border-color: var(--border-strong);
  }
  .secondary:hover {
    background: var(--hover);
  }
  .primary {
    background: var(--accent);
    color: #fff;
  }
  .primary:hover {
    background: var(--accent-strong);
  }
</style>
