/** Shared types and helpers for the Quick-Open palette. */

import type { FlatFile, SearchMatch } from './api'
import type { OutlineItem } from './outline'

export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  keywords?: string
  run: () => void
}

export interface HighlightSegment {
  text: string
  match: boolean
}

export type PaletteItem =
  | {
      kind: 'file'
      key: string
      file: FlatFile
      pinned: boolean
      indexes?: readonly number[]
      hint?: string
    }
  | {
      kind: 'heading'
      key: string
      heading: OutlineItem
      indexes?: readonly number[]
    }
  | {
      kind: 'command'
      key: string
      command: PaletteCommand
      indexes?: readonly number[]
    }
  | { kind: 'content'; key: string; match: SearchMatch }
  | { kind: 'fallback'; key: string; query: string }

/**
 * Split the filename into plain/highlighted segments. fuzzysort's indexes are
 * relative to the whole path, so they are shifted to the basename.
 */
export function highlightSegments(path: string, indexes?: readonly number[]): HighlightSegment[] {
  const start = path.lastIndexOf('/') + 1
  return highlightRange(path.slice(start), (indexes ?? []).filter((index) => index >= start).map((index) => index - start))
}

/** Highlight arbitrary text (heading titles, command labels). */
export function highlightText(text: string, indexes?: readonly number[]): HighlightSegment[] {
  return highlightRange(text, indexes ?? [])
}

function highlightRange(text: string, indexes: readonly number[]): HighlightSegment[] {
  const matched = new Set(indexes)
  if (matched.size === 0) return [{ text, match: false }]

  const segments: HighlightSegment[] = []
  let buffer = ''
  let bufferMatch = matched.has(0)
  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i)
    if (i === 0) bufferMatch = isMatch
    if (isMatch !== bufferMatch) {
      if (buffer) segments.push({ text: buffer, match: bufferMatch })
      buffer = ''
      bufferMatch = isMatch
    }
    buffer += text[i]
  }
  if (buffer) segments.push({ text: buffer, match: bufferMatch })
  return segments
}
