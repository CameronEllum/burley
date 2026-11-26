<script lang="ts">
  import { onMount } from 'svelte'
  import fuzzysort from 'fuzzysort'
  import { api, type FlatFile, type SearchMatch } from '../lib/api'
  import type { OutlineItem } from '../lib/outline'
  import { baseName, dirOf, isHtmlPath, isMarkdownPath, normalizeExplicitPath } from '../lib/paths'
  import { highlightSegments, highlightText, type PaletteCommand, type PaletteItem } from '../lib/palette'

  let {
    initialQuery = '',
    anchorLeft = 0,
    anchorTop = 0,
    anchorWidth = 0,
    files,
    root = '',
    favorites = [],
    recent = [],
    headings = [],
    commands = [],
    onclose,
    onopen,
    onheading,
  }: {
    initialQuery?: string
    anchorLeft?: number
    anchorTop?: number
    anchorWidth?: number
    files: FlatFile[]
    root?: string
    favorites?: string[]
    recent?: string[]
    headings?: OutlineItem[]
    commands?: PaletteCommand[]
    onclose: () => void
    onopen: (path: string, line?: number) => void
    onheading: (line: number) => void
  } = $props()

  // The palette is mounted fresh for each open, so the initial prefix is intentional.
  // svelte-ignore state_referenced_locally
  let rawQuery = $state(initialQuery)
  let selectedIndex = $state(0)
  let inputEl = $state<HTMLInputElement | null>(null)
  let listEl = $state<HTMLUListElement | null>(null)
  let contentResults = $state<SearchMatch[]>([])
  let contentLoading = $state(false)
  let contentError = $state('')
  let controller: AbortController | null = null

  const mode = $derived(
    rawQuery.startsWith('@')
      ? 'heading'
      : rawQuery.startsWith('>')
        ? 'command'
        : rawQuery.startsWith('?')
          ? 'content'
          : 'files',
  )
  const query = $derived(rawQuery.slice(mode === 'files' ? 0 : 1).trim())
  const favoriteSet = $derived(new Set(favorites))
  const recentSet = $derived(new Set(recent))
  const fileMap = $derived(new Map(files.map((file) => [file.path, file])))
  const modeLabel = $derived(
    mode === 'files' ? 'Files' : mode === 'heading' ? 'Headings' : mode === 'command' ? 'Commands' : 'Content',
  )

  const fileItems = $derived.by(() => {
    const q = query
    if (!q) {
      const pinned = favorites
        .map((path) => fileMap.get(path))
        .filter((file): file is FlatFile => !!file)
      const pinnedPaths = new Set(pinned.map((file) => file.path))
      const recentFiles = recent
        .map((path) => fileMap.get(path))
        .filter((file): file is FlatFile => !!file && !pinnedPaths.has(file.path))
        .slice(0, 8)
      const others = recentFiles.length
        ? recentFiles
        : files.filter((file) => !pinnedPaths.has(file.path)).slice(0, 10)

      return [
        ...pinned.map(
          (file): PaletteItem => ({ kind: 'file', key: `file:${file.path}`, file, pinned: true }),
        ),
        ...others.map(
          (file): PaletteItem => ({
            kind: 'file',
            key: `file:${file.path}`,
            file,
            pinned: false,
            hint: recentFiles.length ? 'Recent' : undefined,
          }),
        ),
      ]
    }

    const explicit = normalizeExplicitPath(q, root)
    const searchQ = explicit || q
    const results = fuzzysort.go(searchQ, files, { key: 'path', limit: 200, threshold: -50000 })
    const pinned: PaletteItem[] = []
    const others: PaletteItem[] = []
    let explicitPathAdded = ''
    if (explicit && (isMarkdownPath(explicit) || isHtmlPath(explicit))) {
      const existing = fileMap.get(explicit)
      if (existing) {
        explicitPathAdded = existing.path
        pinned.push({
          kind: 'file',
          key: `file:${existing.path}`,
          file: existing,
          pinned: favoriteSet.has(existing.path),
          hint: recentSet.has(existing.path) ? 'Recent' : 'Exact path',
        })
      } else {
        pinned.push({
          kind: 'file',
          key: `explicit:${explicit}`,
          file: { path: explicit, name: baseName(explicit), modTime: 0, size: 0 },
          pinned: favoriteSet.has(explicit),
          hint: 'Open path',
        })
      }
    }
    for (const result of results) {
      if (explicitPathAdded && result.obj.path === explicitPathAdded) continue
      const item: PaletteItem = {
        kind: 'file',
        key: `file:${result.obj.path}`,
        file: result.obj,
        pinned: favoriteSet.has(result.obj.path),
        indexes: result.indexes,
        hint: recentSet.has(result.obj.path) ? 'Recent' : undefined,
      }
      if (item.pinned) pinned.push(item)
      else others.push(item)
      if (pinned.length >= 50 && others.length >= 50) break
    }
    return [...pinned.slice(0, 50), ...others.slice(0, 50)]
  })

  const items = $derived.by<PaletteItem[]>(() => {
    if (mode === 'files') {
      if (fileItems.length === 0 && query) {
        return [...fileItems, { kind: 'fallback', key: 'fallback', query }]
      }
      return fileItems
    }
    if (mode === 'heading') {
      if (!query) {
        return headings.map(
          (heading): PaletteItem => ({ kind: 'heading', key: `heading:${heading.id}`, heading }),
        )
      }
      return fuzzysort
        .go(query, headings, { key: 'text', limit: 100, threshold: -20000 })
        .map(
          (result): PaletteItem => ({
            kind: 'heading',
            key: `heading:${result.obj.id}`,
            heading: result.obj,
            indexes: result.indexes,
          }),
        )
    }
    if (mode === 'command') {
      const list = query
        ? fuzzysort
            .go(query, commands, { key: 'label', limit: 50, threshold: -20000 })
            .map(
              (result): PaletteItem => ({
                kind: 'command',
                key: `command:${result.obj.id}`,
                command: result.obj,
                indexes: result.indexes,
              }),
            )
        : commands.map(
            (command): PaletteItem => ({ kind: 'command', key: `command:${command.id}`, command }),
          )
      return list
    }
    return contentResults.map(
      (match): PaletteItem => ({ kind: 'content', key: `content:${match.path}:${match.line}`, match }),
    )
  })

  const dividerIndex = $derived.by(() => {
    if (mode !== 'files') return -1
    const hasPinned = items.some((item) => item.kind === 'file' && item.pinned)
    const firstOther = items.findIndex((item) => item.kind === 'file' && !item.pinned)
    return hasPinned && firstOther > 0 ? firstOther : -1
  })

  // Content search: debounced with stale-request cancellation.
  $effect(() => {
    if (mode !== 'content') return
    const q = query
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

  // Reset the highlight whenever the visible list changes.
  $effect(() => {
    mode
    query
    items.length
    selectedIndex = 0
  })

  $effect(() => {
    selectedIndex
    const active = listEl?.querySelector<HTMLElement>('.palette-item.active')
    active?.scrollIntoView({ block: 'nearest' })
  })

  onMount(() => {
    inputEl?.focus()
    if (!initialQuery) inputEl?.select()
  })

  function move(delta: number) {
    if (items.length === 0) return
    selectedIndex = (selectedIndex + delta + items.length) % items.length
  }

  function activate(item: PaletteItem, newTab = false) {
    if (item.kind === 'file') {
      if (newTab) {
        const url = new URL(window.location.href)
        url.searchParams.set('file', item.file.path)
        url.hash = ''
        window.open(url.toString(), '_blank', 'noopener')
        onclose()
        return
      }
      onopen(item.file.path)
      return
    }
    if (item.kind === 'heading') {
      onheading(item.heading.line)
      return
    }
    if (item.kind === 'command') {
      item.command.run()
      onclose()
      return
    }
    if (item.kind === 'content') {
      onopen(item.match.path, item.match.line)
      return
    }
    rawQuery = `?${item.query}`
    inputEl?.focus()
    inputEl?.setSelectionRange(rawQuery.length, rawQuery.length)
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose()
      return
    }
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()

    if (event.key === 'ArrowDown' || (mod && (key === 'n' || key === 'j'))) {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp' || (mod && key === 'k')) {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const item = items[selectedIndex]
      if (item) activate(item, mod)
    }
  }
</script>

<div
  class="modal-backdrop palette-backdrop"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <div
    class="modal search-modal palette"
    style={`left: ${anchorLeft}px; top: ${anchorTop}px; width: ${anchorWidth || 'min(640px, 92vw)'}${anchorWidth ? 'px' : ''};`}
    role="dialog"
    aria-modal="true"
    aria-label="Quick open"
  >
    <div class="palette-input-row">
      <svg class="palette-search-icon" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M12.4 12.4L16.5 16.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      <input
        bind:this={inputEl}
        class="palette-input search-input"
        type="text"
        spellcheck="false"
        autocomplete="off"
        placeholder="Search files by path... (@ headings, > commands, ? content)"
        bind:value={rawQuery}
        onkeydown={onKeydown}
      />
      {#if rawQuery}
        <button
          class="palette-clear"
          aria-label="Clear query"
          onclick={() => {
            rawQuery = ''
            inputEl?.focus()
          }}>×</button
        >
      {/if}
    </div>

    <div class="palette-results">
      {#if mode === 'files' && items.length === 0}
        <p class="palette-message">No files in this vault.</p>
      {:else if mode === 'files' && items.length === 1 && items[0]?.kind === 'fallback'}
        <p class="palette-message">No matching files.</p>
      {:else if mode === 'heading' && items.length === 0}
        <p class="palette-message">
          {headings.length === 0 ? 'This note has no headings.' : 'No headings match.'}
        </p>
      {:else if mode === 'command' && items.length === 0}
        <p class="palette-message">No matching commands.</p>
      {:else if mode === 'content'}
        {#if contentError}
          <p class="palette-message error">{contentError}</p>
        {:else if query.length < 2}
          <p class="palette-message">Type at least two characters to search inside files.</p>
        {:else if contentLoading && contentResults.length === 0}
          <p class="palette-message">Searching…</p>
        {:else if items.length === 0}
          <p class="palette-message">No matches for “{query}”.</p>
        {/if}
      {/if}

      {#if items.length > 0}
        <ul class="palette-list" bind:this={listEl}>
          {#each items as item, index (item.key)}
            {#if index === dividerIndex}
              <li class="palette-divider" role="separator" aria-hidden="true"></li>
            {/if}
            <li>
              <button
                class="palette-item search-item"
                class:active={index === selectedIndex}
                class:content-item={item.kind === 'content'}
                onmousemove={() => (selectedIndex = index)}
                onclick={() => activate(item)}
              >
                {#if item.kind === 'file'}
                  {#if item.pinned}
                    <span class="pin" title="Favorite" aria-label="Favorite">★</span>
                  {:else}
                    <svg class="file-icon" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M5 2.8h6l4 4v10.4H5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M11 2.8v4h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /></svg>
                  {/if}
                  <span class="file-name">
                    {#each highlightSegments(item.file.path, item.indexes) as segment}
                      {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                    {/each}
                  </span>
                  {#if dirOf(item.file.path)}
                    <span class="file-dir">{dirOf(item.file.path)}</span>
                  {/if}
                  <span class="grow"></span>
                  {#if item.hint}<span class="item-hint">{item.hint}</span>{/if}
                {:else if item.kind === 'heading'}
                  <span class="level-badge">H{item.heading.level}</span>
                  <span class="file-name">
                    {#each highlightText(item.heading.text, item.indexes) as segment}
                      {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                    {/each}
                  </span>
                  <span class="grow"></span>
                  <span class="item-hint">Line {item.heading.line}</span>
                {:else if item.kind === 'command'}
                  <span class="command-mark" aria-hidden="true">›</span>
                  <span class="file-name">
                    {#each highlightText(item.command.label, item.indexes) as segment}
                      {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                    {/each}
                  </span>
                  <span class="grow"></span>
                  {#if item.command.hint}<span class="item-hint">{item.command.hint}</span>{/if}
                {:else if item.kind === 'content'}
                  <span class="match-line">
                    <span class="file-name">{baseName(item.match.path)}</span>
                    <span class="line-badge">:{item.match.line}</span>
                  </span>
                  <span class="match-snippet">{item.match.snippet}</span>
                  <span class="file-dir">{dirOf(item.match.path)}</span>
                {:else}
                  <span class="fallback-mark" aria-hidden="true">?</span>
                  <span class="fallback-text">Search inside file contents for “{item.query}”</span>
                  <span class="grow"></span>
                  <span class="item-hint">→</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="palette-footer">
      <span class="mode-chip">{modeLabel}</span>
      <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
      <span><kbd>↵</kbd> open</span>
      {#if mode === 'files'}<span><kbd>Ctrl ↵</kbd> new tab</span>{/if}
      <span><kbd>Esc</kbd> close</span>
      <span class="grow"></span>
      <span class="count">{items.length} result{items.length === 1 ? '' : 's'}</span>
    </div>
  </div>
</div>

<style>
  .palette {
    position: fixed;
    margin: 0;
    display: flex;
    flex-direction: column;
    max-height: min(60vh, calc(100vh - 90px));
    overflow: hidden;
  }
  .palette-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .palette-search-icon {
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  .palette-input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 16px;
    padding: 14px 0;
    outline: none;
  }
  .palette-input::placeholder {
    color: var(--text-muted);
    font-size: 13.5px;
  }
  .palette-clear {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 5px;
    cursor: pointer;
    flex: 0 0 auto;
  }
  .palette-clear:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .palette-results {
    overflow-y: auto;
    min-height: 80px;
  }
  .palette-list {
    list-style: none;
    margin: 0;
    padding: 6px;
  }
  .palette-divider {
    height: 0;
    margin: 5px 8px;
    border-top: 1px solid var(--border-soft);
  }
  .palette-item {
    display: flex;
    align-items: baseline;
    gap: 7px;
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
  .palette-item.active {
    background: var(--active);
  }
  .palette-item.content-item {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
  }
  .pin {
    color: var(--accent);
    font-size: 11px;
    line-height: 1;
    flex: 0 0 auto;
  }
  .file-icon,
  .command-mark,
  .fallback-mark {
    color: var(--text-muted);
    flex: 0 0 auto;
    font-size: 12px;
  }
  .fallback-mark {
    color: var(--accent);
    font-weight: 700;
  }
  .file-name {
    color: var(--text-primary);
    font-size: 13.5px;
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .file-name mark {
    background: transparent;
    color: var(--accent);
    font-weight: 750;
  }
  .file-dir {
    color: var(--text-muted);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
    flex: 0 1 auto;
  }
  .grow {
    flex: 1;
  }
  .item-hint {
    color: var(--text-muted);
    font-size: 10.5px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    flex: 0 0 auto;
  }
  .level-badge {
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    flex: 0 0 auto;
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
  .fallback-text {
    color: var(--text-primary);
    font-size: 13px;
  }
  .palette-message {
    margin: 0;
    padding: 18px 18px 14px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .palette-message.error {
    color: var(--danger-fg);
  }
  .palette-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-muted);
    font-size: 11px;
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
  .mode-chip {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    font-size: 10px;
  }
  .count {
    font-variant-numeric: tabular-nums;
  }
</style>
