/**
 * Cursor-aware live preview for Burley's inline color dialect:
 *   - [text]{.red} / [text]{#c2410c bg=#fff7ed}
 *   - ==highlighted text==
 *
 * Delimiters hide when the caret is outside and appear in muted monospace when
 * the selection touches the span.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import {
  isMouseSelecting,
  mouseSelectingEnded,
  previewGeometryChanged,
  readOnlyFacet,
  selectionTouches,
} from './cm'
import { colorSpecToPresentation, findInlineColorSpans } from './colors'

const EXCLUDED_NODES = new Set([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'Table',
  'Image',
  'HTMLBlock',
  'CommentBlock',
])

function findExcludedRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  syntaxTree(state).iterate({
    enter(node) {
      if (EXCLUDED_NODES.has(node.name)) {
        ranges.push({ from: node.from, to: node.to })
        return false
      }
      if (node.name === 'Link') {
        const nextChar = state.doc.sliceString(node.to, node.to + 1)
        const raw = state.doc.sliceString(node.from, node.to)
        // Only exclude real links (`[text](url)` / `[text][ref]`); Lezer also tags
        // `[text]` in `[text]{.red}` as a shortcut Link node.
        if (nextChar !== '{' || raw.includes('](')) {
          ranges.push({ from: node.from, to: node.to })
          return false
        }
      }
    },
  })
  return ranges
}

function rangeIntersectsAny(
  from: number,
  to: number,
  ranges: Array<{ from: number; to: number }>,
): boolean {
  for (const r of ranges) {
    if (r.to <= from) continue
    if (r.from >= to) break
    return true
  }
  return false
}

function buildInlineColorDecorations(state: EditorState): DecorationSet {
  const docText = state.doc.toString()
  if (!docText.includes('==') && !docText.includes(']{')) return Decoration.none

  const readOnly = state.facet(readOnlyFacet)
  const excluded = findExcludedRanges(state)
  const decorations: Range<Decoration>[] = []

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo++) {
    const line = state.doc.line(lineNo)
    if (line.length < 4) continue
    if (!line.text.includes('==') && !line.text.includes(']{')) continue
    if (rangeIntersectsAny(line.from, line.to, excluded)) {
      // Only skip the whole line if an excluded block spans past the whole line
      let fullExcluded = false
      for (const r of excluded) {
        if (r.from <= line.from && r.to >= line.to) {
          fullExcluded = true
          break
        }
        if (r.from > line.to) break
      }
      if (fullExcluded) continue
    }

    for (const match of findInlineColorSpans(line.text)) {
      const from = line.from + match.from
      const to = line.from + match.to
      const contentFrom = line.from + match.contentFrom
      const contentTo = line.from + match.contentTo
      if (rangeIntersectsAny(from, to, excluded)) continue

      const markDeco =
        match.kind === 'highlight'
          ? Decoration.mark({ class: 'burley-highlight' })
          : (() => {
              const pres = colorSpecToPresentation(match.spec!, 'inline')
              return Decoration.mark({
                class: pres.classes.join(' '),
                attributes: pres.style ? { style: pres.style } : undefined,
              })
            })()

      if (!readOnly && selectionTouches(state, from, to)) {
        decorations.push(
          Decoration.mark({ class: 'cm-burley-color-syntax' }).range(from, contentFrom),
        )
        decorations.push(markDeco.range(contentFrom, contentTo))
        decorations.push(
          Decoration.mark({ class: 'cm-burley-color-syntax' }).range(contentTo, to),
        )
      } else {
        decorations.push(Decoration.replace({}).range(from, contentFrom))
        decorations.push(markDeco.range(contentFrom, contentTo))
        decorations.push(Decoration.replace({}).range(contentTo, to))
      }
    }
  }

  return Decoration.set(decorations, true)
}

/** Live-preview inline colored text and `==highlights==`. */
export const inlineColorField: Extension = StateField.define<DecorationSet>({
  create: buildInlineColorDecorations,
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.reconfigured ||
      previewGeometryChanged(tr) ||
      mouseSelectingEnded(tr) ||
      tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)
    ) {
      return buildInlineColorDecorations(tr.state)
    }
    if (isMouseSelecting(tr.state)) return deco
    if (tr.selection) {
      return buildInlineColorDecorations(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})
