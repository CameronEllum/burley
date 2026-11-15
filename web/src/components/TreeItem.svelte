<script lang="ts">
  import type { Entry } from '../lib/api'
  import { pathMatches } from '../lib/tree'
  import { stripMdExt } from '../lib/paths'
  import TreeItem from './TreeItem.svelte'

  let {
    entry,
    selectedPath,
    filter,
    favorites,
    ontogglefavorite,
    onselect,
  }: {
    entry: Entry
    selectedPath: string
    filter: string
    favorites: string[]
    ontogglefavorite: (path: string) => void
    onselect: (path: string) => void
  } = $props()

  let open = $state(false)
  const filtering = $derived(filter.trim().length > 0)
  const containsSelected = $derived(!!selectedPath && selectedPath.startsWith(entry.path + '/'))
  const isFavorite = $derived(favorites.includes(entry.path))
  $effect(() => {
    if (containsSelected) open = true
  })
  const expanded = $derived(open || filtering)
  const children = $derived(
    filtering
      ? (entry.children ?? []).filter((child) => pathMatches(child, filter.trim()))
      : (entry.children ?? []),
  )
</script>

{#if entry.isDir}
  <li class="dir">
    <button class="row dir-row" onclick={() => (open = !open)} aria-expanded={expanded}>
      <span class="chevron" class:open={expanded} aria-hidden="true">
        <svg viewBox="0 0 16 16" width="12" height="12"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </span>
      <span class="folder" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M1.5 4.2c0-.5.4-.9.9-.9h3.2l1.3 1.4h6.7c.5 0 .9.4.9.9v6.2c0 .5-.4.9-.9.9H2.4a.9.9 0 0 1-.9-.9z" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>
      </span>
      <span class="label">{entry.name}</span>
    </button>
    {#if expanded}
      <ul class="children">
        {#each children as child (child.path)}
          <TreeItem entry={child} {selectedPath} {filter} {favorites} {ontogglefavorite} {onselect} />
        {/each}
      </ul>
    {/if}
  </li>
{:else}
  <li class="file-item">
    <button
      class="row file-row"
      class:active={entry.path === selectedPath}
      title={entry.path}
      onclick={() => onselect(entry.path)}
    >
      <span class="file-dot" aria-hidden="true"></span>
      <span class="label">{stripMdExt(entry.name)}</span>
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
