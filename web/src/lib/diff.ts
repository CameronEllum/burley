/** Small word-level diff used by the AI rewrite preview. */

export interface DiffPart {
  kind: 'same' | 'add' | 'del'
  text: string
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

/** Word-level diff; falls back to a plain replacement for very large inputs. */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length === 0) return b.map((text) => ({ kind: 'add', text }))
  if (b.length === 0) return a.map((text) => ({ kind: 'del', text }))
  if (a.length * b.length > 400_000) {
    return [
      { kind: 'del', text: before },
      { kind: 'add', text: after },
    ]
  }

  const rows = a.length + 1
  const cols = b.length + 1
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const parts: DiffPart[] = []
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = parts[parts.length - 1]
    if (last && last.kind === kind) last.text += text
    else parts.push({ kind, text })
  }

  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i])
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('del', a[i++])
    } else {
      push('add', b[j++])
    }
  }
  while (i < a.length) push('del', a[i++])
  while (j < b.length) push('add', b[j++])
  return parts
}

export interface LineDiffRow {
  kind: 'same' | 'add' | 'del'
  text: string
  oldLine: number | null
  newLine: number | null
}

/** Line-level diff for comparing file versions in the conflict viewer. */
export function lineDiff(before: string, after: string): LineDiffRow[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  if (a.length * b.length > 250_000) {
    return [
      ...a.map((text, idx) => ({ kind: 'del' as const, text, oldLine: idx + 1, newLine: null })),
      ...b.map((text, idx) => ({ kind: 'add' as const, text, oldLine: null, newLine: idx + 1 })),
    ]
  }

  const rows = a.length + 1
  const cols = b.length + 1
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: LineDiffRow[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], oldLine: i + 1, newLine: j + 1 })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], oldLine: i + 1, newLine: null })
      i++
    } else {
      out.push({ kind: 'add', text: b[j], oldLine: null, newLine: j + 1 })
      j++
    }
  }
  while (i < a.length) {
    out.push({ kind: 'del', text: a[i], oldLine: i + 1, newLine: null })
    i++
  }
  while (j < b.length) {
    out.push({ kind: 'add', text: b[j], oldLine: null, newLine: j + 1 })
    j++
  }
  return out
}
