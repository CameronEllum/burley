<script lang="ts">
  import type { Entry } from '../lib/api'
  import { isHtmlPath, isMarkdownPath, openNoteInNewTab, stripMdExt } from '../lib/paths'
  import TreeItem from './TreeItem.svelte'

  let {
    entry,
    selectedPath,
    filter,
    visiblePaths,
    favorites,
    rescanningPath = '',
    ontogglefavorite,
    ontogglefolder,
    onrescan,
    oncontext,
    onselect,
  }: {
    entry: Entry
    selectedPath: string
    filter: string
    visiblePaths: Set<string> | null
    favorites: string[]
    rescanningPath?: string
    ontogglefavorite: (path: string) => void
    ontogglefolder?: (path: string, open: boolean) => void
    onrescan?: (path: string) => void
    oncontext: (event: MouseEvent, path: string, isDir: boolean) => void
    onselect: (path: string) => void
  } = $props()

  let open = $state(false)
  const filtering = $derived(filter.trim().length > 0)
  const containsSelected = $derived(!!selectedPath && selectedPath.startsWith(entry.path + '/'))
  const isFavorite = $derived(favorites.includes(entry.path))
  const visible = $derived(visiblePaths === null || visiblePaths.has(entry.path))
  $effect(() => {
    if (containsSelected) open = true
  })
  const expanded = $derived(open || filtering)
  $effect(() => {
    if (!entry.isDir || !ontogglefolder) return
    const isOpen = expanded
    const path = entry.path
    ontogglefolder(path, isOpen)
    return () => {
      if (isOpen) ontogglefolder(path, false)
    }
  })
  const children = $derived(
    (entry.children ?? []).filter((child) => visiblePaths === null || visiblePaths.has(child.path)),
  )
</script>

{#if visible}
  {#if entry.isDir}
  <li class="dir">
    <div class="dir-item">
      <button
        class="row dir-row"
        data-path={entry.path}
        onclick={() => (open = !open)}
        aria-expanded={expanded}
        oncontextmenu={(event) => {
          event.preventDefault()
          oncontext(event, entry.path, true)
        }}
      >
        <span class="chevron" class:open={expanded} aria-hidden="true">
          <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
        <span class="folder" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.2c0-.5.4-.9.9-.9h3.2l1.3 1.4h6.7c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9H2.4a.9.9 0 0 1-.9-.9z" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
        </span>
        <span class="label">{entry.name}</span>
      </button>
      {#if onrescan}
        <button
          class="dir-rescan"
          class:spinning={rescanningPath === entry.path}
          title={`Rescan ${entry.name}`}
          aria-label={`Rescan ${entry.name}`}
          disabled={rescanningPath === entry.path}
          onclick={(event) => {
            event.stopPropagation()
            onrescan(entry.path)
          }}
        >
          <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true">
            <path d="M15.6 8.1A5.7 5.7 0 1 0 16 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <path d="M15.9 4.4v3.9h-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {/if}
    </div>
    {#if expanded}
      <ul class="children">
        {#each children as child (child.path)}
          <TreeItem entry={child} {selectedPath} {filter} {visiblePaths} {favorites} {rescanningPath} {ontogglefavorite} {ontogglefolder} {onrescan} {oncontext} {onselect} />
        {/each}
      </ul>
    {/if}
  </li>
{:else}
  <li class="file-item">
    <button
      class="row file-row"
      class:active={entry.path === selectedPath}
      data-path={entry.path}
      title={entry.path}
      onclick={() => onselect(entry.path)}
      onmousedown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onauxclick={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          event.stopPropagation()
          openNoteInNewTab(entry.path)
        }
      }}
      oncontextmenu={(event) => {
        event.preventDefault()
        oncontext(event, entry.path, false)
      }}
    >
      <span class="file-dot" aria-hidden="true"></span>
      <span class="label">{stripMdExt(entry.name)}</span>
      {#if isHtmlPath(entry.path)}
        <span class="file-type-tag">HTML</span>
      {:else if isMarkdownPath(entry.path)}
        <span class="file-type-tag">MD</span>
      {/if}
    </button>
    <button
      class="row-star"
      class:on={isFavorite}
      title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      onclick={() => ontogglefavorite(entry.path)}
    >
      <svg viewBox="0 0 20 20" width="12" height="12" aria-hidden="true">
        <path
          d="M10 2.9l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.7l-4.2 2.2.8-4.7L3.2 7.9l4.7-.7z"
          fill={isFavorite ? 'currentColor' : 'none'}
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </li>
  {/if}
{/if}

<style>
  li {
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13.5px;
    text-align: left;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    position: relative;
    min-height: 26px;
  }
  .row:hover {
    background: var(--hover);
  }
  .dir-row {
    color: var(--text-muted);
    font-weight: 550;
    letter-spacing: 0.01em;
  }
  .chevron {
    display: inline-flex;
    transition: transform 0.14s ease;
    opacity: 0.75;
    flex: 0 0 auto;
  }
  .chevron.open {
    transform: rotate(90deg);
  }
  .folder {
    display: inline-flex;
    opacity: 0.85;
    flex: 0 0 auto;
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .children {
    list-style: none;
    margin: 0;
    padding: 0 0 0 14px;
    border-left: 1px solid var(--border-soft);
    margin-left: 13px;
  }
  .file-row {
    color: var(--text-primary);
    padding-left: 10px;
  }
  .file-row.active {
    background: var(--active);
    color: var(--accent);
    font-weight: 600;
  }
  .file-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--border-strong);
    flex: 0 0 auto;
  }
  .file-row.active .file-dot {
    background: var(--accent);
  }
  .file-type-tag {
    margin-left: auto;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--panel);
    border: 1px solid var(--border-soft);
    color: var(--text-muted);
    flex: 0 0 auto;
  }
  .dir-item {
    position: relative;
  }
  .dir-item .dir-row {
    padding-right: 30px;
  }
  .dir-rescan {
    position: absolute;
    right: 5px;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, color 0.12s ease;
  }
  .dir-item:hover .dir-rescan,
  .dir-rescan:focus-visible,
  .dir-rescan.spinning {
    opacity: 1;
  }
  .dir-rescan:hover {
    background: var(--hover);
    color: var(--accent);
  }
  .dir-rescan.spinning svg {
    animation: dir-rescan-spin 0.8s linear infinite;
  }
  @keyframes dir-rescan-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .file-item {
    position: relative;
  }
  .file-item .file-row {
    padding-right: 30px;
  }
  .row-star {
    position: absolute;
    right: 5px;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, color 0.12s ease;
  }
  .file-item:hover .row-star,
  .row-star:focus-visible,
  .row-star.on {
    opacity: 1;
  }
  .row-star.on {
    color: var(--accent);
  }
  .row-star:hover {
    background: var(--hover);
    color: var(--accent);
  }
</style>
