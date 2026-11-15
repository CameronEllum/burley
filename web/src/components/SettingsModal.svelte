<script lang="ts">
  import type { AppSettings } from '../lib/api'

  let {
    settings,
    onchange,
    onclose,
  }: {
    settings: AppSettings
    onchange: (patch: Partial<AppSettings>) => void
    onclose: () => void
  } = $props()

  let tab = $state<'behaviour' | 'appearance'>('behaviour')

  const styles = [
    { id: 'default', name: 'Default', description: 'Warm, balanced reading view' },
    { id: 'github', name: 'GitHub', description: 'Underlined H1/H2, dense headings' },
    { id: 'academic', name: 'Academic', description: 'Serif type, generous line height' },
    { id: 'compact', name: 'Compact', description: 'Smaller type, tighter spacing' },
  ] as const
</script>

<div
  class="modal-backdrop"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <header class="settings-head">
      <h2 id="settings-title">Settings</h2>
      <button class="settings-close" aria-label="Close settings" onclick={onclose}>Esc</button>
    </header>

    <div class="settings-tabs" role="tablist">
      <button
        class="settings-tab"
        class:active={tab === 'behaviour'}
        role="tab"
        aria-selected={tab === 'behaviour'}
        onclick={() => (tab = 'behaviour')}>Behaviour</button
      >
      <button
        class="settings-tab"
        class:active={tab === 'appearance'}
        role="tab"
        aria-selected={tab === 'appearance'}
        onclick={() => (tab = 'appearance')}>Appearance</button
      >
    </div>

    <div class="settings-body">
      {#if tab === 'behaviour'}
        <section class="settings-section">
          <h3>Editing</h3>
          <label class="setting-row">
            <span>
              <strong>Auto-save</strong>
              <small>Save 1.5 s after typing stops. Turn off to save only with Ctrl+S.</small>
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={settings.autoSave}
              onchange={(event) => onchange({ autoSave: event.currentTarget.checked })}
            />
          </label>
          <label class="setting-row">
            <span>
              <strong>Ctrl/Cmd-click on links</strong>
              <small>Choose whether modified-click edits the Markdown or opens the link.</small>
            </span>
            <select
              class="setting-select"
              value={settings.ctrlClickLink}
              onchange={(event) =>
                onchange({ ctrlClickLink: event.currentTarget.value as 'toggle' | 'open' })}
            >
              <option value="toggle">Toggle Markdown</option>
              <option value="open">Open link</option>
            </select>
          </label>
        </section>
      {:else}
        <section class="settings-section">
          <h3>Theme</h3>
          <div class="segmented theme-segments">
            {#each ['light', 'dark', 'system'] as const as option}
              <button
                class="segment"
                class:active={settings.theme === option}
                onclick={() => onchange({ theme: option })}
              >{option === 'system' ? 'System' : option === 'light' ? 'Light' : 'Dark'}</button
              >
            {/each}
          </div>

          <h3>Reading width</h3>
          <div class="segmented width-segments">
            <button
              class="segment"
              class:active={!settings.wideMode}
              onclick={() => onchange({ wideMode: false })}>Narrow</button
            >
            <button
              class="segment"
              class:active={settings.wideMode}
              onclick={() => onchange({ wideMode: true })}>Wide</button
            >
          </div>

          <h3>Markdown style</h3>
          <div class="style-grid">
            {#each styles as style}
              <button
                class="style-card"
                class:active={settings.markdownStyle === style.id}
                onclick={() => onchange({ markdownStyle: style.id })}
              >
                <span class="style-name">{style.name}</span>
                <span class="style-description">{style.description}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>

    <footer class="settings-foot">
      <span>Stored in <code>.burley/settings.yaml</code></span>
      <span class="grow"></span>
      <button class="secondary" onclick={onclose}>Done</button>
    </footer>
  </div>
</div>

<style>
  .settings-modal {
    width: min(600px, calc(100vw - 36px));
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .settings-head {
    display: flex;
    align-items: center;
    padding: 16px 18px 10px;
  }
  .settings-head h2 {
    margin: 0;
    font-size: 17px;
    font-weight: 650;
  }
  .settings-close {
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
  .settings-close:hover {
    background: var(--hover);
  }
  .settings-tabs {
    display: flex;
    gap: 2px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .settings-tab {
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    padding: 8px 12px;
    cursor: pointer;
  }
  .settings-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .settings-body {
    overflow-y: auto;
    padding: 14px 20px 18px;
  }
  .settings-section h3 {
    margin: 6px 0 8px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--text-muted);
  }
  .settings-section h3:not(:first-child) {
    margin-top: 20px;
  }
  .setting-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-soft);
  }
  .setting-row:last-child {
    border-bottom: 0;
  }
  .setting-row span {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
  }
  .setting-row strong {
    font-size: 13px;
    font-weight: 600;
  }
  .setting-row small {
    color: var(--text-muted);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .switch {
    appearance: none;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--border-strong);
    position: relative;
    cursor: pointer;
    transition: background 0.15s ease;
    flex: 0 0 auto;
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }
  .switch:checked {
    background: var(--accent);
  }
  .switch:checked::after {
    transform: translateX(16px);
  }
  .setting-select {
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    padding: 6px 9px;
    outline: none;
    flex: 0 0 auto;
  }
  .segmented {
    display: flex;
    gap: 3px;
    padding: 3px;
    border-radius: 9px;
    background: var(--panel);
    border: 1px solid var(--border-soft);
    width: fit-content;
  }
  .segment {
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    padding: 5px 14px;
    cursor: pointer;
  }
  .segment.active {
    background: var(--bg-app);
    color: var(--accent);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }
  .style-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .style-card {
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
    padding: 10px 12px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--bg-app);
    cursor: pointer;
    font: inherit;
  }
  .style-card:hover {
    border-color: var(--border-strong);
  }
  .style-card.active {
    border-color: var(--accent);
    background: var(--active);
  }
  .style-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .style-card.active .style-name {
    color: var(--accent);
  }
  .style-description {
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1.4;
  }
  .settings-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-muted);
    font-size: 10.5px;
  }
  .settings-foot code {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }
  .grow {
    flex: 1;
  }
</style>
