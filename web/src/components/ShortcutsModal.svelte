<script lang="ts">
  let { onclose }: { onclose: () => void } = $props()

  const groups = [
    {
      title: 'Navigation',
      items: [
        ['Ctrl P / F1', 'Quick-open palette'],
        ['Ctrl Shift O', 'Palette in heading mode (@)'],
        ['Ctrl Shift F', 'Palette in content-search mode (?)'],
        ['Ctrl Enter', 'Open highlighted file in a new tab'],
        ['Alt T', 'Toggle the Talk panel'],
        ['Alt Enter', 'Send the selection to the Talk panel'],
        ['Ctrl ?', 'Show this shortcut sheet'],
        ['Ctrl Shift Z', 'Toggle Zen focus mode'],
      ],
    },
    {
      title: 'Editing',
      items: [
        ['Ctrl S', 'Save now (autosave is debounced)'],
        ['Escape', 'Close a dialog, or exit the element under the caret'],
        ['Select text', 'AI actions in the sparkle bar (when an agent is installed)'],
        ['/', 'Slash commands: plotly, mermaid, math, table, callout, code, date, lua'],
        ['Ctrl B', 'Toggle the file tree'],
        ['Ctrl Shift R', 'Reload the file tree'],
        ['Ctrl / Cmd Click', 'Reveal a rendered link’s Markdown source'],
        ['Tab / Shift Tab', 'Move between table cells'],
        ['Up / Down', 'Move between table rows'],
      ],
    },
    {
      title: 'Mouse',
      items: [
        ['Right-click a file', 'Delete the note (with confirmation)'],
        ['Alt-click an image', 'Open the figure viewer (arrows browse)'],
        ['Drag the divider', 'Resize the sidebar'],
        ['Double-click the divider', 'Reset the sidebar width'],
      ],
    },
  ]
</script>

<div
  class="modal-backdrop"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <div class="modal shortcuts-modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
    <header class="shortcuts-head">
      <h2 id="shortcuts-title">Keyboard shortcuts</h2>
      <button class="shortcuts-close" aria-label="Close shortcuts" onclick={onclose}>Esc</button>
    </header>

    <div class="shortcuts-body">
      {#each groups as group}
        <section>
          <h3>{group.title}</h3>
          <dl>
            {#each group.items as [keys, label]}
              <div class="shortcut-row">
                <dt>{label}</dt>
                <dd><kbd>{keys}</kbd></dd>
              </div>
            {/each}
          </dl>
        </section>
      {/each}
    </div>

    <footer class="shortcuts-foot">
      <span>Press <kbd>Ctrl ?</kbd> anywhere, or <kbd>?</kbd> when not typing.</span>
      <span class="grow"></span>
      <button class="secondary" onclick={onclose}>Done</button>
    </footer>
  </div>
</div>

<style>
  .shortcuts-modal {
    width: min(680px, calc(100vw - 36px));
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .shortcuts-head {
    display: flex;
    align-items: center;
    padding: 16px 18px 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  .shortcuts-head h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 650;
  }
  .shortcuts-close {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .shortcuts-close:hover {
    background: var(--hover);
  }
  .shortcuts-body {
    overflow-y: auto;
    padding: 8px 20px 14px;
    columns: 2;
    column-gap: 28px;
  }
  section {
    break-inside: avoid;
    padding-top: 8px;
  }
  h3 {
    margin: 4px 0 6px;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
  }
  dl {
    margin: 0 0 12px;
  }
  .shortcut-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 5px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  dt {
    flex: 1;
    font-size: 12.5px;
    line-height: 1.45;
  }
  dd {
    margin: 0;
    flex: 0 0 auto;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 2px 6px;
    border-radius: 5px;
    border: 1px solid var(--border-soft);
    background: var(--panel);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .shortcuts-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-muted);
    font-size: 11px;
  }
  .grow {
    flex: 1;
  }
  @media (max-width: 640px) {
    .shortcuts-body {
      columns: 1;
    }
  }
</style>
