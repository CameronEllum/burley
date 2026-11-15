/**
 * Obsidian-style editable GFM tables.
 *
 * A Table node is always replaced with an HTML table widget (even while the
 * cursor is inside). Cell edits are committed to the Markdown buffer on blur,
 * Tab, Enter or structural actions, and only the table's own range is replaced,
 * so the rest of the document stays byte-identical.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { previewGeometryChanged, readOnlyFacet } from './cm'
import { getActiveView } from './viewRef'

type Alignment = 'left' | 'center' | 'right' | null

interface TableData {
  rows: string[][]
  alignments: Alignment[]
  indent: string
}

const SEPARATOR = /^:?-{2,}:?$/

function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += ch
  }
  cells.push(cell.trim())
  return cells
}

export function parseGfmTable(raw: string): TableData | null {
  const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines.length < 2) return null
  const indent = lines[0].match(/^\s*/)?.[0] ?? ''
  const header = splitRow(lines[0])
  const separator = splitRow(lines[1])
  if (header.length === 0 || separator.length !== header.length) return null
  if (!separator.every((cell) => SEPARATOR.test(cell))) return null

  const alignments: Alignment[] = separator.map((cell) => {
    const value = cell.trim()
    if (value.startsWith(':') && value.endsWith(':')) return 'center'
    if (value.endsWith(':')) return 'right'
    if (value.startsWith(':')) return 'left'
    return null
  })

  const rows = [header]
  for (const line of lines.slice(2)) {
    if (!line.includes('|')) continue
    rows.push(splitRow(line))
  }
  const columns = Math.max(header.length, ...rows.map((row) => row.length))
  for (const row of rows) {
    while (row.length < columns) row.push('')
  }
  while (alignments.length < columns) alignments.push(null)
  return { rows, alignments: alignments.slice(0, columns), indent }
}

export function serializeGfmTable(table: TableData): string {
  const escape = (value: string) => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
  const separator = table.alignments.map((align) =>
    align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---',
  )
  const formatRow = (cells: string[]) =>
    `${table.indent}| ${cells.map((cell, index) => escape(cell ?? '') || ' ').join(' | ')} |`
  const lines = [formatRow(table.rows[0]), `${table.indent}| ${separator.join(' | ')} |`]
  for (const row of table.rows.slice(1)) lines.push(formatRow(row))
  return lines.join('\n')
}

class TableWidget extends WidgetType {
  constructor(
    readonly table: TableData,
    readonly from: number,
    readonly to: number,
    readonly readOnly: boolean,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return (
      other.readOnly === this.readOnly &&
      JSON.stringify(other.table) === JSON.stringify(this.table)
    )
  }

  toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-burley-table-widget'
    root.style.position = 'relative'

    const view = getActiveView()
    const table = document.createElement('table')
    let activeRow = 0
    let activeCol = 0

