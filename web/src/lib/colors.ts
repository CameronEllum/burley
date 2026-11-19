/**
 * Burley Markdown color dialect: parser, sanitizer/validator, theme presentation,
 * and inline span scanner shared across live preview, editable tables, chat, and exports.
 *
 * Inline syntax:
 *   [text]{.red}   [text]{.bg-amber}   [text]{#c2410c}   [text]{color=#... bg=#...}
 *   ==highlighted text==
 *
 * Table cell leading directive:
 *   | {.green} Healthy | {.bg-amber} Pending | {#fef3c7} Custom |
 */

export const PALETTE_COLORS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'gray',
] as const

export type PaletteColor = (typeof PALETTE_COLORS)[number]

export const COLOR_ALIASES: Record<string, PaletteColor> = {
  danger: 'red',
  yellow: 'amber',
  warn: 'amber',
  ok: 'green',
  info: 'blue',
  grey: 'gray',
  muted: 'gray',
}

const PALETTE_SET = new Set<string>(PALETTE_COLORS)

export function resolveNamedColor(raw: string): PaletteColor | null {
  const key = raw.trim().toLowerCase()
  if (PALETTE_SET.has(key)) return key as PaletteColor
  return COLOR_ALIASES[key] ?? null
}

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function normalizeHexColor(raw: string): string | null {
  const m = HEX_COLOR_RE.exec(raw.trim())
  if (!m) return null
  const hex = m[1].toLowerCase()
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
  }
  return `#${hex}`
}

export type ColorValue =
  | { kind: 'named'; name: PaletteColor }
  | { kind: 'hex'; hex: string }

export interface ColorSpec {
  cellTint?: PaletteColor
  fg?: ColorValue
  bg?: ColorValue
}

function parseColorValue(raw: string): ColorValue | null {
  const hex = normalizeHexColor(raw)
  if (hex) return { kind: 'hex', hex }
  const named = resolveNamedColor(raw)
  if (named) return { kind: 'named', name: named }
  return null
}

export function parseColorAttrs(attrStr: string, mode: 'inline' | 'cell'): ColorSpec | null {
  const tokens = attrStr.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const spec: ColorSpec = {}
  for (const token of tokens) {
    if (token.startsWith('.bg-')) {
      const name = resolveNamedColor(token.slice(4))
      if (!name) return null
      spec.bg = { kind: 'named', name }
      continue
    }
    if (token.startsWith('.text-') || token.startsWith('.fg-')) {
      const raw = token.startsWith('.text-') ? token.slice(6) : token.slice(4)
      const name = resolveNamedColor(raw)
      if (!name) return null
      spec.fg = { kind: 'named', name }
      continue
    }
    if (token.startsWith('.')) {
      const name = resolveNamedColor(token.slice(1))
      if (!name) return null
      if (mode === 'cell') spec.cellTint = name
      else spec.fg = { kind: 'named', name }
      continue
    }
    const hex = normalizeHexColor(token)
    if (hex) {
      if (mode === 'cell') spec.bg = { kind: 'hex', hex }
      else spec.fg = { kind: 'hex', hex }
      continue
    }
    const eq = token.indexOf('=')
    if (eq > 0) {
      const key = token.slice(0, eq).toLowerCase()
      const val = parseColorValue(token.slice(eq + 1))
      if (!val) return null
      if (key === 'bg') {
        spec.bg = val
        continue
      }
      if (key === 'color' || key === 'fg') {
        spec.fg = val
        continue
      }
    }
    return null
  }

  return spec
}

export function contrastInkForHex(hex: string): string {
  const normalized = normalizeHexColor(hex)
  if (!normalized) return '#1f1b18'
  const r = parseInt(normalized.slice(1, 3), 16)
  const g = parseInt(normalized.slice(3, 5), 16)
  const b = parseInt(normalized.slice(5, 7), 16)
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum > 155 ? '#1f1b18' : '#f8f6f2'
}

export interface ColorPresentation {
  classes: string[]
  style: string
  backgroundColor?: string
  color?: string
}

