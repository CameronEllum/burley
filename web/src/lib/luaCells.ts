/**
 * `lua-run` live cells for the live preview.
 *
 * Unlike fenced-code widgets, a runnable cell keeps its source visible: a small
 * ▶ Run button is added to the opening fence and the output panel is a block
 * widget inserted after the closing fence. Outputs live in editor state, never
 * in the Markdown file, so git diffs stay clean.
 */
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { renderMarkdown } from './markdown'
import { getActiveView } from './viewRef'
import type { LuaCellValue } from './lua/worker'

export interface LuaCellOutput {
  stdout: string
  value: LuaCellValue | null
  error?: string
  durationMs: number
}

export interface LuaCellState {
  running: boolean
  output?: LuaCellOutput
}

export const setLuaCellState = StateEffect.define<{ key: string; state: LuaCellState | null }>()

let runHandler: ((code: string) => void) | null = null

/** Registered by the editor with the runner implementation. */
export function setLuaCellRunHandler(handler: ((code: string) => void) | null): void {
  runHandler = handler
}

/** Stable identity for a cell: its source text. */
export function luaKey(code: string): string {
  let hash = 5381
  for (let i = 0; i < code.length; i++) hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0
  return `${code.length}:${(hash >>> 0).toString(36)}`
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

interface LuaToken {
  from: number
  to: number
  cls: string
}

const tokenCache = new Map<string, LuaToken[]>()

/** Tokenize Lua with highlight.js and flatten spans to document offsets. */
function highlightLua(code: string): LuaToken[] {
  const cached = tokenCache.get(code)
  if (cached) return cached

  const tokens: LuaToken[] = []
  try {
    const container = document.createElement('div')
    container.innerHTML = hljs.highlight(code, { language: 'lua', ignoreIllegals: true }).value
    let offset = 0
    const walk = (node: Node, inherited: string) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ''
        if (text.length > 0 && inherited) tokens.push({ from: offset, to: offset + text.length, cls: inherited })
        offset += text.length
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const element = node as HTMLElement
      const cls = element.className || inherited
      for (const child of Array.from(element.childNodes)) walk(child, cls)
    }
    for (const child of Array.from(container.childNodes)) walk(child, '')
  } catch {
    return []
  }

  if (tokenCache.size > 64) tokenCache.clear()
  tokenCache.set(code, tokens)
  return tokens
}

class RunWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly running: boolean,
  ) {
    super()
  }

  eq(other: RunWidget): boolean {
    return other.code === this.code && other.running === this.running
  }

  toDOM(): HTMLElement {
    const wrap = el('span', 'cm-burley-lua-run')
    wrap.dataset.cell = this.code.replace(/\s+/g, ' ').trim().slice(0, 80)
    const button = el('button', 'cm-burley-lua-btn', this.running ? 'Running…' : '▶ Run')
    button.type = 'button'
    button.disabled = this.running
    button.title = 'Run this cell in the sandboxed Lua VM'
    button.addEventListener('mousedown', (event) => event.stopPropagation())
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (!this.running) runHandler?.(this.code)
    })
    wrap.appendChild(button)
    wrap.appendChild(el('span', 'cm-burley-lua-badge', 'Lua'))
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function renderValue(value: LuaCellValue, body: HTMLElement): void {
  if (value.kind === 'markdown') {
    const div = el('div', 'cm-burley-lua-markdown')
    div.innerHTML = renderMarkdown(value.text ?? '')
    body.appendChild(div)
    return
  }
  if (value.kind === 'html') {
    const div = el('div', 'cm-burley-lua-html')
    div.innerHTML = DOMPurify.sanitize(value.text ?? '', { ADD_ATTR: ['target', 'rel'] })
    body.appendChild(div)
    return
  }
  if (value.kind === 'table') {
    const table = el('table', 'cm-burley-lua-table')
    const headers = value.headers ?? []
    const rows = value.rows ?? []
    if (headers.length > 0) {
      const thead = el('thead')
      const tr = el('tr')
      for (const header of headers) tr.appendChild(el('th', undefined, header))
      thead.appendChild(tr)
      table.appendChild(thead)
    }
    const tbody = el('tbody')
    for (const row of rows) {
      const tr = el('tr')
      for (const cell of row) tr.appendChild(el('td', undefined, cell))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    body.appendChild(table)
    return
  }
  body.appendChild(el('pre', 'cm-burley-lua-pre', value.text ?? ''))
}

class OutputWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly output: LuaCellOutput,
  ) {
    super()
  }

  eq(other: OutputWidget): boolean {
    return other.key === this.key && other.output === this.output
  }

  toDOM(): HTMLElement {
    const wrap = el('div', 'cm-burley-lua-output')
    const head = el('div', 'cm-burley-lua-output-head')
    head.appendChild(el('span', 'cm-burley-lua-output-title', this.output.error ? 'Lua error' : 'Lua output'))
    head.appendChild(el('span', 'cm-burley-lua-output-time', `${this.output.durationMs} ms`))
    head.appendChild(el('span', 'cm-burley-block-spacer'))
    const clear = el('button', 'cm-burley-block-btn', 'Clear')
    clear.type = 'button'
    clear.title = 'Clear this output'
    clear.addEventListener('mousedown', (event) => event.stopPropagation())
    clear.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const view = getView()
      if (view) view.dispatch({ effects: setLuaCellState.of({ key: this.key, state: null }) })
    })
    head.appendChild(clear)
    wrap.appendChild(head)

    const body = el('div', 'cm-burley-lua-output-body')
    if (this.output.error) {
      body.appendChild(el('pre', 'cm-burley-lua-error', this.output.error))
    } else {
      if (this.output.stdout) body.appendChild(el('pre', 'cm-burley-lua-pre', this.output.stdout))
      if (this.output.value) renderValue(this.output.value, body)
      if (!this.output.stdout && !this.output.value) {
        body.appendChild(el('span', 'cm-burley-lua-empty', 'No output — use print() or return a value.'))
      }
    }
    wrap.appendChild(body)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function getView(): EditorView | null {
  return getActiveView()
}
interface CellFieldValue {
  states: Map<string, LuaCellState>
  decorations: DecorationSet
}

