import { Facet, type EditorState, type Transaction } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'

/** Vault-relative path of the file currently loaded in the editor. */
export const filePathFacet = Facet.define<string, string>({
  combine: (values) => (values.length ? values[values.length - 1] : ''),
})

/** True while the editor is locked in read-only mode. */
export const readOnlyFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

/** True when the current selection overlaps [from, to]. */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from)
}

/**
 * True when the background parser advanced. Large notes are parsed lazily, so
 * live-preview fields must rebuild when the syntax tree grows (otherwise
 * tables, fences, links and math in unparsed regions never render).
 */
export function previewGeometryChanged(tr: Transaction): boolean {
  return syntaxTree(tr.state) !== syntaxTree(tr.startState)
}

const CODE_NODES = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'CodeInfo',
  'HTMLBlock',
  'Comment',
  'URL',
])

/** True when a range sits inside code, HTML, a comment or a link URL. */
export function isInCode(state: EditorState, from: number, to: number): boolean {
  const tree = syntaxTree(state)
  let node: SyntaxNode | null = tree.resolveInner(from, 1).node
  while (node) {
    if (CODE_NODES.has(node.name)) {
      // For containers (FencedCode/CodeBlock) make sure the range is inside.
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        return from >= node.from && to <= node.to
      }
      return true
    }
    node = node.parent
  }
  return false
}
