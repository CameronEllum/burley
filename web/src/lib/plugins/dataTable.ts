/**
 * Live data-table renderer for ```` ```table ```` fenced blocks.
 *
 * Supports:
 *   - `src: ./data/metrics.csv` (or `.tsv`, `.json`) — auto-reloads when the
 *     underlying file changes on disk via Burley's assetVersion pipeline.
 *   - Inline CSV, TSV, or JSON directly inside the fence.
 *
 * Features interactive column sorting (numeric-aware) and instant row filtering.
 */
import { errorBox, registerBlockRenderer, type BlockContext, type BlockRenderer } from '../blockPlugins'

export interface ParsedDataTable {
  headers: string[]
  rows: string[][]
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseDelimitedText(text: string, delimiter?: string): ParsedDataTable {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  if (!normalized) return { headers: [], rows: [] }

  const sep =
    delimiter ??
    (() => {
      const firstLine = normalized.split('\n', 1)[0] ?? ''
      const tabs = (firstLine.match(/\t/g) ?? []).length
      const commas = (firstLine.match(/,/g) ?? []).length
      return tabs > commas ? '\t' : ','
    })()

  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (inQuotes) {
      if (ch === '"' && normalized[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === sep) {
      row.push(field.trim())
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field.trim())
      records.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }
  row.push(field.trim())
  records.push(row)

  const nonEmpty = records.filter((r) => r.some((cell) => cell !== ''))
  if (nonEmpty.length === 0) return { headers: [], rows: [] }

  const headers = nonEmpty[0]
  const colCount = Math.max(headers.length, ...nonEmpty.map((r) => r.length))
  while (headers.length < colCount) headers.push(`Col ${headers.length + 1}`)

  const bodyRows = nonEmpty.slice(1).map((r) => {
    const padded = [...r]
    while (padded.length < colCount) padded.push('')
    return padded.slice(0, colCount)
  })
  return { headers, rows: bodyRows }
}

export function parseJsonTable(text: string): ParsedDataTable {
  const data = JSON.parse(text)
  if (Array.isArray(data)) {
    if (data.length === 0) return { headers: [], rows: [] }
    if (Array.isArray(data[0])) {
      const headers = (data[0] as unknown[]).map((v) => String(v ?? ''))
      const rows = (data.slice(1) as unknown[][]).map((r) =>
        headers.map((_, i) => String(r?.[i] ?? '')),
      )
      return { headers, rows }
    }
    if (typeof data[0] === 'object' && data[0] !== null) {
      const headers: string[] = []
      const seen = new Set<string>()
      for (const item of data) {
        if (item && typeof item === 'object') {
          for (const key of Object.keys(item as Record<string, unknown>)) {
            if (!seen.has(key)) {
              seen.add(key)
              headers.push(key)
            }
          }
        }
      }
      const rows = data.map((item) => {
        const obj = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
        return headers.map((h) => {
          const val = obj[h]
          if (val === null || val === undefined) return ''
          if (typeof val === 'object') return JSON.stringify(val)
          return String(val)
        })
      })
      return { headers, rows }
    }
  }
  if (data && typeof data === 'object' && Array.isArray((data as any).headers) && Array.isArray((data as any).rows)) {
    const headers = ((data as any).headers as unknown[]).map((v) => String(v ?? ''))
    const rows = ((data as any).rows as unknown[][]).map((r) =>
      headers.map((_, i) => String(r?.[i] ?? '')),
    )
    return { headers, rows }
  }
  throw new Error('JSON must be an array of objects, array of arrays, or { headers, rows }')
}

export function parseTableText(text: string, hint = '', delimiter?: string): ParsedDataTable {
  const trimmed = text.trim()
  if (!trimmed) return { headers: [], rows: [] }
  if (hint.toLowerCase().endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJsonTable(trimmed)
  }
  if (hint.toLowerCase().endsWith('.tsv') && !delimiter) {
    return parseDelimitedText(trimmed, '\t')
  }
  return parseDelimitedText(trimmed, delimiter)
}

function compareValues(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) {
    return na - nb
  }
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

async function loadTableData(ctx: BlockContext): Promise<{ table: ParsedDataTable; label: string }> {
  const body = ctx.code.trim()
  if (!body) throw new Error('empty table block')

  const srcMatch = /^(?:src|file)\s*:\s*(.+)$/im.exec(body)
  const delimMatch = /^delimiter\s*:\s*(.+)$/im.exec(body)
  const delimiter = delimMatch ? stripQuotes(delimMatch[1]) : undefined

  if (srcMatch && !body.startsWith('{') && !body.startsWith('[')) {
    const ref = stripQuotes(srcMatch[1])
    const url = ctx.assetUrl(ref)
    if (!url) throw new Error(`cannot resolve data file "${ref}" relative to ${ctx.filePath || 'the vault root'}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`failed to load "${ref}" (HTTP ${res.status})`)
    const text = await res.text()
    return { table: parseTableText(text, ref, delimiter), label: ref }
  }

  return { table: parseTableText(body, '', delimiter), label: '' }
}

const dataTableRenderer: BlockRenderer = {
  render(ctx) {
    const root = document.createElement('div')
    root.className = 'burley-data-table'
    const status = document.createElement('div')
    status.className = 'burley-block-loading'
    status.textContent = 'Loading table…'
    root.appendChild(status)

    void (async () => {
      try {
        const { table, label } = await loadTableData(ctx)
        if (!root.isConnected) return
        root.innerHTML = ''
        if (table.headers.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'burley-block-loading'
          empty.textContent = 'Empty data table'
          root.appendChild(empty)
          return
        }

        let filterText = ''
        let sortCol = -1
        let sortDir: 1 | -1 = 1

        const bar = document.createElement('div')
        bar.className = 'burley-dt-bar'

        const search = document.createElement('input')
        search.type = 'search'
        search.className = 'burley-dt-filter'
        search.placeholder = 'Filter rows…'
        search.setAttribute('aria-label', 'Filter table rows')

        const meta = document.createElement('span')
        meta.className = 'burley-dt-meta'

        bar.append(search, meta)
        if (label) {
          const srcTag = document.createElement('span')
          srcTag.className = 'burley-dt-src'
          srcTag.textContent = label
          bar.appendChild(srcTag)
        }

        const scroller = document.createElement('div')
        scroller.className = 'burley-dt-scroll'
        const tableEl = document.createElement('table')
        const thead = document.createElement('thead')
        const tbody = document.createElement('tbody')
        tableEl.append(thead, tbody)
        scroller.appendChild(tableEl)
        root.append(bar, scroller)

        const headRow = document.createElement('tr')
        const headerButtons: HTMLButtonElement[] = []
        table.headers.forEach((h, colIdx) => {
          const th = document.createElement('th')
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = 'burley-dt-sort'
          btn.textContent = h
          btn.addEventListener('mousedown', (e) => e.stopPropagation())
          btn.addEventListener('click', (e) => {
            e.preventDefault()
            e.stopPropagation()
            if (sortCol === colIdx) {
              if (sortDir === 1) sortDir = -1
              else sortCol = -1
            } else {
              sortCol = colIdx
              sortDir = 1
            }
            paintRows()
          })
          headerButtons.push(btn)
          th.appendChild(btn)
          headRow.appendChild(th)
        })
        thead.appendChild(headRow)

        const paintRows = () => {
          const q = filterText.trim().toLowerCase()
          let visible = q
            ? table.rows.filter((r) => r.some((cell) => cell.toLowerCase().includes(q)))
            : [...table.rows]

          if (sortCol >= 0) {
            visible.sort((a, b) => compareValues(a[sortCol] ?? '', b[sortCol] ?? '') * sortDir)
          }

          headerButtons.forEach((btn, idx) => {
            const arrow = sortCol === idx ? (sortDir === 1 ? ' ▲' : ' ▼') : ''
            btn.textContent = `${table.headers[idx]}${arrow}`
            btn.classList.toggle('active', sortCol === idx)
          })

          meta.textContent = q
            ? `${visible.length} / ${table.rows.length} rows`
            : `${table.rows.length} rows × ${table.headers.length} cols`

          tbody.innerHTML = ''
          const limit = 500
          const slice = visible.slice(0, limit)
          for (const row of slice) {
            const tr = document.createElement('tr')
            for (const cell of row) {
              const td = document.createElement('td')
              td.textContent = cell
              tr.appendChild(td)
            }
            tbody.appendChild(tr)
          }
          if (visible.length > limit) {
            const tr = document.createElement('tr')
            const td = document.createElement('td')
            td.colSpan = table.headers.length
            td.className = 'burley-dt-truncated'
            td.textContent = `Showing first ${limit} of ${visible.length} matching rows.`
            tr.appendChild(td)
            tbody.appendChild(tr)
          }
        }

        search.addEventListener('input', () => {
          filterText = search.value
          paintRows()
        })
        search.addEventListener('keydown', (e) => e.stopPropagation())
        search.addEventListener('mousedown', (e) => e.stopPropagation())

        paintRows()
      } catch (err) {
        if (!root.isConnected) return
        root.innerHTML = ''
        root.appendChild(errorBox(err))
      }
    })()

    return root
  },
}

registerBlockRenderer('table', dataTableRenderer)
