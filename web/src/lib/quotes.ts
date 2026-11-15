/** Line styling for blockquotes in the live preview. */
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

function buildQuoteDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Blockquote') return
      for (let pos = node.from; pos <= node.to; ) {
        const line = state.doc.lineAt(pos)
        decorations.push(Decoration.line({ class: 'cm-burley-quote' }).range(line.from))
        pos = line.to + 1
        if (line.to >= state.doc.length) break
      }
    },
  })
  return Decoration.set(decorations, true)
}

export const blockquoteStyler: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildQuoteDecorations(view.state)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildQuoteDecorations(update.state)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
)
