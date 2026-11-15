/**
 * `/` slash commands in the editor.
 *
 * Typing `/` at the start of a line (or after whitespace, outside code and
 * math) opens the CodeMirror autocomplete popup with block templates. Selecting
 * one replaces the slash query and places the caret inside the new block.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { isInCode } from './cm'
import { mathAt } from './math'

interface SlashItem {
  label: string
  detail: string
  info: string
}

const FENCE = '```'

function isoDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

const items: SlashItem[] = [
  { label: 'plotly', detail: 'chart', info: 'Insert a ```plotly JSON block' },
  { label: 'math', detail: 'block', info: 'Insert a $$ display-math block' },
  { label: 'table', detail: 'GFM', info: 'Insert a 3×2 table template' },
  { label: 'callout', detail: 'note', info: 'Insert a > [!NOTE] callout' },
  { label: 'warning', detail: 'callout', info: 'Insert a > [!WARNING] callout' },
  { label: 'tip', detail: 'callout', info: 'Insert a > [!TIP] callout' },
  { label: 'code', detail: 'fence', info: 'Insert a fenced code block' },
  { label: 'date', detail: 'today', info: 'Insert today’s date as YYYY-MM-DD' },
  { label: 'lua', detail: 'cell', info: 'Insert a runnable ```lua-run cell' },
]

interface Insertion {
  text: string
  /** Caret offset inside `text`. */
  caret: number
  /** Optional selection end (defaults to the caret). */
  selectEnd?: number
}

function buildInsertion(label: string): Insertion | null {
  switch (label) {
    case 'plotly': {
      const text = `${FENCE}plotly\n{\n  "data": [{ "type": "scatter", "x": [1, 2, 3], "y": [4, 1, 6] }],\n  "layout": { "title": "New chart" }\n}\n${FENCE}`
      return { text, caret: text.indexOf('"data"') }
    }
    case 'math': {
      const text = '$$\n\n$$'
      return { text, caret: 3 }
    }
    case 'table': {
      const text = '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n|  |  |'
      const caret = 2
      return { text, caret, selectEnd: caret + 'Column 1'.length }
    }
    case 'callout': {
      const text = '> [!NOTE]\n> '
      return { text, caret: text.length }
    }
    case 'warning': {
      const text = '> [!WARNING]\n> '
      return { text, caret: text.length }
    }
    case 'tip': {
      const text = '> [!TIP]\n> '
      return { text, caret: text.length }
    }
    case 'code':
      return { text: `${FENCE}\n\n${FENCE}`, caret: 3 }
    case 'date': {
      const text = isoDate()
      return { text, caret: text.length }
    }
    case 'lua':
      return { text: `${FENCE}lua-run\n\n${FENCE}`, caret: FENCE.length + 'lua-run\n'.length }
    default:
      return null
  }
}

/** True when the caret sits inside `$…$`, `$$…$$` or a code construct. */
function insideProtected(state: EditorState, pos: number): boolean {
  if (isInCode(state, Math.max(0, pos - 1), pos)) return true
  if (mathAt(state, pos)) return true
  return false
}

function applyInsertion(view: EditorView, from: number, to: number, insertion: Insertion): void {
  const start = from
  view.dispatch({
    changes: { from: start, to, insert: insertion.text },
    selection: {
      anchor: start + insertion.caret,
      head: start + (insertion.selectEnd ?? insertion.caret),
    },
    scrollIntoView: true,
    userEvent: 'input.complete',
  })
  view.focus()
}

export function slashCommands(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  const match = /(?:^|\s)\/([a-zA-Z0-9-]*)$/.exec(before)
  if (!match) return null
  if (insideProtected(ctx.state, ctx.pos)) return null

  const query = match[1]
  const from = ctx.pos - query.length
  const options: Completion[] = items.map((item) => ({
    label: item.label,
    detail: item.detail,
    info: item.info,
    type: 'keyword',
    boost: item.label.startsWith(query) ? 1 : 0,
    apply: (view: EditorView, _completion: Completion, applyFrom: number, applyTo: number) => {
      const insertion = buildInsertion(item.label)
      if (!insertion) return
      // `applyFrom` starts after the slash, so include it in the replacement.
      applyInsertion(view, Math.max(0, applyFrom - 1), applyTo, insertion)
    },
  }))

  return { from, options, validFor: /^[a-zA-Z0-9-]*$/ }
}
