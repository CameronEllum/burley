/**
 * Editable GFM tables with pure display-mode text selection, double-click
 * plain-text cell editing, hover (+)/(−)/alignment controls, and a per-table
 * raw Markdown toggle.
 */
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { filePathFacet, previewGeometryChanged, readOnlyFacet } from './cm'
import { getLinkClickBehavior, openTableLink } from './links'
import { renderMarkdown } from './markdown'
import {
  cycleColumnAlignment,
  deleteColumnAt,
  deleteRowAt,
  insertColumnAt,
  insertRowAt,
  parseGfmTable,
  serializeGfmTable,
  tableDataEquals,
  updateCell,
  type Alignment,
  type TableData,
} from './tableModel'

export { parseGfmTable, serializeGfmTable }

interface TableRange {
  from: number
  to: number
}

const setRawTableRange = StateEffect.define<TableRange | null>()

function findTableNodeAt(state: EditorState, pos: number): TableRange | null {
  const clamped = Math.max(0, Math.min(pos, state.doc.length))
  const tree = syntaxTree(state)
  for (const side of [1, -1] as const) {
    let node: ReturnType<typeof tree.resolveInner>['node'] | null = tree.resolveInner(clamped, side).node
    while (node) {
      if (node.name === 'Table') return { from: node.from, to: node.to }
      node = node.parent
    }
  }
  return null
}

function findTableNodeIntersecting(state: EditorState, from: number, to: number): TableRange | null {
  let found: TableRange | null = null
  syntaxTree(state).iterate({
    from: Math.max(0, from),
    to: Math.min(state.doc.length, to),
    enter: (node) => {
      if (found) return false
      if (node.name === 'Table') {
        found = { from: node.from, to: node.to }
        return false
      }
    },
  })
  return found
}

const rawTableField = StateField.define<TableRange | null>({
  create: () => null,
  update(value, tr) {
    if (tr.state.facet(readOnlyFacet)) return null
    for (const effect of tr.effects) {
      if (effect.is(setRawTableRange)) return effect.value
    }
    if (!value) return null

    let next: TableRange | null = value
    if (tr.docChanged) {
      const mappedFrom = tr.changes.mapPos(value.from, 1)
      const mappedTo = tr.changes.mapPos(value.to, -1)
      next =
        findTableNodeAt(tr.state, tr.state.selection.main.head) ??
        findTableNodeAt(tr.state, mappedFrom) ??
        findTableNodeIntersecting(tr.state, Math.min(mappedFrom, mappedTo), Math.max(mappedFrom, mappedTo))
      if (!next) return null
    }

    const sel = tr.state.selection.main
    if (sel.from < next.from || sel.to > next.to) return null
    return next
  },
})

function resolveTableRange(view: EditorView, root: HTMLElement): TableRange | null {
  try {
    const pos = view.posAtDOM(root)
    return (
      findTableNodeAt(view.state, pos) ??
      findTableNodeIntersecting(view.state, pos - 1, pos + 1)
    )
  } catch {
    return null
  }
}

function renderCellHtml(raw: string): string {
  if (!raw) return ''
  return renderMarkdown(raw).replace(/^<p>|<\/p>\s*$/g, '')
}

function alignGlyph(align: Alignment): string {
  if (align === 'center') return '↔'
  if (align === 'right') return '→'
  if (align === 'left') return '←'
  return '—'
}

interface ActiveEdit {
  row: number
  col: number
  textarea: HTMLTextAreaElement
  cell: HTMLTableCellElement
  viewDiv: HTMLElement
}

class TableController {
  private readonly scrollWrap: HTMLDivElement
  private readonly tableEl: HTMLTableElement
  private readonly theadEl: HTMLTableSectionElement
  private readonly tbodyEl: HTMLTableSectionElement
  private readonly overlayEl: HTMLDivElement
  private readonly rowGuideEl: HTMLDivElement
  private readonly colGuideEl: HTMLDivElement
  private readonly rowAddBtn: HTMLButtonElement
  private readonly rowDelBtn: HTMLButtonElement
  private readonly colAddBtn: HTMLButtonElement
  private readonly colPillEl: HTMLDivElement
  private readonly colAlignBtn: HTMLButtonElement
  private readonly colDelBtn: HTMLButtonElement
  private readonly rawBtn: HTMLButtonElement