    const readRows = (): string[][] =>
      Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll<HTMLElement>('[data-cell]')).map(
          (cell) => cell.textContent?.trim() ?? '',
        ),
      )

    const focusCell = (row: number, column: number) => {
      if (!view) return
      requestAnimationFrame(() => {
        const selector = `.cm-burley-table-widget [data-cell][data-row="${row}"][data-col="${column}"]`
        const cell = view.contentDOM.querySelector<HTMLElement>(selector)
        if (!cell) return
        cell.focus()
        const range = document.createRange()
        range.selectNodeContents(cell)
        range.collapse(false)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      })
    }

    const commit = (
      rows: string[][],
      alignments: Alignment[],
      focus?: [number, number],
    ) => {
      if (!view) return
      const next = serializeGfmTable({ rows, alignments, indent: this.table.indent })
      view.dispatch({ changes: { from: this.from, to: this.to, insert: next } })
      if (focus) focusCell(focus[0], focus[1])
    }

    const commitCurrent = (focus?: [number, number]) => {
      commit(readRows(), this.table.alignments, focus)
    }

    const addRow = (focus = true) => {
      const rows = readRows()
      rows.push(Array.from({ length: this.table.alignments.length }, () => ''))
      commit(rows, this.table.alignments, focus ? [rows.length - 1, 0] : undefined)
    }

    const addColumn = () => {
      const rows = readRows()
      for (const row of rows) row.push('')
      const alignments = [...this.table.alignments, null]
      commit(rows, alignments, [0, alignments.length - 1])
    }

    const deleteRow = () => {
      const rows = readRows()
      if (rows.length <= 1) return
      const target = Math.min(Math.max(activeRow, 1), rows.length - 1)
      rows.splice(target, 1)
      commit(rows, this.table.alignments, [Math.max(1, target - 1), activeCol])
    }

    const deleteColumn = () => {
      if (this.table.alignments.length <= 1) return
      const rows = readRows()
      for (const row of rows) row.splice(activeCol, 1)
      const alignments = this.table.alignments.filter((_, index) => index !== activeCol)
      commit(rows, alignments, [0, Math.max(0, activeCol - 1)])
    }

    const cycleAlignment = (column: number) => {
      const order: Alignment[] = [null, 'left', 'center', 'right']
      const alignments = [...this.table.alignments]
      const current = order.indexOf(alignments[column] ?? null)
      alignments[column] = order[(current + 1) % order.length]
      commit(readRows(), alignments)
    }

    const makeCell = (
      text: string,
      row: number,
      column: number,
      header: boolean,
    ): HTMLTableCellElement => {
      const cell = document.createElement(header ? 'th' : 'td')
      if (this.table.alignments[column]) cell.style.textAlign = this.table.alignments[column]!
      const textSpan = document.createElement('span')
      textSpan.className = 'cm-burley-table-cell'
      textSpan.dataset.cell = ''
      textSpan.dataset.row = String(row)
      textSpan.dataset.col = String(column)
      textSpan.textContent = text
      textSpan.contentEditable = this.readOnly ? 'false' : 'true'
      textSpan.spellcheck = false
      textSpan.addEventListener('focus', () => {
        activeRow = row
        activeCol = column
      })
      textSpan.addEventListener('keydown', (event) => {
        if (this.readOnly) return
        if (event.key === 'Escape') {
          event.preventDefault()
          commitCurrent()
          getActiveView()?.focus()
          return
        }
        const lastColumn = this.table.alignments.length - 1
        if (event.key === 'Tab') {
          event.preventDefault()
          const delta = event.shiftKey ? -1 : 1
          let nextRow = row
          let nextCol = column + delta
          if (nextCol > lastColumn) {
            nextCol = 0
            nextRow += 1
          } else if (nextCol < 0) {
            nextCol = lastColumn
            nextRow -= 1
          }
          if (nextRow >= this.table.rows.length) {
            addRow(true)
            return
          }
          if (nextRow < 0) {
            focusCell(0, 0)
            return
          }
          commitCurrent([nextRow, nextCol])
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const nextRow = row + 1
          if (nextRow >= this.table.rows.length) addRow(true)
          else commitCurrent([nextRow, column])
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          focusCell(Math.min(row + 1, this.table.rows.length - 1), column)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          focusCell(Math.max(row - 1, 0), column)
        }
      })
      cell.appendChild(textSpan)

      if (header && !this.readOnly) {
        const alignButton = document.createElement('button')
        alignButton.type = 'button'
        alignButton.className = 'cm-burley-table-align'
        alignButton.title = 'Cycle column alignment'
        alignButton.textContent =
          this.table.alignments[column] === 'center'
            ? '↔'
            : this.table.alignments[column] === 'right'
              ? '→'
              : this.table.alignments[column] === 'left'
                ? '←'
                : '—'
        alignButton.addEventListener('mousedown', (event) => event.stopPropagation())
        alignButton.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          cycleAlignment(column)
        })
        cell.appendChild(alignButton)
      }
      return cell
    }

    const thead = document.createElement('thead')
    const headerRow = document.createElement('tr')
    this.table.rows[0].forEach((text, column) => headerRow.appendChild(makeCell(text, 0, column, true)))
    thead.appendChild(headerRow)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (let row = 1; row < this.table.rows.length; row++) {
      const tr = document.createElement('tr')
      this.table.rows[row].forEach((text, column) =>
        tr.appendChild(makeCell(text, row, column, false)),
      )
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    if (!this.readOnly) {
      table.addEventListener('focusout', (event) => {
        const next = event.relatedTarget as Node | null
        if (next && root.contains(next)) return
        commitCurrent()
      })
    }
    root.appendChild(table)

    if (!this.readOnly) {
      const tools = document.createElement('div')
      tools.className = 'cm-burley-table-tools'
      const addButton = (label: string, title: string, action: () => void) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'cm-burley-table-btn'
        button.textContent = label
        button.title = title
        button.addEventListener('mousedown', (event) => event.stopPropagation())
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          action()
        })
        tools.appendChild(button)
      }
      addButton('+ Row', 'Add row', () => addRow())
      addButton('+ Col', 'Add column', addColumn)
      addButton('− Row', 'Delete active row', deleteRow)
      addButton('− Col', 'Delete active column', deleteColumn)
      root.appendChild(tools)

      const addRowEdge = document.createElement('button')
      addRowEdge.type = 'button'
      addRowEdge.className = 'cm-burley-table-edge-row'
      addRowEdge.title = 'Add row'
      addRowEdge.textContent = '+'
      addRowEdge.addEventListener('mousedown', (event) => event.stopPropagation())
      addRowEdge.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        addRow()
      })
      root.appendChild(addRowEdge)

      const addColEdge = document.createElement('button')
      addColEdge.type = 'button'
      addColEdge.className = 'cm-burley-table-edge-col'
      addColEdge.title = 'Add column'
      addColEdge.textContent = '+'
      addColEdge.addEventListener('mousedown', (event) => event.stopPropagation())
      addColEdge.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        addColumn()
      })
      root.appendChild(addColEdge)
    }

    return root
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      const raw = state.doc.sliceString(node.from, node.to)
      const table = parseGfmTable(raw)
      if (!table) return
      decorations.push(
        Decoration.replace({
          widget: new TableWidget(table, node.from, node.to, readOnly),
          block: true,
        }).range(node.from, node.to),
      )
    },
  })
  return Decoration.set(decorations, true)
}

/** Editable GFM tables (replaces the library's read-only tableField). */
export function tableEditorField(): Extension {
  return StateField.define<DecorationSet>({
    create: buildTableDecorations,
    update(deco, tr) {
      if (tr.docChanged || tr.reconfigured || previewGeometryChanged(tr)) return buildTableDecorations(tr.state)
      return deco
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}