export function colorSpecToPresentation(
  spec: ColorSpec,
  mode: 'inline' | 'cell',
): ColorPresentation {
  const classes: string[] = []
  const styleParts: string[] = []
  let backgroundColor: string | undefined
  let color: string | undefined

  if (mode === 'cell') {
    if (spec.cellTint && !spec.bg) {
      classes.push(`burley-cell-tint-${spec.cellTint}`)
    }
    if (spec.bg) {
      if (spec.bg.kind === 'named') {
        classes.push(`burley-cell-bg-${spec.bg.name}`)
      } else {
        backgroundColor = spec.bg.hex
        styleParts.push(`background-color:${spec.bg.hex}`)
        if (!spec.fg && !spec.cellTint) {
          color = contrastInkForHex(spec.bg.hex)
          styleParts.push(`color:${color}`)
        }
      }
    }
    if (spec.fg) {
      if (spec.fg.kind === 'named') {
        classes.push(`burley-cell-fg-${spec.fg.name}`)
      } else {
        color = spec.fg.hex
        styleParts.push(`color:${spec.fg.hex}`)
      }
    } else if (spec.cellTint && spec.bg) {
      classes.push(`burley-cell-fg-${spec.cellTint}`)
    }
  } else {
    classes.push('burley-color-span')
    if (spec.bg) {
      classes.push('burley-has-bg')
      if (spec.bg.kind === 'named') {
        classes.push(`burley-bg-${spec.bg.name}`)
      } else {
        backgroundColor = spec.bg.hex
        styleParts.push(`background-color:${spec.bg.hex}`)
        if (!spec.fg) {
          color = contrastInkForHex(spec.bg.hex)
          styleParts.push(`color:${color}`)
        }
      }
    }
    if (spec.fg) {
      if (spec.fg.kind === 'named') {
        classes.push(`burley-fg-${spec.fg.name}`)
      } else {
        color = spec.fg.hex
        styleParts.push(`color:${spec.fg.hex}`)
      }
    }
  }

  return {
    classes,
    style: styleParts.join(';'),
    backgroundColor,
    color,
  }
}

const CELL_PREFIX_RE = /^\s*(\{([^{}\n]+)\})(?:\s+|$)/

export function extractCellColor(rawCell: string): {
  spec: ColorSpec | null
  content: string
  rawAttr: string
} {
  const match = CELL_PREFIX_RE.exec(rawCell)
  if (!match) {
    return { spec: null, content: rawCell, rawAttr: '' }
  }
  const spec = parseColorAttrs(match[2], 'cell')
  if (!spec) {
    return { spec: null, content: rawCell, rawAttr: '' }
  }
  return {
    spec,
    content: rawCell.slice(match[0].length),
    rawAttr: match[1],
  }
}

export function applyCellColor(rawCell: string, nextAttr: string | null): string {
  const { content } = extractCellColor(rawCell)
  const cleanContent = content.trimStart()
  if (!nextAttr) return cleanContent
  return cleanContent ? `${nextAttr} ${cleanContent}` : nextAttr
}

export interface InlineColorMatch {
  kind: 'span' | 'highlight'
  from: number
  to: number
  contentFrom: number
  contentTo: number
  spec?: ColorSpec
}

export function findInlineColorSpans(line: string): InlineColorMatch[] {
  const matches: InlineColorMatch[] = []
  let i = 0
  let codeFenceLen = 0

  while (i < line.length) {
    const ch = line[i]

    if (ch === '`') {
      let run = 1
      while (i + run < line.length && line[i + run] === '`') run++
      if (codeFenceLen === 0) codeFenceLen = run
      else if (run === codeFenceLen) codeFenceLen = 0
      i += run
      continue
    }

    if (codeFenceLen > 0) {
      i++
      continue
    }

    if (ch === '\\') {
      i += 2
      continue
    }

    // ==highlight==
    if (ch === '=' && line[i + 1] === '=') {
      const contentFrom = i + 2
      if (contentFrom < line.length && !/\s/.test(line[contentFrom])) {
        let end = -1
        for (let j = contentFrom; j + 1 < line.length; j++) {
          if (line[j] === '\\') {
            j++
            continue
          }
          if (line[j] === '=' && line[j + 1] === '=') {
            end = j
            break
          }
        }
        if (end > contentFrom && !/\s/.test(line[end - 1])) {
          matches.push({
            kind: 'highlight',
            from: i,
            to: end + 2,
            contentFrom,
            contentTo: end,
          })
          i = end + 2
          continue
        }
      }
      i += 2
      continue
    }

    // [text]{attrs} (skip images `![...]{...}` and skip escaped `[`)
    if (ch === '[' && (i === 0 || line[i - 1] !== '!')) {
      const contentFrom = i + 1
      let closeBracket = -1
      let innerCode = 0
      for (let j = contentFrom; j < line.length; j++) {
        const cj = line[j]
        if (cj === '`') {
          let run = 1
          while (j + run < line.length && line[j + run] === '`') run++
          if (innerCode === 0) innerCode = run
          else if (run === innerCode) innerCode = 0
          j += run - 1
          continue
        }
        if (innerCode > 0) continue
        if (cj === '\\') {
          j++
          continue
        }
        if (cj === '[') break // nested unescaped bracket: defer to innermost/don't mismatch
        if (cj === ']') {
          closeBracket = j
          break
        }
      }

      if (closeBracket > contentFrom && line[closeBracket + 1] === '{') {
        const closeBrace = line.indexOf('}', closeBracket + 2)
        if (closeBrace > closeBracket + 2) {
          const attrStr = line.slice(closeBracket + 2, closeBrace)
          if (!attrStr.includes('{')) {
            const spec = parseColorAttrs(attrStr, 'inline')
            if (spec) {
              matches.push({
                kind: 'span',
                from: i,
                to: closeBrace + 1,
                contentFrom,
                contentTo: closeBracket,
                spec,
              })
              i = closeBrace + 1
              continue
            }
          }
        }
      }
    }

    i++
  }

  return matches
}