  private activeEdit: ActiveEdit | null = null
  private pendingEdit: [number, number] | null = null
  private ignoreBlur = false
  private committing = false
  private destroyed = false

  private hoverInsertRow = 1
  private hoverDeleteRow = -1
  private hoverInsertCol = 0
  private hoverCol = -1
  private downX = 0
  private downY = 0
  private dragAnchor: { node: Node; offset: number } | null = null
  private dragMoved = false
  private readonly onDocMouseMove = (event: MouseEvent) => this.handleDragMove(event)
  private readonly onDocMouseUp = () => this.handleDragEnd()

  constructor(
    private readonly root: HTMLDivElement,
    private view: EditorView,
    private table: TableData,
    private readOnly: boolean,
    private currentFile: string,
  ) {
    this.scrollWrap = document.createElement('div')
    this.scrollWrap.className = 'cm-burley-table-scroll'
    this.scrollWrap.tabIndex = -1

    this.tableEl = document.createElement('table')
    this.tableEl.className = 'cm-burley-table'
    this.theadEl = document.createElement('thead')
    this.tbodyEl = document.createElement('tbody')
    this.tableEl.append(this.theadEl, this.tbodyEl)
    this.scrollWrap.appendChild(this.tableEl)

    this.overlayEl = document.createElement('div')
    this.overlayEl.className = 'cm-burley-table-overlay'

    this.rowGuideEl = document.createElement('div')
    this.rowGuideEl.className = 'cm-burley-table-guide-row'

    this.colGuideEl = document.createElement('div')
    this.colGuideEl.className = 'cm-burley-table-guide-col'

    this.rowAddBtn = this.makeCtrlButton('cm-burley-table-ctrl cm-burley-table-add-row', '+', 'Insert row')
    this.rowDelBtn = this.makeCtrlButton('cm-burley-table-ctrl cm-burley-table-del-row', '−', 'Delete row')
    this.colAddBtn = this.makeCtrlButton('cm-burley-table-ctrl cm-burley-table-add-col', '+', 'Insert column')

    this.colPillEl = document.createElement('div')
    this.colPillEl.className = 'cm-burley-table-ctrl cm-burley-table-col-pill'
    this.colAlignBtn = this.makeCtrlButton('cm-burley-table-col-btn', '—', 'Cycle column alignment')
    this.colDelBtn = this.makeCtrlButton('cm-burley-table-col-btn danger', '−', 'Delete column')
    this.colPillEl.append(this.colAlignBtn, this.colDelBtn)

    this.rawBtn = this.makeCtrlButton('cm-burley-table-ctrl cm-burley-table-raw-btn', '</>', 'Edit raw Markdown')

    this.overlayEl.append(
      this.rowGuideEl,
      this.colGuideEl,
      this.rowAddBtn,
      this.rowDelBtn,
      this.colAddBtn,
      this.colPillEl,
      this.rawBtn,
    )

    this.root.append(this.scrollWrap, this.overlayEl)
    this.bindEvents()
    this.applyReadOnlyState()
    this.renderTable()
  }

  private makeCtrlButton(className: string, text: string, title: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = className
    btn.textContent = text
    btn.title = title
    btn.tabIndex = -1
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    return btn
  }