function build(state: EditorState, states: Map<string, LuaCellState>): DecorationSet {
  const decorations: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      const info = node.node.getChild('CodeInfo')
      if (!info) return
      const lang = state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase()
      if (lang !== 'lua-run') return
      const codeNode = node.node.getChild('CodeText')
      const code = codeNode ? state.doc.sliceString(codeNode.from, codeNode.to).replace(/\n$/, '') : ''
      const key = luaKey(code)
      const cell = states.get(key)

      // Style the whole fence like a code block (monospace + syntax colors).
      const startLine = state.doc.lineAt(node.from)
      const endLine = state.doc.lineAt(node.to)
      for (let n = startLine.number; n <= endLine.number; n++) {
        const line = state.doc.line(n)
        const classes = ['cm-burley-lua-source']
        if (n === startLine.number) classes.push('cm-burley-lua-first')
        if (n === endLine.number) classes.push('cm-burley-lua-last')
        decorations.push(Decoration.line({ class: classes.join(' ') }).range(line.from))
      }
      if (codeNode) {
        const raw = state.doc.sliceString(codeNode.from, codeNode.to)
        for (const token of highlightLua(raw)) {
          let from = codeNode.from + token.from
          const to = codeNode.from + token.to
          while (from < to) {
            const line = state.doc.lineAt(from)
            const end = Math.min(to, line.to)
            if (end > from) decorations.push(Decoration.mark({ class: token.cls }).range(from, end))
            from = line.to + 1
          }
        }
      }

      decorations.push(
        Decoration.widget({ widget: new RunWidget(code, !!cell?.running), side: 1 }).range(info.to),
      )
      if (cell?.output) {
        decorations.push(
          Decoration.widget({ widget: new OutputWidget(key, cell.output), block: true, side: 1 }).range(node.to),
        )
      }
    },
  })
  return Decoration.set(decorations, true)
}

const cellField = StateField.define<CellFieldValue>({
  create: (state) => ({ states: new Map(), decorations: build(state, new Map()) }),
  update(value, tr) {
    let states = value.states
    let changed = tr.docChanged || tr.reconfigured

    for (const effect of tr.effects) {
      if (!effect.is(setLuaCellState)) continue
      states = new Map(states)
      if (effect.value.state) states.set(effect.value.key, effect.value.state)
      else states.delete(effect.value.key)
      changed = true
    }

    if (!changed) return value
    return { states, decorations: build(tr.state, states) }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  // Keep DOM output stable across selection changes.
  compare(a, b) {
    return a.states === b.states && a.decorations === b.decorations
  },
})

/** Rendered `lua-run` cells with Run buttons and output panels. */
export function luaCellsField(): Extension {
  return cellField
}

/** Current state map, used by the runner to preserve output while re-running. */
export function luaCellState(view: EditorView, key: string): LuaCellState | undefined {
  return view.state.field(cellField).states.get(key)
}
