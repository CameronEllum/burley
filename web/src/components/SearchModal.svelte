<script lang="ts">
  import { onMount } from 'svelte'
  import fuzzysort from 'fuzzysort'
  import { api, type FlatFile, type SearchMatch } from '../lib/api'
  import { dirOf, stripMdExt } from '../lib/paths'

  let {
    initialMode = 'files',
    files,
    onclose,
    onopen,
  }: {
    initialMode?: 'files' | 'content'
    files: FlatFile[]
    onclose: () => void
    onopen: (path: string, line?: number) => void
  } = $props()

  let mode = $state<'files' | 'content'>('files')
  $effect(() => {
    mode = initialMode
  })
  let query = $state('')
  let active = $state(0)
  let inputEl = $state<HTMLInputElement | null>(null)
  let listEl = $state<HTMLUListElement | null>(null)
  let contentResults = $state<SearchMatch[]>([])
  let contentLoading = $state(false)
  let contentError = $state('')

  const fileResults = $derived.by(() => {
    const q = query.trim()
    if (!q) return files.slice(0, 60).map((file) => ({ file, score: 0 }))
    return fuzzysort
      .go(q, files, { key: 'path', limit: 60, threshold: -50000 })
      .map((result) => ({ file: result.obj, score: result.score }))
  })

  const resultCount = $derived(mode === 'files' ? fileResults.length : contentResults.length)

  let controller: AbortController | null = null

  // Debounced full-text search with cancellation of stale requests.
  $effect(() => {
    const q = query.trim()
    const m = mode
    if (m !== 'content') return
    controller?.abort()
    if (q.length < 2) {
      contentResults = []
      contentLoading = false
      contentError = ''
      return
    }
    const ctl = new AbortController()
    controller = ctl
    contentLoading = true
    contentError = ''
    const timer = setTimeout(async () => {
      try {
        const results = await api.search(q, ctl.signal)
        if (!ctl.signal.aborted) contentResults = results
      } catch (err) {
        if (ctl.signal.aborted) return
        contentError = err instanceof Error ? err.message : String(err)
        contentResults = []
      } finally {
        if (!ctl.signal.aborted) contentLoading = false
      }
    }, 120)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  })

  $effect(() => {
    // Reset the highlight whenever the result set changes.
    query
    mode
    active = 0
  })

  $effect(() => {
    const el = listEl?.querySelector<HTMLElement>('.search-item.active')
    el?.scrollIntoView({ block: 'nearest' })
  })

  onMount(() => {
    inputEl?.focus()
    inputEl?.select()
  })

  function switchMode(next: 'files' | 'content') {
    if (mode === next) return
    mode = next
    inputEl?.focus()
  }

  function choose(index: number) {
    if (mode === 'files') {
      const result = fileResults[index]
      if (result) onopen(result.file.path)
      return
    }
    const match = contentResults[index]
    if (match) onopen(match.path, match.line)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      active = resultCount === 0 ? 0 : (active + 1) % resultCount
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      active = resultCount === 0 ? 0 : (active - 1 + resultCount) % resultCount
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(active)
    }
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <div class="modal search-modal" role="dialog" aria-modal="true" aria-label="Search">
    <div class="search-tabs">
      <button class="tab" class:active={mode === 'files'} onclick={() => switchMode('files')}>
        Files <kbd>Ctrl P</kbd>
      </button>
      <button class="tab" class:active={mode === 'content'} onclick={() => switchMode('content')}>
        Content <kbd>Ctrl ⇧ F</kbd>
      </button>
      <span class="grow"></span>
      <button class="close" aria-label="Close search" onclick={onclose}>Esc</button>
    </div>

    <input
      bind:this={inputEl}
      class="search-input"
      type="text"
      spellcheck="false"
      autocomplete="off"
      placeholder={mode === 'files' ? 'Jump to a note…' : 'Search inside notes…'}
      bind:value={query}
      onkeydown={onKeydown}
    />

    <div class="search-results">
      {#if mode === 'files'}
        {#if fileResults.length === 0}
          <p class="message">No notes found.</p>
        {:else}
          <ul class="result-list" bind:this={listEl}>
            {#each fileResults as result, index (result.file.path)}
              <li>
                <button
                  class="search-item"
                  class:active={index === active}
                  onmouseenter={() => (active = index)}
                  onclick={() => choose(index)}
                >
                  <span class="file-name">{stripMdExt(result.file.name)}</span>
                  {#if dirOf(result.file.path)}
                    <span class="file-dir">{dirOf(result.file.path)}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        {#if contentError}
          <p class="message error">{contentError}</p>
        {:else if contentLoading && contentResults.length === 0}
          <p class="message">Searching…</p>
        {:else if query.trim().length < 2}
          <p class="message">Type at least two characters.</p>
        {:else if contentResults.length === 0}
          <p class="message">No matches for “{query.trim()}”.</p>
        {:else}
          <ul class="result-list" bind:this={listEl}>
            {#each contentResults as match, index (`${match.path}:${match.line}:${index}`)}
              <li>
                <button
                  class="search-item content-item"
                  class:active={index === active}
                  onmouseenter={() => (active = index)}
                  onclick={() => choose(index)}
                >
                  <span class="match-line">
                    <span class="file-name">{stripMdExt(match.path.split('/').pop() ?? match.path)}</span>
                    <span class="line-badge">:{match.line}</span>
                  </span>
                  <span class="match-snippet">{match.snippet}</span>
                  <span class="file-dir">{dirOf(match.path)}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>

    <div class="search-footer">
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      <span><kbd>Esc</kbd> close</span>
      <span class="grow"></span>
      <span class="count">{resultCount} result{resultCount === 1 ? '' : 's'}</span>
    </div>
  </div>
</div>

<style>
  .search-modal {
    width: min(680px, calc(100vw - 40px));
    margin-top: 12vh;
    align-self: flex-start;
    display: flex;
    flex-direction: column;
    max-height: 70vh;
    overflow: hidden;
  }
  .search-tabs {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    padding: 6px 10px;
    border-radius: 7px;
    cursor: pointer;
  }
  .tab:hover {
    background: var(--hover);
  }
  .tab.active {
    background: var(--active);
    color: var(--accent);
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border-soft);
    background: var(--panel);
    color: var(--text-muted);
  }
  .close {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  .close:hover {
    background: var(--hover);
  }
  .grow {
    flex: 1;
  }
  .search-input {
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 17px;
    padding: 14px 16px;
    outline: none;
  }
  .search-results {
    overflow-y: auto;
    min-height: 90px;
  }
  .result-list {
    list-style: none;
    margin: 0;
    padding: 6px;
  }
  .search-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    padding: 7px 10px;
    border-radius: 7px;
    cursor: pointer;
  }
  .search-item.active {
    background: var(--active);
  }
  .file-name {
    color: var(--text-primary);
    font-size: 13.5px;
    font-weight: 550;
  }
  .file-dir {
    color: var(--text-muted);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .content-item {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
  }
  .match-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .line-badge {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
  }
  .match-snippet {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .message {
    margin: 0;
    padding: 22px 18px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .message.error {
    color: var(--danger-fg);
  }
  .search-footer {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 12px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-muted);
    font-size: 11px;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
</style>
