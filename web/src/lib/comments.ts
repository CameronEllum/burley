/**
 * Hide HTML comments (`<!-- ... -->`) in the live preview.
 *
 * Inline and single-/multi-line block comments are hidden whenever the caret is
 * outside them (and always in Read-Only mode). Moving the caret inside a
 * comment reveals its raw text in a muted monospace style for editing.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { isMouseSelecting, mouseSelectingEnded, previewGeometryChanged, readOnlyFacet, selectionTouches } from './cm'

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g

function findCodeRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
        ranges.push({ from: node.from, to: node.to })
        return false
      }
    },
  })
  return ranges
}

function insideAnyRange(pos: number, ranges: Array<{ from: number; to: number }>): boolean {
  for (const r of ranges) {
    if (pos >= r.from && pos <= r.to) return true
  }
  return false
}

function buildCommentDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString()
  if (!text.includes('<!--')) return Decoration.none

  const readOnly = state.facet(readOnlyFacet)
  const codeRanges = findCodeRanges(state)
  const decorations: Range<Decoration>[] = []

  HTML_COMMENT_RE.lastIndex = 0
  for (let m = HTML_COMMENT_RE.exec(text); m; m = HTML_COMMENT_RE.exec(text)) {
    const from = m.index
    const to = from + m[0].length
    if (insideAnyRange(from, codeRanges)) continue

    const startLine = state.doc.lineAt(from)
    const endLine = state.doc.lineAt(to)
    const fullLine =
      state.doc.sliceString(startLine.from, from).trim() === '' &&
      state.doc.sliceString(to, endLine.to).trim() === ''

    const activeFrom = fullLine ? startLine.from : from
    const activeTo = fullLine ? endLine.to : to

    if (!readOnly && selectionTouches(state, activeFrom, activeTo)) {
      decorations.push(Decoration.mark({ class: 'cm-burley-comment-source' }).range(from, to))
    } else if (fullLine) {
      decorations.push(Decoration.line({ class: 'cm-burley-comment-hidden' }).range(startLine.from))
      decorations.push(Decoration.replace({}).range(startLine.from, endLine.to))
    } else {
      decorations.push(Decoration.replace({}).range(from, to))
    }
  }

  return Decoration.set(decorations, true)
}

/** Live-preview hiding for HTML comments (`<!-- ... -->`). */
export function commentsField(): Extension {
  return StateField.define<DecorationSet>({
    create: buildCommentDecorations,
    update(deco, tr) {
      if (
        tr.docChanged ||
        tr.reconfigured ||
        previewGeometryChanged(tr) ||
        mouseSelectingEnded(tr) ||
        tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)
      ) {
        return buildCommentDecorations(tr.state)
      }
      if (isMouseSelecting(tr.state)) return deco
      if (tr.selection) {
        return buildCommentDecorations(tr.state)
      }
      return deco
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}
