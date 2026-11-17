/**
 * Obsidian-style properties card for a note's YAML frontmatter.
 *
 * A leading `---` block is replaced by a read-only card whenever the cursor is
 * outside of it. Clicking a property (or Edit) drops the cursor onto that line
 * so the raw YAML is revealed in place, exactly like fenced code blocks.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { isMouseSelecting, mouseSelectingEnded, selectionTouches } from './cm'
import { getActiveView } from './viewRef'

export interface FrontmatterRow {
  key: string
  /** Scalar value; empty for lists and maps. */
  value: string
  /** Sequence items (tags, aliases, …). */
  items: string[]
  /** Nested `key: value` pairs. */
  children: FrontmatterRow[]
  /** Document offset of the key, used for click-to-edit. */
  pos: number
}

export interface FrontmatterBlock {
  /** Start of the opening fence. */
  from: number
  /** End of the closing fence. */
  to: number
  /** Start of the first YAML line (line 2). */
  bodyFrom: number
  rows: FrontmatterRow[]
  /** Lines that are not simple key/value YAML, shown verbatim. */
  extra: string[]
  /** Stable content signature for widget reuse. */
  signature: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    if ((first === '"' || first === "'") && trimmed.endsWith(first)) {
      return trimmed.slice(1, -1).replace(first === '"' ? /\\"/g : /''/g, first)
    }
  }
  return trimmed
}

function splitList(value: string): string[] {
  if (!value.trim()) return []
  return value
    .split(',')
    .map((item) => unquote(item))
    .filter(Boolean)
}

/** Parse a frontmatter block from the top of the document, if present. */
export function parseFrontmatter(state: EditorState): FrontmatterBlock | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  if (doc.line(1).text.replace(/^\uFEFF/, '').trim() !== '---') return null

  let close = 0
  for (let n = 2; n <= doc.lines; n++) {
    const text = doc.line(n).text.trim()
    if (text === '---' || text === '...') {
      close = n
      break
    }
  }
  if (!close) return null

  const rows: FrontmatterRow[] = []
  const extra: string[] = []
  let current: FrontmatterRow | null = null

  for (let n = 2; n < close; n++) {
    const line = doc.line(n)
    const text = line.text
    const trimmed = text.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      current = null
      continue
    }
    const indent = text.length - text.trimStart().length
    const pair = /^([^:#][^:]*):(?:\s+(.*))?$/.exec(trimmed)

    if (indent === 0 && pair) {
      const key = pair[1].trim()
      const rawValue = (pair[2] ?? '').trim()
      const row: FrontmatterRow = { key, value: '', items: [], children: [], pos: line.from }
      if (rawValue) {
        const inlineList = /^\[(.*)\]$/.exec(rawValue)
        if (inlineList) row.items = splitList(inlineList[1])
        else row.value = unquote(rawValue)
        current = null
      } else {
        current = row
      }
      rows.push(row)
      continue
    }

    if (current && indent > 0) {
      if (/^-\s+/.test(trimmed)) {
        current.items.push(unquote(trimmed.replace(/^-\s+/, '')))
        continue
      }
      if (pair) {
        current.children.push({
          key: pair[1].trim(),
          value: unquote((pair[2] ?? '').trim()),
          items: [],
          children: [],
          pos: line.from + indent,
        })
        continue
      }
    }

    extra.push(trimmed)
  }

  return {
    from: doc.line(1).from,
    to: doc.line(close).to,
    bodyFrom: doc.line(2).from,
    rows,
    extra,
    signature: JSON.stringify([rows.map(stripPos), extra]),
  }
}

function stripPos(row: FrontmatterRow): unknown {
  return [row.key, row.value, row.items, row.children.map(stripPos)]
}

const TAG_KEYS = new Set(['tags', 'tag'])

function isTagKey(key: string): boolean {
  return TAG_KEYS.has(key.toLowerCase())
}

