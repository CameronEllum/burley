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
