/**
 * Visible list markers for the live preview.
 *
 * `codemirror-live-markdown` hides ListMark tokens on inactive lines, which
 * leaves list text without bullets or numbers. This plugin re-styles those
 * tokens: unordered markers become •/◦/▪ by nesting depth, ordered markers keep
 * their original "1." text, and the raw marker reappears on the active line.
 */
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { selectionTouches } from './cm'

function buildListDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'ListMark') return
      const line = state.doc.lineAt(node.from)
      // The active line keeps its raw marker so it stays editable.
      if (selectionTouches(state, line.from, line.to)) return

      // Task items render a checkbox instead of a bullet.
      const afterMarker = line.text.slice(node.to - line.from).trimStart()
      if (/^\[[ xX]\]/.test(afterMarker)) return

      const listItem = node.node.parent
      const ordered = listItem?.parent?.name === 'OrderedList'

      let depth = 0
      for (let parent = node.node.parent; parent; parent = parent.parent) {
        if (parent.name === 'ListItem') depth++
      }
      const bulletDepth = ((Math.max(1, depth) - 1) % 3) + 1

      const classes = ordered
        ? 'cm-burley-list-mark ordered'
        : `cm-burley-list-mark bullet depth-${bulletDepth}`
      decorations.push(Decoration.mark({ class: classes }).range(node.from, node.to))
    },
  })

  return Decoration.set(decorations, true)
}

export const listMarkerStyler: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildListDecorations(view.state)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildListDecorations(update.state)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
)
