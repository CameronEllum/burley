/** Tree helpers shared by the sidebar components. */

import type { Entry } from './api'

/** True if the entry itself or any descendant matches the filter text. */
export function pathMatches(entry: Entry, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  if (entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q)) return true
  if (entry.children) return entry.children.some((child) => pathMatches(child, query))
  return false
}

/** Depth-first count of files. */
export function countFiles(entries: Entry[]): number {
  let total = 0
  for (const entry of entries) {
    if (entry.isDir) total += countFiles(entry.children ?? [])
    else total += 1
  }
  return total
}
