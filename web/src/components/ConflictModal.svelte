<script lang="ts">
  import type { FileData } from '../lib/api'

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

  const changedAt = $derived(
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(theirs.modTime)),
  )

  const mineLines = $derived(mine.split('\n').length)
  const theirsLines = $derived(theirsText.split('\n').length)
</script>

<div class="modal-backdrop" role="presentation">
  <div class="modal conflict-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
    <header class="conflict-head">
      <span class="warn" aria-hidden="true">⚠</span>
      <div>
        <h2 id="conflict-title">File changed on disk</h2>
        <p>
          <code>{path}</code> was modified outside Burley at {changedAt}. Nothing has been overwritten — choose how to
          resolve the conflict.
        </p>
      </div>
    </header>

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
    gap: 12px;
    padding: 18px 20px 12px;
    border-bottom: 1px solid var(--border-soft);
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
