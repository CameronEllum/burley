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
const INLINE_PAREN = /(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g
const DISPLAY_INLINE = /(?<!\\)\$\$([^$\n]+?)\$\$(?!\$)/g
const DISPLAY_BRACKET_INLINE = /(?<!\\)\\\[([^\n]+?)(?<!\\)\\\]/g

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

interface BlockMathPair {
  from: number
  to: number
  bodyFrom: number
  bodyTo: number
}

function findBlockMathPairs(state: EditorState): BlockMathPair[] {
  let openLine = -1
  let openDelim: '$$' | '\\[' | null = null
  const pairs: BlockMathPair[] = []

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const trimmed = line.text.trim()
    if (!openDelim) {
      if (trimmed === '$$' || trimmed === '\\[') {
        openLine = n
        openDelim = trimmed
      }
      continue
    }
    const closeDelim = openDelim === '$$' ? '$$' : '\\]'
    if (trimmed === closeDelim) {
      const open = state.doc.line(openLine)
      const prev = state.doc.line(n - 1)
      pairs.push({
        from: open.from,
        to: line.to,
        bodyFrom: open.to + 1,
        bodyTo: n - 1 >= openLine + 1 ? prev.to : open.to,
      })
      openLine = -1
      openDelim = null
    }
  }
  return pairs
}

function blockMathAt(state: EditorState, head: number): MathAtCursor | null {
  for (const pair of findBlockMathPairs(state)) {
    if (head >= pair.from && head <= pair.to) {
      return {
        tex: state.doc.sliceString(pair.bodyFrom, pair.bodyTo),
        display: true,
        from: pair.from,
        to: pair.to,
      }
    }
  }
  return null
}

function inlineMathAt(state: EditorState, head: number): MathAtCursor | null {
  const line = state.doc.lineAt(head)
  const search = (pattern: RegExp, display: boolean, checkValid: boolean): MathAtCursor | null => {
    pattern.lastIndex = 0
    for (let m = pattern.exec(line.text); m; m = pattern.exec(line.text)) {
      const from = line.from + m.index
      const to = from + m[0].length
      if (head < from || head > to) continue
      if (isInCode(state, from, to)) return null
      const raw = m[1] ?? ''
      if (checkValid && !isValidInlineMath(raw)) continue
      if (!raw.trim()) continue
      return { tex: raw.trim(), display, from, to }
    }
    return null
  }
  return (
    search(DISPLAY_INLINE, true, false) ??
    search(DISPLAY_BRACKET_INLINE, true, false) ??
    search(INLINE, false, true) ??
    search(INLINE_PAREN, false, false)
  )
}

function buildInlineDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  const text = state.doc.toString()
  const covered: Array<[number, number]> = []

  const addMatches = (
    pattern: RegExp,
    display: boolean,
    editOffset: number,
    validate: (raw: string) => boolean,
  ) => {
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const from = m.index
      const to = from + m[0].length
      const source = m[1] ?? ''
      if (!validate(source)) continue
      if (covered.some(([a, b]) => from >= a && from < b)) continue
      if (isInCode(state, from, to)) continue
      covered.push([from, to])
      if (!readOnly && selectionTouches(state, from, to)) continue
      decorations.push(
        Decoration.replace({ widget: new MathWidget(source.trim(), display, from + editOffset) }).range(from, to),
      )
    }
  }

  // Display math on a single line: $$ ... $$ and \[ ... \]
  addMatches(DISPLAY_INLINE, true, 2, (s) => s.trim().length > 0)
  addMatches(DISPLAY_BRACKET_INLINE, true, 2, (s) => s.trim().length > 0)
  // Standard heuristic for $...$: no space directly inside the delimiters, and
  // content must not look like a currency amount ("$5 and $10", "~$9,900–$10,150").
  addMatches(INLINE, false, 1, isValidInlineMath)
  // Unambiguous LaTeX \( ... \) allows inner whitespace.
  addMatches(INLINE_PAREN, false, 2, (s) => s.trim().length > 0)

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
  const pairs = findBlockMathPairs(state)

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
