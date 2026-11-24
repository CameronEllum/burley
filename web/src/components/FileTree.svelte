<script lang="ts">
  import fuzzysort from 'fuzzysort'
  import type { Entry } from '../lib/api'
  import TreeItem from './TreeItem.svelte'

  let {
    entries,
    selectedPath,
    filter,
    favorites,
    rescanningPath = '',
    ontogglefavorite,
    ontogglefolder,
    onrescan,
    oncontext,
    onselect,
  }: {
    entries: Entry[]
    selectedPath: string
    filter: string
    favorites: string[]
    rescanningPath?: string
    ontogglefavorite: (path: string) => void
    ontogglefolder?: (path: string, open: boolean) => void
    onrescan?: (path: string) => void
    oncontext: (event: MouseEvent, path: string, isDir: boolean) => void
    onselect: (path: string) => void
  } = $props()

  function flatten(entries: Entry[]): Entry[] {
    const result: Entry[] = []
    for (const entry of entries) {
      if (entry.isDir) result.push(...flatten(entry.children ?? []))
      else result.push(entry)
    }
    return result
  }

  // Match against the complete relative path, then keep every ancestor folder
  // so nested notes remain visible in the tree.
  const visiblePaths = $derived.by(() => {
    const query = filter.trim()
    if (!query) return null
    const matches = fuzzysort.go(query, flatten(entries), {
      key: 'path',
      limit: 1000,
      threshold: -100000,
    })
    const paths = new Set<string>()
    for (const match of matches) {
      const parts = match.obj.path.split('/')
      for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'))
    }
    return paths
  })

  const visible = $derived(
    visiblePaths ? entries.filter((entry) => visiblePaths.has(entry.path)) : entries,
  )
</script>

{#if visible.length === 0}
  <p class="tree-empty">
    {#if filter.trim()}
      No notes match “{filter.trim()}”.
    {:else}
      No Markdown files in this folder.
    {/if}
  </p>
{:else}
  <ul class="tree-root">
    {#each visible as entry (entry.path)}
      <TreeItem
        {entry}
        {selectedPath}
        {filter}
        {visiblePaths}
        {favorites}
        {rescanningPath}
        {ontogglefavorite}
        {ontogglefolder}
        {onrescan}
        {oncontext}
        {onselect}
      />
    {/each}
  </ul>
{/if}

<style>
  .tree-root {
    list-style: none;
    margin: 0;
    padding: 4px 6px 16px;
  }
  .tree-empty {
    margin: 18px 14px;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
