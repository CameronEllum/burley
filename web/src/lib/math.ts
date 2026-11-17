/**
 * KaTeX math support for the live preview.
 *
 * `codemirror-live-markdown`'s bundled math plugin only understands backtick
 * wrapped math (`` `$x$` ``), so Burley ships its own small extension that
 * handles the standard Obsidian syntax:
 *
 *   inline:  $E = mc^2$   and   $$x^2$$ on a single line
 *   block:   $$            (delimiters on their own lines)
 *              \int_0^1 x^2 dx
 *            $$
 *
 * Rendered formulas are replaced with widgets while the cursor is elsewhere;
 * moving the cursor into the marker reveals the raw source.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { setMouseSelecting } from 'codemirror-live-markdown'
import { isInCode, isMouseSelecting, mouseSelectingEnded, previewGeometryChanged, readOnlyFacet, selectionTouches } from './cm'
import { getActiveView } from './viewRef'
import katex from 'katex'

const INLINE = /(?<!\\)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)(?<!\\)\$(?!\$)(?!\d)/g
const DISPLAY_INLINE = /(?<!\\)\$\$([^$\n]+?)\$\$(?!\$)/g

export function isValidInlineMath(source: string): boolean {
  const trimmed = source.trim()
  if (!trimmed || /^\s|\s$/.test(source)) return false
  // Reject currency-range fragments like "9,900–" or "5 - " or "10 to"
  if (/^\d[\d,._]*\s*(?:[-–—~/]|to|and|or)?\s*$/i.test(trimmed)) return false
  return true
}

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly display: boolean,
    readonly editPos: number,
  ) {
    super()
  }

  eq(other: MathWidget): boolean {
    return other.source === this.source && other.display === this.display
  }

  toDOM(): HTMLElement {
    const el: HTMLElement = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-burley-math cm-burley-math-block' : 'cm-burley-math cm-burley-math-inline'
    try {
      el.innerHTML = katex.renderToString(this.source, {
        displayMode: this.display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      })
    } catch (err) {
      el.classList.add('cm-burley-math-error')
      el.textContent = `[math error] ${err instanceof Error ? err.message : String(err)}`
      return el
    }
    el.title = 'Click to edit'
    let downX = 0
    let downY = 0
    el.addEventListener('mousedown', (event) => {
      downX = event.clientX
      downY = event.clientY
    })
    el.addEventListener('click', (event) => {
      const view = getActiveView()
      if (!view || Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return
      event.preventDefault()
      event.stopPropagation()
      const pos = Math.min(this.editPos, view.state.doc.length)
      view.dispatch({
        selection: { anchor: pos },
        effects: setMouseSelecting.of(false),
        scrollIntoView: true,
      })
      view.focus()
    })
    return el
  }

  ignoreEvent(): boolean {
    return this.display
  }
}

export interface MathAtCursor {
  tex: string
  display: boolean
  from: number
  to: number
}

/**
 * Math expression containing `head`, if any. Used by the live preview tooltip
 * because Burley's math is regex-parsed rather than a Lezer node.
 */
export function mathAt(state: EditorState, head: number): MathAtCursor | null {
  const match = blockMathAt(state, head)
  if (match) return match
  return inlineMathAt(state, head)
}

function blockMathAt(state: EditorState, head: number): MathAtCursor | null {
  let openLine = -1
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (line.text.trim() !== '$$') continue
    if (openLine < 0) {
      openLine = n
      continue
    }
    const open = state.doc.line(openLine)
    if (head >= open.from && head <= line.to) {
      const bodyFrom = open.to + 1
      const bodyTo = n - 1 >= openLine + 1 ? state.doc.line(n - 1).to : open.to
      return { tex: state.doc.sliceString(bodyFrom, bodyTo), display: true, from: open.from, to: line.to }
    }
    openLine = -1
  }
  return null
}

