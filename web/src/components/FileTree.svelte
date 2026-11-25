<script lang="ts">
  import fuzzysort from 'fuzzysort'
  import type { Entry } from '../lib/api'
  import TreeItem from './TreeItem.svelte'

  let {
    entries,
    selectedPath,
    filter,
    filterMode = 'all',
    favorites,
    rescanningPath = '',
    collapseSignal = 0,
    ontogglefavorite,
    ontogglefolder,
    onrescan,
    oncontext,
    onselect,
  }: {
    entries: Entry[]
    selectedPath: string
    filter: string
    filterMode?: 'all' | 'dirs' | 'root-dirs'
    favorites: string[]
    rescanningPath?: string
    collapseSignal?: number
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

  function flattenDirs(entries: Entry[]): Entry[] {
    const result: Entry[] = []
    for (const entry of entries) {
      if (!entry.isDir) continue
      result.push(entry)
      result.push(...flattenDirs(entry.children ?? []))
    }
    return result
  }

  function collectDescendants(entry: Entry, out: Set<string>) {
    out.add(entry.path)
    for (const child of entry.children ?? []) {
      collectDescendants(child, out)
    }
  }

  // Match against files or directories depending on filterMode, keeping ancestor
  // folders (and descendants for matched folders) visible in the tree.
  const filterState = $derived.by(() => {
    const query = filter.trim()
    if (!query) return { visiblePaths: null as Set<string> | null, autoExpandPaths: null as Set<string> | null }

    if (filterMode === 'all') {
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
      return { visiblePaths: paths, autoExpandPaths: null }
    }

    const candidates =
      filterMode === 'root-dirs'
        ? entries.filter((entry) => entry.isDir)
        : flattenDirs(entries)
    const key = filterMode === 'root-dirs' ? 'name' : 'path'
    const matches = fuzzysort.go(query, candidates, {
      key,
      limit: 1000,
      threshold: -100000,
    })
    const paths = new Set<string>()
    const expand = new Set<string>()
    for (const match of matches) {
      const dir = match.obj
      collectDescendants(dir, paths)
      const parts = dir.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/')
        paths.add(ancestor)
        expand.add(ancestor)
      }
    }
    return { visiblePaths: paths, autoExpandPaths: expand }
  })

  const visiblePaths = $derived(filterState.visiblePaths)
  const autoExpandPaths = $derived(filterState.autoExpandPaths)

  const visible = $derived(
    visiblePaths ? entries.filter((entry) => visiblePaths.has(entry.path)) : entries,
  )
</script>

{#if visible.length === 0}
  <p class="tree-empty">
    {#if filter.trim()}
      {filterMode === 'root-dirs'
        ? `No root folders match “${filter.trim()}”.`
        : filterMode === 'dirs'
          ? `No folders match “${filter.trim()}”.`
          : `No notes match “${filter.trim()}”.`}
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
        {autoExpandPaths}
        {favorites}
        {rescanningPath}
        {collapseSignal}
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