  private caretPointInsideTable(clientX: number, clientY: number): { node: Node; offset: number } | null {
    const rect = this.tableEl.getBoundingClientRect()
    const x = Math.max(rect.left + 2, Math.min(clientX, rect.right - 2))
    const y = Math.max(rect.top + 2, Math.min(clientY, rect.bottom - 2))
    const doc = document as Document & {
      caretPositionFromPoint?: (px: number, py: number) => { offsetNode: Node; offset: number } | null
    }
    if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y)
      if (range && this.tableEl.contains(range.startContainer)) {
        return { node: range.startContainer, offset: range.startOffset }
      }
    } else if (typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y)
      if (pos && this.tableEl.contains(pos.offsetNode)) {
        return { node: pos.offsetNode, offset: pos.offset }
      }
    }
    return null
  }

  private handleDragMove(event: MouseEvent): void {
    if (!this.dragAnchor) return
    if (!this.dragMoved && Math.hypot(event.clientX - this.downX, event.clientY - this.downY) <= 2) {
      return
    }
    if (!this.dragMoved) {
      this.dragMoved = true
      this.scrollWrap.focus({ preventScroll: true })
    }
    const focus = this.caretPointInsideTable(event.clientX, event.clientY)
    if (!focus) return
    window.getSelection()?.setBaseAndExtent(
      this.dragAnchor.node,
      this.dragAnchor.offset,
      focus.node,
      focus.offset,
    )
  }

  private handleDragEnd(): void {
    this.dragAnchor = null
    this.dragMoved = false
    document.removeEventListener('mousemove', this.onDocMouseMove)
    document.removeEventListener('mouseup', this.onDocMouseUp)
  }

  private bindEvents(): void {
    this.scrollWrap.addEventListener('mousedown', (event) => {
      this.downX = event.clientX
      this.downY = event.clientY
      // Clear any lingering CM6 selection when interacting inside the table so
      // two selections never appear at once.
      if (!this.view.state.selection.main.empty) {
        this.view.dispatch({ selection: { anchor: this.view.state.selection.main.head } })
      }
      const target = event.target as HTMLElement | null
      if (this.activeEdit && !target?.closest('textarea.cm-burley-table-input')) {
        this.commitActiveCell()
      }
      if (event.button === 0 && !target?.closest('textarea, button')) {
        const anchor = this.caretPointInsideTable(event.clientX, event.clientY)
        if (anchor) {
          this.dragAnchor = anchor
          this.dragMoved = false
          event.preventDefault()
          window.getSelection()?.removeAllRanges()
          document.addEventListener('mousemove', this.onDocMouseMove)
          document.addEventListener('mouseup', this.onDocMouseUp)
        }
      }
    })

    this.scrollWrap.addEventListener('keydown', (event) => {
      if (event.target !== this.scrollWrap) return
      if (event.key === 'Escape') {
        window.getSelection()?.removeAllRanges()
        this.view.focus()
      }
    })

    this.tableEl.addEventListener('click', (event) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
      if (!anchor) return
      if (Math.hypot(event.clientX - this.downX, event.clientY - this.downY) > 4) {
        event.preventDefault()
        return
      }
      if (!this.readOnly && (event.ctrlKey || event.metaKey) && getLinkClickBehavior() === 'toggle') {
        event.preventDefault()
        event.stopPropagation()
        const cell = anchor.closest<HTMLTableCellElement>('th, td')
        if (cell) {
          this.startEditing(Number(cell.dataset.row), Number(cell.dataset.col))
        }
        return
      }
      const href = anchor.getAttribute('href') ?? ''
      if (openTableLink(href, this.currentFile)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (!anchor.target) {
        anchor.target = '_blank'
        anchor.rel = 'noopener noreferrer'
      }
      event.stopPropagation()
    })

    this.tableEl.addEventListener('dblclick', (event) => {
      if (this.readOnly) return
      const target = event.target as HTMLElement | null
      if (target?.closest('a') && !event.ctrlKey && !event.metaKey) return
      const cell = target?.closest<HTMLTableCellElement>('th, td')
      if (!cell) return
      const row = Number(cell.dataset.row)
      const col = Number(cell.dataset.col)
      if (Number.isNaN(row) || Number.isNaN(col)) return
      if (this.activeEdit && this.activeEdit.row === row && this.activeEdit.col === col) return
      event.preventDefault()
      event.stopPropagation()
      window.getSelection()?.removeAllRanges()
      this.startEditing(row, col)
    })

    this.rowAddBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.readOnly) return
      const draft = this.readDraftTable()
      const idx = Math.max(1, Math.min(this.hoverInsertRow, draft.rows.length))
      this.commitTable(insertRowAt(draft, idx), [idx, 0])
    })

    this.rowDelBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.readOnly || this.hoverDeleteRow < 1) return
      const draft = this.readDraftTable()
      const next = deleteRowAt(draft, this.hoverDeleteRow)
      if (!next) return
      this.commitTable(next, null, true)
    })

    this.colAddBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.readOnly) return
      const draft = this.readDraftTable()
      const idx = Math.max(0, Math.min(this.hoverInsertCol, draft.alignments.length))
      this.commitTable(insertColumnAt(draft, idx), [0, idx])
    })

    this.colAlignBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.readOnly || this.hoverCol < 0) return
      const draft = this.readDraftTable()
      this.commitTable(cycleColumnAlignment(draft, this.hoverCol), null, true)
    })

    this.colDelBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.readOnly || this.hoverCol < 0) return
      const draft = this.readDraftTable()
      const next = deleteColumnAt(draft, this.hoverCol)
      if (!next) return
      this.commitTable(next, null, true)
    })

    this.rawBtn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.readOnly) return
      this.commitActiveCell()
      const range = resolveTableRange(this.view, this.root)
      if (!range) return
      this.view.dispatch({
        effects: setRawTableRange.of(range),
        selection: { anchor: range.from },
        scrollIntoView: true,
      })
      this.view.focus()
    })

    this.root.addEventListener('mousemove', (event) => {
      if (this.readOnly) return
      if ((event.target as HTMLElement | null)?.closest('.cm-burley-table-ctrl')) return
      this.updateOverlay(event.clientX, event.clientY)
    })

    this.root.addEventListener('mouseleave', () => {
      this.hideHoverOverlay()
    })

    this.scrollWrap.addEventListener('scroll', () => {
      this.hideHoverOverlay()
    })
  }

  sync(view: EditorView, table: TableData, readOnly: boolean, currentFile: string): void {
    this.view = view
    this.table = table
    const roChanged = this.readOnly !== readOnly
    const fileChanged = this.currentFile !== currentFile
    this.readOnly = readOnly
    this.currentFile = currentFile
    if (roChanged) {
      if (readOnly) this.closeEditorDom()
      this.applyReadOnlyState()
    }
    this.renderTable(fileChanged)
    if (this.pendingEdit && !this.readOnly) {
      const [row, col] = this.pendingEdit
      this.pendingEdit = null
      if (this.root.isConnected) {
        this.startEditing(row, col)
      } else {
        requestAnimationFrame(() => {
          if (!this.destroyed && this.root.isConnected) this.startEditing(row, col)
        })
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    this.handleDragEnd()
    this.closeEditorDom()
  }

  private applyReadOnlyState(): void {
    this.root.classList.toggle('is-readonly', this.readOnly)
    this.overlayEl.hidden = this.readOnly
    if (this.readOnly) this.hideHoverOverlay()
  }

  private renderTable(forceRender = false): void {
    const { rows, alignments } = this.table
    if (rows.length === 0) return

    this.syncSectionRow(this.theadEl, 0, rows[0], alignments, true, forceRender)
    while (this.theadEl.rows.length > 1) this.theadEl.deleteRow(this.theadEl.rows.length - 1)

    const bodyCount = Math.max(0, rows.length - 1)
    for (let r = 1; r < rows.length; r++) {
      this.syncSectionRow(this.tbodyEl, r - 1, rows[r], alignments, false, forceRender)
    }
    while (this.tbodyEl.rows.length > bodyCount) this.tbodyEl.deleteRow(this.tbodyEl.rows.length - 1)
  }

  private syncSectionRow(
    section: HTMLTableSectionElement,
    sectionIndex: number,
    cells: string[],
    alignments: Alignment[],
    header: boolean,
    forceRender: boolean,
  ): void {
    const globalRow = header ? 0 : sectionIndex + 1
    let tr = section.rows[sectionIndex]
    if (!tr) {
      tr = document.createElement('tr')
      section.appendChild(tr)
    }

    const cellTag = header ? 'th' : 'td'
    for (let col = 0; col < cells.length; col++) {
      let cell = tr.cells[col] as HTMLTableCellElement | undefined
      if (!cell || cell.tagName.toLowerCase() !== cellTag) {
        const nextCell = document.createElement(cellTag)
        const viewDiv = document.createElement('div')
        viewDiv.className = 'cm-burley-table-cell-view'
        nextCell.appendChild(viewDiv)
        if (cell) {
          tr.replaceChild(nextCell, cell)
        } else {
          tr.appendChild(nextCell)
        }
        cell = nextCell
      }

      const align = alignments[col] ?? null
      cell.style.textAlign = align ?? ''
      cell.dataset.row = String(globalRow)
      cell.dataset.col = String(col)

      const isEditingThis =
        this.activeEdit?.row === globalRow && this.activeEdit?.col === col
      const rawText = cells[col] ?? ''
      const viewDiv =
        cell.querySelector<HTMLElement>('.cm-burley-table-cell-view') ??
        (() => {
          const d = document.createElement('div')
          d.className = 'cm-burley-table-cell-view'
          cell.appendChild(d)
          return d
        })()

      if (isEditingThis && this.activeEdit) {
        this.activeEdit.textarea.style.textAlign = align ?? ''
      }

      if (forceRender || cell.dataset.raw !== rawText) {
        cell.dataset.raw = rawText
        viewDiv.innerHTML = renderCellHtml(rawText)
      }
    }

    while (tr.cells.length > cells.length) {
      tr.deleteCell(tr.cells.length - 1)
    }
  }

  private findCell(row: number, col: number): HTMLTableCellElement | null {
    return this.tableEl.querySelector<HTMLTableCellElement>(
      `[data-row="${row}"][data-col="${col}"]`,
    )
  }

  private readDraftTable(): TableData {
    if (!this.activeEdit) return this.table
    return updateCell(
      this.table,
      this.activeEdit.row,
      this.activeEdit.col,
      this.activeEdit.textarea.value,
    )
  }

  private startEditing(row: number, col: number): void {
    if (this.readOnly) return
    const clampedRow = Math.max(0, Math.min(row, this.table.rows.length - 1))
    const clampedCol = Math.max(0, Math.min(col, this.table.alignments.length - 1))
    const cell = this.findCell(clampedRow, clampedCol)
    if (!cell) return

    if (this.activeEdit) {
      if (this.activeEdit.row === clampedRow && this.activeEdit.col === clampedCol) {
        this.activeEdit.textarea.focus()
        return
      }
      this.commitActiveCell()
      const refreshedCell = this.findCell(clampedRow, clampedCol)
      if (!refreshedCell) return
      this.openEditorInCell(refreshedCell, clampedRow, clampedCol)
      return
    }
    this.openEditorInCell(cell, clampedRow, clampedCol)
  }

  private openEditorInCell(cell: HTMLTableCellElement, row: number, col: number): void {
    const viewDiv = cell.querySelector<HTMLElement>('.cm-burley-table-cell-view')
    if (!viewDiv) return

    const ta = document.createElement('textarea')
    ta.className = 'cm-burley-table-input'
    ta.rows = 1
    ta.spellcheck = false
    ta.value = this.table.rows[row]?.[col] ?? ''
    ta.style.textAlign = this.table.alignments[col] ?? ''

    const autoResize = () => {
      ta.style.height = 'auto'
      ta.style.height = `${ta.scrollHeight}px`
    }

    ta.addEventListener('input', autoResize)
    ta.addEventListener('blur', () => {
      if (this.ignoreBlur) return
      this.commitActiveCell()
    })

    ta.addEventListener('keydown', (event) => {
      if (this.readOnly) return

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        this.commitActiveCell()
        const range = resolveTableRange(this.view, this.root)
        const docLen = this.view.state.doc.length
        const afterPos = range ? Math.min(docLen, range.to + 1) : this.view.state.selection.main.head
        this.view.dispatch({
          selection: { anchor: afterPos },
          scrollIntoView: true,
        })
        this.view.focus()
        return
      }

      if (event.key === 'Tab') {
        event.preventDefault()
        event.stopPropagation()
        const cols = this.table.alignments.length
        const delta = event.shiftKey ? -1 : 1
        let nextRow = row
        let nextCol = col + delta
        if (nextCol >= cols) {
          nextCol = 0
          nextRow++
        } else if (nextCol < 0) {
          nextCol = cols - 1
          nextRow--
        }
        if (nextRow < 0) {
          this.commitActiveCell([0, 0])
          return
        }
        if (nextRow >= this.table.rows.length) {
          const draft = this.readDraftTable()
          this.commitTable(insertRowAt(draft, draft.rows.length), [draft.rows.length, 0])
          return
        }
        this.commitActiveCell([nextRow, nextCol])
        return
      }

      if (event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        const start = ta.selectionStart ?? ta.value.length
        const end = ta.selectionEnd ?? start
        const insert = '<br>'
        ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end)
        const caret = start + insert.length
        ta.setSelectionRange(caret, caret)
        autoResize()
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        if (row + 1 >= this.table.rows.length) {
          const draft = this.readDraftTable()
          this.commitTable(insertRowAt(draft, draft.rows.length), [draft.rows.length, col])
          return
        }
        this.commitActiveCell([row + 1, col])
        return
      }

      if (
        event.key === 'ArrowUp' &&
        row > 0 &&
        ta.selectionStart === ta.selectionEnd &&
        !ta.value.slice(0, ta.selectionStart).includes('\n')
      ) {
        event.preventDefault()
        event.stopPropagation()
        this.commitActiveCell([row - 1, col])
        return
      }

      if (
        event.key === 'ArrowDown' &&
        row + 1 < this.table.rows.length &&
        ta.selectionStart === ta.selectionEnd &&
        !ta.value.slice(ta.selectionEnd).includes('\n')
      ) {
        event.preventDefault()
        event.stopPropagation()
        this.commitActiveCell([row + 1, col])
      }
    })

    viewDiv.hidden = true
    cell.classList.add('is-editing')
    cell.appendChild(ta)
    this.activeEdit = { row, col, textarea: ta, cell, viewDiv }
    autoResize()
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
  }

  private closeEditorDom(): void {
    const active = this.activeEdit
    if (!active) return
    this.ignoreBlur = true
    try {
      active.textarea.remove()
      active.viewDiv.hidden = false
      active.cell.classList.remove('is-editing')
    } finally {
      this.activeEdit = null
      this.ignoreBlur = false
    }
  }

  private commitActiveCell(nextEditCell: [number, number] | null = null): void {
    if (!this.activeEdit) {
      if (nextEditCell) this.startEditing(nextEditCell[0], nextEditCell[1])
      return
    }
    const nextTable = this.readDraftTable()
    this.commitTable(nextTable, nextEditCell)
  }

  private commitTable(
    nextTable: TableData,
    nextEditCell: [number, number] | null = null,
    focusEditorView = false,
  ): void {
    if (this.committing) return
    this.committing = true
    try {
      const range = resolveTableRange(this.view, this.root)
      if (!range) {
        this.closeEditorDom()
        return
      }
      const nextText = serializeGfmTable(nextTable)
      const currentText = this.view.state.doc.sliceString(range.from, range.to)

      this.closeEditorDom()

      if (nextText === currentText) {
        if (nextEditCell) this.startEditing(nextEditCell[0], nextEditCell[1])
        else if (focusEditorView) this.view.focus()
        return
      }

      this.pendingEdit = nextEditCell
      this.view.dispatch({
        changes: { from: range.from, to: range.to, insert: nextText },
        userEvent: 'input.table',
      })
      if (!nextEditCell && focusEditorView) {
        this.view.focus()
      }
    } finally {
      this.committing = false
    }
  }

  private hideHoverOverlay(): void {
    this.rowGuideEl.classList.remove('is-visible')
    this.colGuideEl.classList.remove('is-visible')
    this.rowAddBtn.classList.remove('is-visible', 'is-hint')
    this.rowDelBtn.classList.remove('is-visible')
    this.colAddBtn.classList.remove('is-visible', 'is-hint')
    this.colPillEl.classList.remove('is-visible')
    this.hoverDeleteRow = -1
    this.hoverCol = -1
  }

  private updateOverlay(clientX: number, clientY: number): void {
    const rootRect = this.root.getBoundingClientRect()
    const scrollRect = this.scrollWrap.getBoundingClientRect()
    const tableRect = this.tableEl.getBoundingClientRect()
    const mx = clientX - rootRect.left
    const my = clientY - rootRect.top

    const visLeft = Math.max(scrollRect.left, tableRect.left) - rootRect.left
    const visRight = Math.min(scrollRect.right, tableRect.right) - rootRect.left
    const tableLeft = visLeft
    const tableTop = tableRect.top - rootRect.top
    const tableBottom = tableRect.bottom - rootRect.top

    const trEls = Array.from(this.tableEl.rows)
    const rowRects = trEls.map((tr) => tr.getBoundingClientRect())
    const rowCount = rowRects.length

    // Row boundary detection (indices 1..rowCount; header row 0 cannot be preceded)
    let bestRowInsert = -1
    let bestRowDist = 9
    let bestRowY = 0
    for (let i = 1; i <= rowCount; i++) {
      const y = rowRects[i - 1].bottom - rootRect.top
      const dist = Math.abs(my - y)
      if (dist < bestRowDist) {
        bestRowDist = dist
        bestRowInsert = i
        bestRowY = y
      }
    }

    if (bestRowInsert !== -1 && mx >= tableLeft - 26 && mx <= visRight + 20) {
      this.hoverInsertRow = bestRowInsert
      this.hoverDeleteRow = -1
      this.rowGuideEl.style.left = `${tableLeft}px`
      this.rowGuideEl.style.width = `${Math.max(0, visRight - tableLeft)}px`
      this.rowGuideEl.style.top = `${bestRowY}px`
      this.rowGuideEl.classList.add('is-visible')

      this.rowAddBtn.style.left = `${tableLeft - 12}px`
      this.rowAddBtn.style.top = `${bestRowY}px`
      this.rowAddBtn.classList.remove('is-hint')
      this.rowAddBtn.classList.add('is-visible')
      this.rowDelBtn.classList.remove('is-visible')
    } else {
      this.rowGuideEl.classList.remove('is-visible')
      this.hoverInsertRow = rowCount
      this.rowAddBtn.style.left = `${tableLeft - 12}px`
      this.rowAddBtn.style.top = `${tableBottom}px`
      this.rowAddBtn.classList.remove('is-visible')
      this.rowAddBtn.classList.add('is-hint')

      let hoveredBodyRow = -1
      for (let r = 1; r < rowCount; r++) {
        const rTop = rowRects[r].top - rootRect.top
        const rBot = rowRects[r].bottom - rootRect.top
        if (my >= rTop && my <= rBot) {
          hoveredBodyRow = r
          this.rowDelBtn.style.left = `${tableLeft - 12}px`
          this.rowDelBtn.style.top = `${(rTop + rBot) / 2}px`
          break
        }
      }
      this.hoverDeleteRow = hoveredBodyRow
      this.rowDelBtn.classList.toggle('is-visible', hoveredBodyRow >= 1)
    }

    // Column detection
    const headerCells = this.theadEl.rows[0] ? Array.from(this.theadEl.rows[0].cells) : []
    const colRects = headerCells.map((cell) => cell.getBoundingClientRect())
    const colCount = colRects.length
    if (colCount === 0) return

    let bestColInsert = -1
    let bestColDist = 9
    let bestColX = 0
    for (let c = 0; c <= colCount; c++) {
      // Avoid fighting the left row gutter on col 0 unless near the top gutter
      if (c === 0 && mx < tableLeft - 2 && my > tableTop + 14) continue
      const rawX = c === 0 ? colRects[0].left : colRects[c - 1].right
      const x = rawX - rootRect.left
      if (x < visLeft - 2 || x > visRight + 2) continue
      const dist = Math.abs(mx - x)
      if (dist < bestColDist) {
        bestColDist = dist
        bestColInsert = c
        bestColX = x
      }
    }

    if (bestColInsert !== -1 && my >= tableTop - 24 && my <= tableBottom + 18) {
      this.hoverInsertCol = bestColInsert
      this.hoverCol = -1
      this.colGuideEl.style.left = `${bestColX}px`
      this.colGuideEl.style.top = `${tableTop}px`
      this.colGuideEl.style.height = `${Math.max(0, tableBottom - tableTop)}px`
      this.colGuideEl.classList.add('is-visible')

      this.colAddBtn.style.left = `${bestColX}px`
      this.colAddBtn.style.top = `${tableTop - 12}px`
      this.colAddBtn.classList.remove('is-hint')
      this.colAddBtn.classList.add('is-visible')
      this.colPillEl.classList.remove('is-visible')
    } else {
      this.colGuideEl.classList.remove('is-visible')
      this.hoverInsertCol = colCount
      this.colAddBtn.style.left = `${visRight + 12}px`
      this.colAddBtn.style.top = `${(tableTop + tableBottom) / 2}px`
      this.colAddBtn.classList.remove('is-visible')
      this.colAddBtn.classList.add('is-hint')

      let hoveredCol = -1
      for (let c = 0; c < colCount; c++) {
        const cLeft = Math.max(colRects[c].left - rootRect.left, visLeft)
        const cRight = Math.min(colRects[c].right - rootRect.left, visRight)
        if (cRight > cLeft && mx >= cLeft && mx <= cRight) {
          hoveredCol = c
          this.colPillEl.style.left = `${(cLeft + cRight) / 2}px`
          this.colPillEl.style.top = `${tableTop - 13}px`
          break
        }
      }
      this.hoverCol = hoveredCol
      if (hoveredCol >= 0) {
        this.colAlignBtn.textContent = alignGlyph(this.table.alignments[hoveredCol] ?? null)
        this.colDelBtn.hidden = colCount <= 1
        this.colPillEl.classList.add('is-visible')
      } else {
        this.colPillEl.classList.remove('is-visible')
      }
    }
  }
}

