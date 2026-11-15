<script lang="ts">
  import type { Entry } from '../lib/api'
  import { pathMatches } from '../lib/tree'
  import TreeItem from './TreeItem.svelte'

  let {
    entries,
    selectedPath,
    filter,
    onselect,
  }: {
    entries: Entry[]
    selectedPath: string
    filter: string
    onselect: (path: string) => void
  } = $props()

  const visible = $derived(
    filter.trim() ? entries.filter((entry) => pathMatches(entry, filter.trim())) : entries,
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
      <TreeItem {entry} {selectedPath} {filter} {onselect} />
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
