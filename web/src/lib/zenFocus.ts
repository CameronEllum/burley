/**
 * Typewriter-style focus dimming for Zen mode.
 *
 * Everything except the top-level block containing the caret is dimmed via
 * line decorations; the editor element gets `cm-zen-focus` so app.css can
 * transition opacity smoothly.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

function topLevelBlock(state: EditorState, head: number): { from: number; to: number } | null {
  const tree = syntaxTree(state)
  let found: { from: number; to: number } | null = null
  tree.iterate({
    enter: (node) => {
      if (node.node.parent?.name !== 'Document') return
      if (head >= node.from && head <= node.to) {
        found = { from: node.from, to: node.to }
        return false
      }
    },
  })
  return found
}

function activeBlockLines(state: EditorState): number[] {
  const head = state.selection.main.head
  // `resolveInner` returns Document on a boundary; try just before the caret.
  const block = topLevelBlock(state, head) ?? (head > 0 ? topLevelBlock(state, head - 1) : null)
  if (!block || block.to <= block.from) return []

  const lines: number[] = []
  const first = state.doc.lineAt(block.from).number
  const last = state.doc.lineAt(Math.min(block.to, state.doc.length)).number
  for (let n = first; n <= last; n++) lines.push(state.doc.line(n).from)
  return lines
}

function build(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = activeBlockLines(state).map((from) =>
    Decoration.line({ class: 'cm-zen-active' }).range(from),
  )
  return Decoration.set(decorations, true)
}

const zenField = StateField.define<DecorationSet>({
  create: build,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured) return build(tr.state)
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Focus dimming extensions (empty when Zen mode is off). */
export function zenFocusExtensions(): Extension {
  return [EditorView.editorAttributes.of({ class: 'cm-zen-focus' }), zenField]
}