const controllers = new WeakMap<HTMLElement, TableController>()

class TableWidget extends WidgetType {
  constructor(
    readonly table: TableData,
    readonly readOnly: boolean,
    readonly currentFile: string,
  ) {
    super()
  }

  eq(other: TableWidget): boolean {
    return (
      other.readOnly === this.readOnly &&
      other.currentFile === this.currentFile &&
      tableDataEquals(other.table, this.table)
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-burley-table-widget'
    const controller = new TableController(root, view, this.table, this.readOnly, this.currentFile)
    controllers.set(root, controller)
    return root
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const controller = controllers.get(dom)
    if (!controller) return false
    controller.sync(view, this.table, this.readOnly, this.currentFile)
    return true
  }

  destroy(dom: HTMLElement): void {
    controllers.get(dom)?.destroy()
    controllers.delete(dom)
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildTableDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  const currentFile = state.facet(filePathFacet)
  const rawRange = state.field(rawTableField, false)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return
      if (!readOnly && rawRange && !(node.to < rawRange.from || node.from > rawRange.to)) return
      const raw = state.doc.sliceString(node.from, node.to)
      const table = parseGfmTable(raw)
      if (!table) return
      decorations.push(
        Decoration.replace({
          widget: new TableWidget(table, readOnly, currentFile),
          block: true,
        }).range(node.from, node.to),
      )
    },
  })
  return Decoration.set(decorations, true)
}

const tableDecorationsField = StateField.define<DecorationSet>({
  create: buildTableDecorations,
  update(deco, tr) {
    const rawChanged = tr.startState.field(rawTableField, false) !== tr.state.field(rawTableField, false)
    if (tr.docChanged || tr.reconfigured || previewGeometryChanged(tr) || rawChanged) {
      return buildTableDecorations(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Editable GFM tables (replaces the library's read-only tableField). */
export function tableEditorField(): Extension {
  return [rawTableField, tableDecorationsField]
}
