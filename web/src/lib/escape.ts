/** Escape exits the Markdown element under the cursor (math, links, code, tables). */
import type { EditorState, Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { readOnlyFacet } from './cm'

const ELEMENT_NODES = new Set([
  'FencedCode',
  'Table',
  'InlineCode',
  'Link',
  'Image',
  'TaskMarker',
  'Emphasis',
  'StrongEmphasis',
  'Strikethrough',
  'Blockquote',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
])

interface ElementRange {
  from: number
  to: number
  block: boolean
}

function blockMathRange(state: EditorState, pos: number): ElementRange | null {
  const lineNumber = state.doc.lineAt(pos).number
  let open = -1
  for (let n = lineNumber; n >= 1; n--) {
    if (state.doc.line(n).text.trim() === '$$') {
      open = n
      break
    }
  }
  if (open < 0) return null
  let close = -1
  for (let n = lineNumber + 1; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text.trim() === '$$') {
      close = n
      break
    }
  }
  if (close < 0) return null
  return { from: state.doc.line(open).from, to: state.doc.line(close).to, block: true }
}

function inlineMathContains(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  const pattern = /(?<!\\)\$[^$\n]+?(?<!\\)\$/g
  for (let match = pattern.exec(line.text); match; match = pattern.exec(line.text)) {
    const from = line.from + match.index
    const to = from + match[0].length
    if (pos >= from && pos <= to) return true
  }
  return false
}

export function markdownElementAt(state: EditorState, pos: number): ElementRange | null {
  let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>['node'] | null =
    syntaxTree(state).resolveInner(pos, 1).node
  while (node) {
    if (ELEMENT_NODES.has(node.name)) {
      return {
        from: node.from,
        to: node.to,
        block: node.name === 'FencedCode' || node.name === 'Table',
      }
    }
    node = node.parent
  }

  const blockMath = blockMathRange(state, pos)
  if (blockMath) return blockMath
  if (inlineMathContains(state, pos)) {
    const line = state.doc.lineAt(pos)
    return { from: line.from, to: line.to, block: false }
  }
  return null
}

/** Keymap binding: Escape moves the caret out of the current element. */
export const escapeElementKeymap: Extension = keymap.of([
  {
    key: 'Escape',
    run: (view) => {
      if (view.state.facet(readOnlyFacet)) return false
      const pos = view.state.selection.main.head
      const element = markdownElementAt(view.state, pos)
      if (!element) return false
      const doc = view.state.doc
      const target = element.block
        ? Math.min(doc.length, element.to + 1)
        : Math.min(doc.length, doc.lineAt(pos).to + 1)
      if (target === pos) return false
      view.dispatch({ selection: { anchor: target }, scrollIntoView: true })
      return true
    },
  },
])
