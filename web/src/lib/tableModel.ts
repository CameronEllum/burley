/**
 * Pure GFM pipe-table model: parsing, serialization, equality, and immutable
 * row/column/alignment transforms. Kept DOM- and CodeMirror-free so it can be
 * unit-tested directly.
 */

export type Alignment = 'left' | 'center' | 'right' | null

export interface TableData {
  rows: string[][]
  alignments: Alignment[]
  indent: string
}

const SEPARATOR = /^:?-{1,}:?$/

function countPrecedingBackslashes(text: string, index: number): number {
  let count = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) count++
  return count
}

export function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && countPrecedingBackslashes(text, text.length - 1) % 2 === 0) {
    text = text.slice(0, -1)
  }

  const cells: string[] = []
  let cell = ''
  let codeFenceLen = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`') {
      let run = 1
      while (i + run < text.length && text[i + run] === '`') run++
      if (codeFenceLen === 0) {
        codeFenceLen = run
      } else if (run === codeFenceLen) {
        codeFenceLen = 0
      }
      cell += text.slice(i, i + run)
      i += run - 1
      continue
    }

    if (codeFenceLen === 0) {
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1]
        if (next === '|') {
          cell += '|'
          i++
          continue
        }
        if (next === '\\') {
          cell += '\\\\'
          i++
          continue
        }
      }
      if (ch === '|') {
        cells.push(cell.trim())
        cell = ''
        continue
      }
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

  const rows: string[][] = [header]
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

function escapeCell(value: string): string {
  const singleLine = (value ?? '').replace(/\r?\n/g, '<br>').trim()
  if (!singleLine) return ' '
  let out = ''
  for (let i = 0; i < singleLine.length; i++) {
    const ch = singleLine[i]
    if (ch === '\\' && singleLine[i + 1] === '\\') {
      out += '\\\\'
      i++
      continue
    }
    if (ch === '\\' && singleLine[i + 1] === '|') {
      out += '\\|'
      i++
      continue
    }
    if (ch === '|') {
      out += '\\|'
      continue
    }
    out += ch
  }
  return out
}

export function serializeGfmTable(table: TableData): string {
  const separator = table.alignments.map((align) =>
    align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---',
  )
  const formatRow = (cells: string[]) =>
    `${table.indent}| ${cells.map((cell) => escapeCell(cell)).join(' | ')} |`
  const lines = [formatRow(table.rows[0]), `${table.indent}| ${separator.join(' | ')} |`]
  for (const row of table.rows.slice(1)) lines.push(formatRow(row))
  return lines.join('\n')
}

export function tableDataEquals(a: TableData, b: TableData): boolean {
  if (a.indent !== b.indent) return false
  if (a.alignments.length !== b.alignments.length) return false
  for (let i = 0; i < a.alignments.length; i++) {
    if (a.alignments[i] !== b.alignments[i]) return false
  }
  if (a.rows.length !== b.rows.length) return false
  for (let r = 0; r < a.rows.length; r++) {
    const ar = a.rows[r]
    const br = b.rows[r]
    if (ar.length !== br.length) return false
    for (let c = 0; c < ar.length; c++) {
      if (ar[c] !== br[c]) return false
    }
  }
  return true
}

export function cloneTableData(table: TableData): TableData {
  return {
    indent: table.indent,
    alignments: [...table.alignments],
    rows: table.rows.map((row) => [...row]),
  }
}

export function updateCell(
  table: TableData,
  row: number,
  col: number,
  value: string,
): TableData {
  if (row < 0 || row >= table.rows.length) return table
  if (col < 0 || col >= table.alignments.length) return table
  const next = cloneTableData(table)
  next.rows[row][col] = value.replace(/\r?\n/g, '<br>').trim()
  return next
}

export function insertRowAt(table: TableData, index: number): TableData {
  const next = cloneTableData(table)
  const clamped = Math.max(1, Math.min(index, next.rows.length))
  next.rows.splice(
    clamped,
    0,
    Array.from({ length: next.alignments.length }, () => ''),
  )
  return next
}

export function deleteRowAt(table: TableData, index: number): TableData | null {
  if (table.rows.length <= 1 || index < 1 || index >= table.rows.length) return null
  const next = cloneTableData(table)
  next.rows.splice(index, 1)
  return next
}

export function insertColumnAt(table: TableData, index: number): TableData {
  const next = cloneTableData(table)
  const clamped = Math.max(0, Math.min(index, next.alignments.length))
  next.alignments.splice(clamped, 0, null)
  for (const row of next.rows) row.splice(clamped, 0, '')
  return next
}

export function deleteColumnAt(table: TableData, index: number): TableData | null {
  if (table.alignments.length <= 1 || index < 0 || index >= table.alignments.length) return null
  const next = cloneTableData(table)
  next.alignments.splice(index, 1)
  for (const row of next.rows) row.splice(index, 1)
  return next
}

export function cycleColumnAlignment(table: TableData, col: number): TableData {
  if (col < 0 || col >= table.alignments.length) return table
  const order: Alignment[] = [null, 'left', 'center', 'right']
  const next = cloneTableData(table)
  const current = order.indexOf(next.alignments[col] ?? null)
  next.alignments[col] = order[(current + 1) % order.length]
  return next
}
