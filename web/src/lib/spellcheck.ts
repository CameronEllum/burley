/** Native spellchecking with code, URLs and math excluded. */
import type { EditorState, Extension, Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'

const SKIP_NODES = new Set([
  'InlineCode',
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'URL',
  'HTMLBlock',
])

const noSpellcheck = Decoration.mark({ attributes: { spellcheck: 'false' } })

function build(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const marks: Range<Decoration>[] = []
  for (const range of ranges) {
    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (!SKIP_NODES.has(node.name)) return
        marks.push(noSpellcheck.range(node.from, node.to))
        return false
      },
    })

    const text = state.doc.sliceString(range.from, range.to)
    const patterns = [
      /(?<!\\)\$[^$\n]+?(?<!\\)\$/g,
      /(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$/g,
      /\b(?:https?:\/\/|www\.)\S+/g,
    ]
    for (const pattern of patterns) {
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        marks.push(noSpellcheck.range(range.from + match.index, range.from + match.index + match[0].length))
      }
    }
  }
  marks.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(marks, true)
}

export const spellcheckExclusions: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = build(view.state, view.visibleRanges)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = build(update.state, update.view.visibleRanges)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
)