function isLinkValue(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^mailto:/i.test(value)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function editAt(pos: number): void {
  const view = getActiveView()
  if (!view) return
  const anchor = Math.min(pos, view.state.doc.length)
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
  view.focus()
}

function rowLabel(row: FrontmatterRow): HTMLSpanElement {
  const key = el('span', 'cm-burley-fm-key', row.key)
  key.title = `Edit ${row.key}`
  return key
}

function valueNode(row: FrontmatterRow): HTMLElement {
  if (row.items.length > 0) {
    const wrap = el('span', isTagKey(row.key) ? 'cm-burley-fm-tags' : 'cm-burley-fm-chips')
    for (const item of row.items) {
      const text = isTagKey(row.key) && !item.startsWith('#') ? `#${item}` : item
      wrap.appendChild(el('span', isTagKey(row.key) ? 'cm-burley-fm-tag' : 'cm-burley-fm-chip', text))
    }
    return wrap
  }
  if (row.children.length > 0) {
    const wrap = el('span', 'cm-burley-fm-map')
    for (const child of row.children) {
      const line = el('span', 'cm-burley-fm-map-row')
      line.appendChild(el('span', 'cm-burley-fm-subkey', child.key))
      line.appendChild(el('span', 'cm-burley-fm-value', child.value || '—'))
      wrap.appendChild(line)
    }
    return wrap
  }
  if (!row.value) return el('span', 'cm-burley-fm-empty', '—')
  if (isLinkValue(row.value)) {
    const link = el('a', 'cm-burley-fm-link', row.value)
    link.href = row.value
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    return link
  }
  return el('span', 'cm-burley-fm-value', row.value)
}

function rowElement(row: FrontmatterRow): HTMLDivElement {
  const line = el('div', 'cm-burley-fm-row')
  line.appendChild(rowLabel(row))
  line.appendChild(valueNode(row))
  line.addEventListener('mousedown', (event) => event.stopPropagation())
  line.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) return
    event.preventDefault()
    editAt(row.pos)
  })
  return line
}

class FrontmatterWidget extends WidgetType {
  constructor(readonly block: FrontmatterBlock) {
    super()
  }

  eq(other: FrontmatterWidget): boolean {
    return other.block.signature === this.block.signature
  }

  toDOM(): HTMLElement {
    const wrap = el('div', 'cm-burley-frontmatter-wrap')
    const card = el('div', 'cm-burley-frontmatter')
    const head = el('div', 'cm-burley-frontmatter-head')
    head.appendChild(el('span', 'cm-burley-frontmatter-title', 'Properties'))
    const count = this.block.rows.length
    head.appendChild(
      el('span', 'cm-burley-frontmatter-count', count === 0 ? 'empty' : `${count} propert${count === 1 ? 'y' : 'ies'}`),
    )
    head.appendChild(el('span', 'cm-burley-block-spacer'))
    const edit = el('button', 'cm-burley-block-btn', 'Edit')
    edit.type = 'button'
    edit.title = 'Show the raw YAML'
    edit.addEventListener('mousedown', (event) => event.stopPropagation())
    edit.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      editAt(this.block.bodyFrom)
    })
    head.appendChild(edit)
    card.appendChild(head)

    const body = el('div', 'cm-burley-frontmatter-body')
    if (this.block.rows.length === 0 && this.block.extra.length === 0) {
      body.appendChild(el('p', 'cm-burley-fm-empty', 'No properties yet — click Edit to add some.'))
    }
    for (const row of this.block.rows) body.appendChild(rowElement(row))
    if (this.block.extra.length > 0) {
      const raw = el('pre', 'cm-burley-fm-raw', this.block.extra.join('\n'))
      body.appendChild(raw)
    }
    card.appendChild(body)
    wrap.appendChild(card)

    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const block = parseFrontmatter(state)
  if (!block) return Decoration.none

  const decos: Range<Decoration>[] = []
  const editing = selectionTouches(state, block.bodyFrom, block.to)

  if (editing) {
    for (let pos = block.from; pos <= block.to; ) {
      const line = state.doc.lineAt(pos)
      decos.push(Decoration.line({ class: 'cm-burley-frontmatter-source' }).range(line.from))
      if (line.to >= block.to) break
      pos = line.to + 1
    }
    return Decoration.set(decos, true)
  }

  decos.push(Decoration.replace({ widget: new FrontmatterWidget(block), block: true }).range(block.from, block.to))
  return Decoration.set(decos, true)
}

/** Live-preview rendering for a leading YAML frontmatter block. */
export function frontmatterField(): Extension {
  return StateField.define<DecorationSet>({
    create: buildDecorations,
    update(deco, tr) {
      if (tr.docChanged || tr.reconfigured || mouseSelectingEnded(tr)) return buildDecorations(tr.state)
      if (isMouseSelecting(tr.state)) return deco
      if (tr.selection) return buildDecorations(tr.state)
      return deco
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}