function inlineMathAt(state: EditorState, head: number): MathAtCursor | null {
  const line = state.doc.lineAt(head)
  const search = (pattern: RegExp, display: boolean): MathAtCursor | null => {
    pattern.lastIndex = 0
    for (let m = pattern.exec(line.text); m; m = pattern.exec(line.text)) {
      const from = line.from + m.index
      const to = from + m[0].length
      if (head < from || head > to) continue
      if (isInCode(state, from, to)) return null
      const raw = m[1] ?? ''
      if (!display && !isValidInlineMath(raw)) continue
      return { tex: raw.trim(), display, from, to }
    }
    return null
  }
  return search(DISPLAY_INLINE, true) ?? search(INLINE, false)
}

function buildInlineDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  const text = state.doc.toString()
  const covered: Array<[number, number]> = []

  // Display math on a single line: $$ ... $$
  DISPLAY_INLINE.lastIndex = 0
  for (let m = DISPLAY_INLINE.exec(text); m; m = DISPLAY_INLINE.exec(text)) {
    const from = m.index
    const to = from + m[0].length
    if (isInCode(state, from, to)) continue
    covered.push([from, to])
    if (!readOnly && selectionTouches(state, from, to)) continue
    decorations.push(
      Decoration.replace({ widget: new MathWidget(m[1].trim(), true, from + 2) }).range(from, to),
    )
  }

  INLINE.lastIndex = 0
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    const from = m.index
    const to = from + m[0].length
    const source = m[1]
    // Standard heuristic: no space directly inside the delimiters, and the
    // content must not look like a currency amount ("$5 and $10", "~$9,900–$10,150").
    if (!isValidInlineMath(source)) continue
    if (covered.some(([a, b]) => from >= a && from < b)) continue
    if (isInCode(state, from, to)) continue
    if (!readOnly && selectionTouches(state, from, to)) continue
    decorations.push(
      Decoration.replace({ widget: new MathWidget(source.trim(), false, from + 1) }).range(from, to),
    )
  }

  return Decoration.set(decorations, true)
}

/** Inline `$...$` / single-line `$$...$$` math. */
export const inlineMathPlugin: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildInlineDecorations(view.state)
    }

    update(update: ViewUpdate) {
      const ended = update.transactions.some(mouseSelectingEnded)
      if (
        update.docChanged ||
        update.viewportChanged ||
        ended ||
        update.startState.facet(readOnlyFacet) !== update.state.facet(readOnlyFacet)
      ) {
        this.decorations = buildInlineDecorations(update.state)
        return
      }
      if (isMouseSelecting(update.state)) return
      if (update.selectionSet) {
        this.decorations = buildInlineDecorations(update.state)
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
)

function buildBlockMath(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  let openStart = -1
  let openFrom = 0
  const pairs: Array<{ from: number; to: number; bodyFrom: number; bodyTo: number }> = []

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    if (line.text.trim() === '$$') {
      if (openStart < 0) {
        openStart = n
        openFrom = line.from
      } else {
        const prev = state.doc.line(n - 1)
        pairs.push({
          from: openFrom,
          to: line.to,
          bodyFrom: state.doc.line(openStart).to + 1,
          bodyTo: n - 1 >= openStart + 1 ? prev.to : state.doc.line(openStart).to,
        })
        openStart = -1
      }
    }
  }

  for (const pair of pairs) {
    if (!readOnly && selectionTouches(state, pair.from, pair.to)) {
      for (let pos = pair.from; pos <= pair.to; ) {
        const line = state.doc.lineAt(pos)
        decorations.push(Decoration.line({ class: 'cm-burley-math-source-line' }).range(line.from))
        pos = line.to + 1
      }
      continue
    }
    const body = state.doc.sliceString(pair.bodyFrom, pair.bodyTo).trim()
    decorations.push(
      Decoration.replace({
        widget: new MathWidget(body, true, Math.min(pair.bodyFrom, state.doc.length)),
        block: true,
      }).range(pair.from, pair.to),
    )
  }
  return Decoration.set(decorations, true)
}

/** Block `$$ ... $$` math (delimiters on their own lines). */
export const blockMathField: Extension = StateField.define<DecorationSet>({
  create: buildBlockMath,
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured || previewGeometryChanged(tr) || mouseSelectingEnded(tr)) {
      return buildBlockMath(tr.state)
    }
    if (isMouseSelecting(tr.state)) return deco
    if (tr.selection || tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)) {
      return buildBlockMath(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})
