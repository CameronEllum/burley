<script lang="ts">
  import { api, type AgentInfo, type AgentModelsResponse, type AgentTestResult, type AppSettings, type ReleaseInfo } from '../lib/api'
  import { DARK_THEMES, LIGHT_THEMES } from '../lib/theme'
  import { bugReportUrl, featureRequestUrl } from '../lib/project'

  let {
    settings,
    onchange,
    onclose,
    agents = [],
    agentTests = {},
    agentTesting = {},
    ontest = (_id: string) => {},
    onredetect = () => {},
    version = '',
    repo = 'https://github.com/CameronEllum/burley',
    release = null,
    checkingRelease = false,
    oncheck = () => {},
    onrundemo = () => {},
  }: {
    settings: AppSettings
    onchange: (patch: Partial<AppSettings>) => void
    onclose: () => void
    agents?: AgentInfo[]
    agentTests?: Record<string, AgentTestResult>
    agentTesting?: Record<string, boolean>
    ontest?: (id: string) => void
    onredetect?: () => void
    version?: string
    repo?: string
    release?: ReleaseInfo | null
    checkingRelease?: boolean
    oncheck?: () => void
    onrundemo?: () => void
  } = $props()

  const bugUrl = $derived(bugReportUrl(repo, version))
  const featureUrl = $derived(featureRequestUrl(repo))
  const releasesUrl = $derived(`${repo}/releases`)
  const markdownFlavourUrl = $derived(`${repo}/blob/main/docs/markdown-flavour.md`)

  type Tab = 'behaviour' | 'appearance' | 'filetypes' | 'agents' | 'about'

  const storedTab = localStorage.getItem('burley:settings-tab')
  let tab = $state<Tab>(
    storedTab === 'appearance' || storedTab === 'filetypes' || storedTab === 'agents' || storedTab === 'about'
      ? storedTab
      : 'behaviour',
  )

  function switchTab(next: Tab) {
    tab = next
    localStorage.setItem('burley:settings-tab', next)
  }

  let modelsByAgent = $state<Record<string, AgentModelsResponse>>({})
  let loadingModels = $state<Record<string, boolean>>({})
  let manualModels = $state<Record<string, string>>({})

  async function loadModels(id: string, refresh = false) {
    if (loadingModels[id]) return
    if (!refresh && modelsByAgent[id]) return
    loadingModels = { ...loadingModels, [id]: true }
    try {
      const response = await api.agentModels(id)
      modelsByAgent = { ...modelsByAgent, [id]: response }
    } catch (err) {
      modelsByAgent = {
        ...modelsByAgent,
        [id]: {
          agent: id,
          models: [],
          pinned: settings.agentModels[id] ?? '',
          unsupported: true,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      loadingModels = { ...loadingModels, [id]: false }
    }
  }

  function isEnabled(id: string): boolean {
    return !(settings.disabledAgents ?? []).includes(id)
  }

  function toggleAgent(id: string, enabled: boolean) {
    const current = settings.disabledAgents ?? []
    const next = enabled ? current.filter((item) => item !== id) : current.includes(id) ? current : [...current, id]
    onchange({ disabledAgents: next })
  }

  const supportedFileTypes = [
    {
      id: 'markdown',
      name: 'Markdown',
      extensions: '.md, .markdown, .mdown, .mkd',
      description: 'Live-preview editor with math, tables, diagrams, and Lua cells.',
    },
    {
      id: 'html',
      name: 'HTML',
      extensions: '.html, .htm',
      description: 'Rendered in an embedded frame with scripts and local assets enabled. Toggle Raw to edit source.',
    },
  ] as const

  function isFileTypeEnabled(id: string): boolean {
    return (settings.fileTypes ?? ['markdown', 'html']).includes(id)
  }

  function toggleFileType(id: string, enabled: boolean) {
    const current = settings.fileTypes ?? ['markdown', 'html']
    const next = enabled
      ? current.includes(id) ? current : [...current, id]
      : current.filter((item) => item !== id)
    onchange({ fileTypes: next })
  }

  $effect(() => {
    if (tab !== 'agents') return
    for (const agent of agents) {
      if (agent.available && isEnabled(agent.id) && !modelsByAgent[agent.id] && !loadingModels[agent.id]) {
        void loadModels(agent.id)
      }
    }
  })

  function pinModel(agentID: string, model: string) {
    const next = { ...settings.agentModels }
    if (model.trim()) next[agentID] = model.trim()
    else delete next[agentID]
    onchange({ agentModels: next })
    manualModels = { ...manualModels, [agentID]: model }
    const agent = agents.find((item) => item.id === agentID)
    if (agent?.available && isEnabled(agentID)) ontest(agentID)
  }

  function modelOptions(agentID: string, models: string[]): string[] {
    const pinned = settings.agentModels[agentID]
    if (pinned && !models.includes(pinned)) return [pinned, ...models]
    return models
  }

  function modelGroups(models: string[]): Array<{ provider: string; models: string[] }> {
    const groups = new Map<string, string[]>()
    for (const model of models) {
      const slash = model.indexOf('/')
      const provider = slash > 0 ? model.slice(0, slash) : ''
      const list = groups.get(provider)
      if (list) list.push(model)
      else groups.set(provider, [model])
    }
    return [...groups.entries()]
      .map(([provider, list]) => ({ provider, models: list }))
      .sort((a, b) => a.provider.localeCompare(b.provider))
  }

  function modelLabel(model: string, provider: string): string {
    return provider ? model.slice(provider.length + 1) : model
  }

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
      <button class="settings-close" aria-label="Close settings" onclick={onclose}>×</button>
    </header>

    <div class="settings-tabs" role="tablist">
      <button
        class="settings-tab"
        class:active={tab === 'behaviour'}
        role="tab"
        aria-selected={tab === 'behaviour'}
        onclick={() => switchTab('behaviour')}>Behaviour</button
      >
      <button
        class="settings-tab"
        class:active={tab === 'appearance'}
        role="tab"
        aria-selected={tab === 'appearance'}
        onclick={() => switchTab('appearance')}>Appearance</button
      >
      <button
        class="settings-tab"
        class:active={tab === 'filetypes'}
        role="tab"
        aria-selected={tab === 'filetypes'}
        onclick={() => switchTab('filetypes')}>File Types</button
      >
      <button
        class="settings-tab"
        class:active={tab === 'agents'}
        role="tab"
        aria-selected={tab === 'agents'}
        onclick={() => switchTab('agents')}>Agents</button
      >
      <button
        class="settings-tab"
        class:active={tab === 'about'}
        role="tab"
        aria-selected={tab === 'about'}
        onclick={() => switchTab('about')}>About</button
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
          <label class="setting-row">
            <span>
              <strong>Spell checking</strong>
              <small>Show native browser spellcheck squiggles; code, URLs and math are excluded.</small>
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={settings.spellCheck}
              onchange={(event) => onchange({ spellCheck: event.currentTarget.checked })}
            />
          </label>
          <h3>Comments</h3>
          <label class="setting-row">
            <span>
              <strong>Show comment on hover</strong>
              <small>Display a floating preview when hovering over highlighted comments or pins.</small>
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={settings.commentHoverPreview}
              onchange={(event) => onchange({ commentHoverPreview: event.currentTarget.checked })}
            />
          </label>
          <label class="setting-row">
            <span>
              <strong>Comment username</strong>
              <small>Author name shown on new discussions, edits, and replies.</small>
            </span>
            <input
              type="text"
              class="setting-input"
              value={settings.commentAuthor}
              placeholder="Auto (OS username)"
              onchange={(event) => onchange({ commentAuthor: event.currentTarget.value })}
            />
          </label>
          <h3>Vault</h3>
          <label class="setting-row">
            <span>
              <strong>Background file scan</strong>
              <small>Periodically rescan the vault at very low priority so external file changes appear automatically.</small>
            </span>
            <input
              type="checkbox"
              class="switch"
              checked={settings.backgroundScan}
              onchange={(event) => onchange({ backgroundScan: event.currentTarget.checked })}
            />
          </label>
          <h3>Demo</h3>
          <div class="setting-row">
            <span>
              <strong>Feature demo</strong>
              <small>Open the built-in interactive demo pages (or launch <code>burley --demo</code> for a writable sandbox).</small>
            </span>
            <button
              type="button"
              class="setting-btn"
              onclick={() => {
                onclose()
                onrundemo()
              }}
            >
              Run Demo
            </button>
          </div>
          <div class="setting-row">
            <span>
              <strong>First-run demo</strong>
              <small>
                {settings.demoSeen
                  ? 'Already shown for this vault. Reset to show automatically on next launch.'
                  : 'Pending — will open automatically on next launch.'}
              </small>
            </span>
            <button
              type="button"
              class="setting-btn"
              disabled={!settings.demoSeen}
              onclick={() => onchange({ demoSeen: false })}
            >
              {settings.demoSeen ? 'Reset' : 'Pending'}
            </button>
          </div>
        </section>
      {:else if tab === 'appearance'}
        <section class="settings-section">
          <h3>Mode</h3>
          <div class="segmented theme-segments">
            {#each ['light', 'dark', 'system'] as const as option}
              <button
                class="segment"
                class:active={settings.theme === option}
                onclick={() => onchange({ theme: option })}
              >{option === 'system' ? 'Follow system' : option === 'light' ? 'Light' : 'Dark'}</button
              >
            {/each}
          </div>

          <h3>Light theme</h3>
          <div class="palette-grid">
            {#each LIGHT_THEMES as palette (palette.id)}
              <button
                class="palette-card"
                class:active={settings.lightTheme === palette.id}
                onclick={() => onchange({ lightTheme: palette.id })}
                title={palette.description}
              >
                <span
                  class="palette-swatch"
                  style={`--swatch-app:${palette.swatch.app};--swatch-chrome:${palette.swatch.chrome};--swatch-accent:${palette.swatch.accent};--swatch-border:${palette.swatch.border}`}
                >
                  <span class="swatch-side"></span>
                  <span class="swatch-body">
                    <span class="swatch-bar"></span>
                    <span class="swatch-line"></span>
                  </span>
                </span>
                <span class="palette-name">{palette.name}</span>
                <span class="palette-description">{palette.description}</span>
              </button>
            {/each}
          </div>

          <h3>Dark theme</h3>
          <div class="palette-grid">
            {#each DARK_THEMES as palette (palette.id)}
              <button
                class="palette-card"
                class:active={settings.darkTheme === palette.id}
                onclick={() => onchange({ darkTheme: palette.id })}
                title={palette.description}
              >
                <span
                  class="palette-swatch"
                  style={`--swatch-app:${palette.swatch.app};--swatch-chrome:${palette.swatch.chrome};--swatch-accent:${palette.swatch.accent};--swatch-border:${palette.swatch.border}`}
                >
                  <span class="swatch-side"></span>
                  <span class="swatch-body">
                    <span class="swatch-bar"></span>
                    <span class="swatch-line"></span>
                  </span>
                </span>
                <span class="palette-name">{palette.name}</span>
                <span class="palette-description">{palette.description}</span>
              </button>
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
      {:else if tab === 'filetypes'}
        <section class="settings-section">
          <h3>Supported file types</h3>
          <p class="section-lead">Choose which file types appear in the file browser and full-text search.</p>
          {#each supportedFileTypes as ft (ft.id)}
            <label class="setting-row">
              <span>
                <strong>{ft.name} <code class="ext-tag">{ft.extensions}</code></strong>
                <small>{ft.description}</small>
              </span>
              <input
                type="checkbox"
                checked={isFileTypeEnabled(ft.id)}
                onchange={(event) => toggleFileType(ft.id, event.currentTarget.checked)}
              />
            </label>
          {/each}
        </section>
      {:else if tab === 'agents'}
        <section class="settings-section">
          <div class="settings-head-row">
            <h3>CLI agent harnesses</h3>
            <button class="agent-refresh" onclick={onredetect}>Re-detect</button>
          </div>
          <p class="settings-note">
            Found, enabled agents appear first and are used by Talk (<kbd>Alt T</kbd>). Each enabled
            harness is confirmed in the background by sending and receiving a test message. Leave
            model on <strong>Agent default</strong> to follow the CLI's own configuration.
          </p>

          {#if agents.length === 0}
            <p class="settings-note">
              No CLI agent harnesses are configured.
            </p>
          {:else}
            {#each agents as agent (agent.id)}
              {@const enabled = isEnabled(agent.id)}
              {@const test = agentTests[agent.id]}
              {@const testing = !!agentTesting[agent.id]}
              {#if !agent.available}
                <div class="agent-row shrunk not-found">
                  <span class="agent-dot" aria-hidden="true"></span>
                  <span class="agent-shrunk-name">{agent.name}</span>
                  <code class="agent-path">{agent.id}</code>
                  <span class="grow"></span>
                  <span class="agent-badge missing">Not found</span>
                </div>
              {:else if !enabled}
                <div class="agent-row shrunk disabled">
                  <span class="agent-dot" aria-hidden="true"></span>
                  <strong>{agent.name}</strong>
                  <code class="agent-path" title={agent.path}>{agent.path || agent.id}</code>
                  <span class="grow"></span>
                  <span class="agent-badge muted">Disabled</span>
                  <input
                    type="checkbox"
                    class="switch"
                    aria-label={`Enable ${agent.name}`}
                    checked={false}
                    onchange={(event) => toggleAgent(agent.id, event.currentTarget.checked)}
                  />
                </div>
              {:else}
                {@const info = modelsByAgent[agent.id]}
                {@const pinned = settings.agentModels[agent.id] ?? ''}
                <div class="agent-row">
                  <div class="agent-head">
                    <span
                      class="agent-dot"
                      class:confirmed={!!test?.confirmed && !testing}
                      class:testing={testing}
                      class:failed={!!test && !test.confirmed && !testing}
                      aria-hidden="true"
                    ></span>
                    <strong>{agent.name}</strong>
                    <code class="agent-path" title={agent.path}>{agent.path || agent.id}</code>
                    <span
                      class="agent-badge"
                      class:confirmed={!!test?.confirmed && !testing}
                      class:testing={testing}
                      class:failed={!!test && !test.confirmed && !testing}
                    >
                      {#if testing}
                        Confirming…
                      {:else if test?.confirmed}
                        Confirmed
                      {:else if test}
                        Unconfirmed
                      {:else}
                        Pending
                      {/if}
                    </span>
                    <span class="grow"></span>
                    <button
                      class="agent-refresh"
                      disabled={testing}
                      onclick={() => ontest(agent.id)}
                    >
                      {testing ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      class="agent-refresh"
                      disabled={loadingModels[agent.id]}
                      onclick={() => void loadModels(agent.id, true)}
                    >
                      {loadingModels[agent.id] ? 'Detecting…' : 'Refresh'}
                    </button>
                    <input
                      type="checkbox"
                      class="switch"
                      aria-label={`Enable ${agent.name}`}
                      checked={true}
                      onchange={(event) => toggleAgent(agent.id, event.currentTarget.checked)}
                    />
                  </div>

                  {#if info && info.models.length > 0}
                    <div class="agent-controls">
                      <select
                        class="setting-select agent-model-select"
                        aria-label={`Model for ${agent.name}`}
                        value={pinned}
                        onchange={(event) => pinModel(agent.id, event.currentTarget.value)}
                      >
                        <option value="">Agent default</option>
                        {#each modelGroups(modelOptions(agent.id, info.models)) as group (group.provider)}
                          <optgroup label={group.provider || 'Models'}>
                            {#each group.models as model (model)}
                              <option value={model} title={model}>{modelLabel(model, group.provider)}</option>
                            {/each}
                          </optgroup>
                        {/each}
                      </select>
                      {#if pinned}
                        <button class="agent-clear" onclick={() => pinModel(agent.id, '')}>Clear</button>
                      {/if}
                      <small class="agent-count">{info.models.length} models</small>
                    </div>
                  {:else}
                    <div class="agent-controls">
                      <input
                        class="agent-model-input"
                        placeholder="provider/model (blank for default)"
                        aria-label={`Model ID for ${agent.name}`}
                        value={manualModels[agent.id] ?? pinned}
                        oninput={(event) =>
                          (manualModels = { ...manualModels, [agent.id]: event.currentTarget.value })}
                        onkeydown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            pinModel(agent.id, event.currentTarget.value)
                          }
                        }}
                      />
                      <button
                        class="agent-pin"
                        onclick={() => pinModel(agent.id, manualModels[agent.id] ?? pinned)}
                      >
                        Pin
                      </button>
                      {#if pinned}
                        <button class="agent-clear" onclick={() => pinModel(agent.id, '')}>Clear</button>
                      {/if}
                    </div>
                    {#if loadingModels[agent.id]}
                      <small class="agent-count">Detecting models…</small>
                    {:else if info?.error}
                      <small class="agent-count error">{info.error}</small>
                    {:else if info?.unsupported}
                      <small class="agent-count">
                        This CLI cannot list models; type a model ID instead.
                      </small>
                    {/if}
                  {/if}

                  {#if testing}
                    <small class="agent-status">Confirming in the background (sending test message)…</small>
                  {:else if test?.confirmed}
                    <small class="agent-status ok">
                      Confirmed ({test.durationMs ?? 0}ms) — sent test message, received “{(test.reply ?? '').replace(/\s+/g, ' ').slice(0, 80)}”
                    </small>
                  {:else if test && !test.confirmed}
                    <small class="agent-status error">
                      Confirmation failed: {test.error || test.stderr || test.stdout || `exit ${test.exitCode}`}
                    </small>
                  {/if}
                </div>
              {/if}
            {/each}
          {/if}

          <p class="settings-note agent-footnote">
            Detection runs the CLI's own listing command (for OpenCode, <code>opencode models</code>)
            inside this vault, so only models available here appear.
          </p>
        </section>
      {:else}
        <section class="settings-section about-panel">
          <h3>Version</h3>
          <div class="about-version">
            <div class="about-version-main">
              <strong>Burley {version || 'dev'}</strong>
              <small>Single binary · Go + Svelte 5 · local-first Markdown</small>
            </div>
            <span class="about-badge" class:update={!!release?.updateAvailable}>
              {#if release?.updateAvailable}
                {release.latest} available
              {:else if release?.error}
                Check unavailable
              {:else if release}
                Up to date
              {:else}
                Checking…
              {/if}
            </span>
          </div>
          <div class="about-update-row">
            <span class="about-note">
              {#if release?.updateAvailable}
                A newer release is published on GitHub.
              {:else if release?.error}
                Could not reach GitHub ({release.error}).
              {:else if release}
                You are running the latest published release.
              {:else}
                Checking for a newer release…
              {/if}
            </span>
            <button class="about-button" onclick={oncheck} disabled={checkingRelease}>
              {checkingRelease ? 'Checking…' : 'Check now'}
            </button>
          </div>

          <h3>Links</h3>
          <div class="about-links">
            <a href={repo} target="_blank" rel="noopener noreferrer">GitHub repository</a>
            <a href={bugUrl} target="_blank" rel="noopener noreferrer">Report a bug</a>
            <a href={featureUrl} target="_blank" rel="noopener noreferrer">Request a feature</a>
            <a href={releasesUrl} target="_blank" rel="noopener noreferrer">Releases</a>
            <a href={markdownFlavourUrl} target="_blank" rel="noopener noreferrer">Markdown flavour</a>
          </div>

          <h3>Credits</h3>
          <p class="about-credits">
            Burley uses the following open-source work:
          </p>
          <ul class="about-credit-list">
            <li><strong>Svelte 5</strong> — interface</li>
            <li><strong>CodeMirror 6</strong> — editor and live preview</li>
            <li><strong>KaTeX</strong> — math rendering</li>
            <li><strong>Plotly</strong> — charts</li>
            <li><strong>Mermaid</strong> — diagrams</li>
            <li><strong>highlight.js</strong> — code colouring</li>
            <li><strong>wasmoon</strong> — sandboxed Lua</li>
            <li><strong>marked + DOMPurify</strong> — export and chat Markdown</li>
          </ul>
          <p class="about-license">MIT licensed. © 2026 Cameron Ellum.</p>
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
    font-size: 16px;
    line-height: 1;
    padding: 4px 7px;
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
  .setting-select,
  .setting-input {
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
  .setting-input {
    width: 170px;
  }
  .setting-input:focus {
    border-color: var(--accent);
  }
  .setting-btn {
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    padding: 6px 12px;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .setting-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .setting-btn:disabled {
    opacity: 0.48;
    cursor: default;
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
  .palette-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .palette-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    text-align: left;
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--bg-app);
    cursor: pointer;
    font: inherit;
  }
  .palette-card:hover {
    border-color: var(--border-strong);
  }
  .palette-card.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .palette-swatch {
    display: flex;
    height: 42px;
    border: 1px solid var(--swatch-border);
    border-radius: 7px;
    background: var(--swatch-chrome);
    overflow: hidden;
  }
  .swatch-side {
    width: 30%;
    background: var(--swatch-app);
    border-right: 1px solid var(--swatch-border);
  }
  .swatch-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 9px 10px;
    background: var(--swatch-app);
  }
  .swatch-bar {
    width: 64%;
    height: 5px;
    border-radius: 2px;
    background: var(--swatch-accent);
    opacity: 0.9;
  }
  .swatch-line {
    width: 80%;
    height: 4px;
    border-radius: 2px;
    background: var(--swatch-border);
  }
  .palette-name {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .palette-card.active .palette-name {
    color: var(--accent);
  }
  .palette-description {
    color: var(--text-muted);
    font-size: 10.5px;
    line-height: 1.35;
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
  .about-version {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--bg-app);
  }
  .about-version-main {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
  }
  .about-version-main strong {
    font-size: 14px;
    font-weight: 650;
  }
  .about-version-main small {
    color: var(--text-muted);
    font-size: 11px;
  }
  .about-badge {
    border: 1px solid var(--ok-border);
    border-radius: 999px;
    padding: 3px 9px;
    background: var(--ok-bg);
    color: var(--ok-fg);
    font-size: 10.5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .about-badge.update {
    border-color: var(--accent);
    background: var(--active);
    color: var(--accent);
  }
  .about-update-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  .about-note {
    flex: 1;
    color: var(--text-muted);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .about-button {
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 11.5px;
    padding: 4px 10px;
    cursor: pointer;
    white-space: nowrap;
  }
  .about-button:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .about-button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .about-links {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
  }
  .about-links a {
    color: hsl(var(--md-link));
    font-size: 12.5px;
    text-decoration: none;
    border-bottom: 1px dotted currentColor;
  }
  .about-links a:hover {
    color: var(--accent);
  }
  .about-credits {
    margin: 0 0 6px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .about-credit-list {
    margin: 0;
    padding-left: 18px;
    color: var(--text-muted);
    font-size: 11.5px;
    line-height: 1.7;
  }
  .about-credit-list strong {
    color: var(--text-primary);
    font-weight: 600;
  }
  .about-license {
    margin: 10px 0 0;
    color: var(--text-muted);
    font-size: 10.5px;
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
  .settings-note {
    margin: 0 0 12px;
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.55;
  }
  .settings-note strong {
    color: var(--text-primary);
    font-weight: 600;
  }
  .settings-note kbd {
    padding: 1px 4px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-app);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .agent-row {
    padding: 11px 12px;
    margin-bottom: 8px;
    border: 1px solid var(--border-soft);
    border-radius: 9px;
    background: var(--bg-app);
  }
  .agent-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .agent-head strong {
    font-size: 13px;
    font-weight: 650;
  }
  .agent-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 250px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .agent-refresh,
  .agent-clear,
  .agent-pin {
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 10.5px;
    font-weight: 600;
    padding: 3px 8px;
    cursor: pointer;
  }
  .agent-refresh:hover,
  .agent-clear:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .agent-refresh:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .agent-pin {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .agent-pin:hover {
    background: var(--accent-strong);
  }
  .agent-controls {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 8px;
  }
  .agent-model-select {
    flex: 1;
    min-width: 0;
    max-width: 340px;
  }
  .agent-model-input {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: var(--bg-chrome);
    color: var(--text-primary);
    font: inherit;
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 6px 9px;
    outline: none;
  }
  .agent-model-input:focus {
    border-color: var(--accent);
  }
  .agent-count {
    color: var(--text-muted);
    font-size: 10.5px;
    white-space: nowrap;
  }
  .agent-count.error {
    display: block;
    margin-top: 7px;
    color: var(--danger-fg);
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .agent-footnote {
    margin-top: 12px;
  }
  .settings-head-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 6px 0 8px;
  }
  .settings-head-row h3 {
    margin: 0;
  }
  .agent-row.shrunk {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    margin-bottom: 5px;
    min-height: 0;
  }
  .agent-row.not-found {
    opacity: 0.65;
    padding: 4px 10px;
  }
  .agent-row.disabled {
    opacity: 0.85;
  }
  .agent-shrunk-name {
    font-size: 12px;
    font-weight: 550;
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border-strong);
    flex: 0 0 auto;
  }
  .agent-dot.confirmed {
    background: #2f9e44;
  }
  .agent-dot.testing {
    background: var(--accent);
    animation: agent-pulse 1.1s ease-in-out infinite;
  }
  .agent-dot.failed {
    background: var(--danger-fg);
  }
  @keyframes agent-pulse {
    0%, 100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
  .agent-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--border-soft);
    color: var(--text-muted);
    background: var(--panel);
    white-space: nowrap;
  }
  .agent-badge.confirmed {
    border-color: var(--ok-border);
    background: var(--ok-bg);
    color: var(--ok-fg);
  }
  .agent-badge.testing {
    border-color: var(--accent);
    background: var(--active);
    color: var(--accent);
  }
  .agent-badge.failed {
    border-color: var(--danger-fg);
    color: var(--danger-fg);
  }
  .agent-badge.missing,
  .agent-badge.muted {
    background: transparent;
  }
  .agent-status {
    display: block;
    margin-top: 7px;
    color: var(--text-muted);
    font-size: 10.5px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .agent-status.ok {
    color: var(--ok-fg);
  }
  .agent-status.error {
    color: var(--danger-fg);
  }
  .section-lead {
    margin: 0 0 12px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-muted);
  }
  .ext-tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 5px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    background: var(--bg-app);
    border: 1px solid var(--border);
    vertical-align: 1px;
  }
</style>
