/**
 * Collapsible <details><summary>...</summary>...</details> widget for the live preview.
 *
 * @lezer/markdown often splits a <details> block containing blank lines into
 * multiple HTMLBlock and Paragraph nodes, so we scan the document text directly
 * (skipping FencedCode ranges) for balanced <details>...</details> pairs.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { isMouseSelecting, mouseSelectingEnded, readOnlyFacet, selectionTouches } from './cm'
import { renderMarkdown } from './markdown'

interface DetailsMatch {
  from: number
  to: number
  openByDefault: boolean
  summary: string
  body: string
}

const OPEN_TAG_RE = /<details\b([^>]*)>/gi
const CLOSE_TAG_RE = /<\/details\s*>/gi
const SUMMARY_RE = /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i

function findFencedRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
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

function findDetailsBlocks(state: EditorState): DetailsMatch[] {
  const text = state.doc.toString()
  if (!text.toLowerCase().includes('<details')) return []

  const fenced = findFencedRanges(state)
  const tokens: Array<{ pos: number; end: number; kind: 'open' | 'close'; attrs: string }> = []

  OPEN_TAG_RE.lastIndex = 0
  for (let m = OPEN_TAG_RE.exec(text); m; m = OPEN_TAG_RE.exec(text)) {
    if (!insideAnyRange(m.index, fenced)) {
      tokens.push({ pos: m.index, end: m.index + m[0].length, kind: 'open', attrs: m[1] ?? '' })
    }
  }
  CLOSE_TAG_RE.lastIndex = 0
  for (let m = CLOSE_TAG_RE.exec(text); m; m = CLOSE_TAG_RE.exec(text)) {
    if (!insideAnyRange(m.index, fenced)) {
      tokens.push({ pos: m.index, end: m.index + m[0].length, kind: 'close', attrs: '' })
    }
  }
  if (tokens.length < 2) return []

  tokens.sort((a, b) => a.pos - b.pos)

  const matches: DetailsMatch[] = []
  const stack: Array<{ pos: number; end: number; attrs: string }> = []

  for (const tok of tokens) {
    if (tok.kind === 'open') {
      stack.push({ pos: tok.pos, end: tok.end, attrs: tok.attrs })
    } else if (stack.length > 0) {
      const open = stack.pop()!
      // Only replace top-level <details> blocks; nested ones render inside the outer HTML.
      if (stack.length !== 0) continue

      const lineStart = state.doc.lineAt(open.pos).from
      const lineEnd = state.doc.lineAt(tok.end).to
      const innerRaw = text.slice(open.end, tok.pos)

      let summary = 'Details'
      let body = innerRaw
      const sumMatch = SUMMARY_RE.exec(innerRaw)
      if (sumMatch) {
        summary = sumMatch[1].trim() || 'Details'
        body = innerRaw.slice(sumMatch[0].length)
      }
      body = body.replace(/^\s*\n/, '').replace(/\n\s*$/, '')

      matches.push({
        from: lineStart,
        to: lineEnd,
        openByDefault: /\bopen\b/i.test(open.attrs),
        summary,
        body,
      })
    }
  }
  return matches
}

class DetailsWidget extends WidgetType {
  constructor(
    readonly from: number,
    readonly openByDefault: boolean,
    readonly summary: string,
    readonly body: string,
    readonly readOnly: boolean,
  ) {
    super()
  }

  eq(other: DetailsWidget): boolean {
    return (
      other.openByDefault === this.openByDefault &&
      other.summary === this.summary &&
      other.body === this.body &&
      other.readOnly === this.readOnly
    )
  }

  updateDOM(dom: HTMLElement): boolean {
    dom.dataset.from = String(this.from)
    return true
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-burley-details-wrap'
    wrap.dataset.from = String(this.from)
    wrap.setAttribute('spellcheck', 'false')

    const details = document.createElement('details')
    details.className = 'cm-burley-details'
    if (this.openByDefault) details.open = true
    details.addEventListener('toggle', () => view.requestMeasure())

    const summaryEl = document.createElement('summary')
    summaryEl.className = 'cm-burley-details-summary'

    const label = document.createElement('span')
    label.className = 'cm-burley-details-label'
    label.innerHTML = renderMarkdown(this.summary).replace(/^<p>|<\/p>\s*$/g, '')
    summaryEl.appendChild(label)

    if (!this.readOnly) {
      const editBtn = document.createElement('button')
      editBtn.type = 'button'
      editBtn.className = 'cm-burley-details-edit'
      editBtn.title = 'Edit raw <details> block'
      editBtn.textContent = '</>'
      editBtn.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        const pos = Number(wrap.dataset.from ?? this.from)
        view.dispatch({ selection: { anchor: pos } })
        view.focus()
      })
      summaryEl.appendChild(editBtn)
    }

    const bodyEl = document.createElement('div')
    bodyEl.className = 'cm-burley-details-body'
    bodyEl.innerHTML = renderMarkdown(this.body)

    details.appendChild(summaryEl)
    details.appendChild(bodyEl)
    wrap.appendChild(details)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildDetailsDecorations(state: EditorState): DecorationSet {
  const readOnly = state.facet(readOnlyFacet)
  const decorations: Range<Decoration>[] = []
  for (const m of findDetailsBlocks(state)) {
    if (!readOnly && selectionTouches(state, m.from, m.to)) continue
    decorations.push(
      Decoration.replace({
        widget: new DetailsWidget(m.from, m.openByDefault, m.summary, m.body, readOnly),
        block: true,
      }).range(m.from, m.to),
    )
  }
  return Decoration.set(decorations, true)
}

export function detailsField(): Extension {
  return StateField.define<DecorationSet>({
    create: buildDetailsDecorations,
    update(deco, tr) {
      if (
        tr.docChanged ||
        tr.reconfigured ||
        mouseSelectingEnded(tr) ||
        tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)
      ) {
        return buildDetailsDecorations(tr.state)
      }
      if (isMouseSelecting(tr.state)) return deco
      if (tr.selection) {
        return buildDetailsDecorations(tr.state)
      }
      return deco
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}
