/** Markdown heading extraction for the sidebar's Outline tab. */

export interface OutlineItem {
  /** 1–6 for ATX/setext headings. */
  level: number
  /** Heading text with Markdown markup stripped. */
  text: string
  /** 1-based line number in the editor document. */
  line: number
  /** Stable key for keyed each-blocks. */
  id: string
  /** URL-safe, de-duplicated anchor (used by deep links and history). */
  slug: string
}

const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const SETEXT = /^\s{0,3}(=+|-+)\s*$/

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
}

function stripLineHtmlComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let out = ''
  let i = 0
  if (inComment) {
    const close = line.indexOf('-->')
    if (close < 0) return { text: '', inComment: true }
    i = close + 3
    inComment = false
  }
  while (i < line.length) {
    if (line[i] === '`') {
      let ticks = 1
      while (i + ticks < line.length && line[i + ticks] === '`') ticks++
      const opener = line.slice(i, i + ticks)
      const close = line.indexOf(opener, i + ticks)
      if (close >= 0) {
        out += line.slice(i, close + ticks)
        i = close + ticks
      } else {
        out += opener
        i += ticks
      }
      continue
    }
    if (line.startsWith('<!--', i)) {
      const close = line.indexOf('-->', i + 4)
      if (close < 0) return { text: out, inComment: true }
      i = close + 3
      continue
    }
    out += line[i]
    i++
  }
  return { text: out, inComment: false }
}

/** URL-safe heading anchor, e.g. "Loss curve" → "loss-curve". */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/** Extract headings, skipping anything inside fenced code blocks or HTML comments. */
export function buildOutline(markdown: string): OutlineItem[] {
  const lines = markdown.split('\n')
  const items: OutlineItem[] = []
  const slugCounts = new Map<string, number>()
  let fenceChar: string | null = null
  let inComment = false

  const pushItem = (level: number, text: string, lineIndex: number) => {
    const base = slugifyHeading(text)
    const count = slugCounts.get(base) ?? 0
    slugCounts.set(base, count + 1)
    const slug = count === 0 ? base : `${base}-${count}`
    items.push({ level, text, line: lineIndex + 1, id: `${lineIndex + 1}-${text}`, slug })
  }

  let startIndex = 0
  if (lines.length >= 3 && lines[0].replace(/\r$/, '') === '---') {
    for (let j = 1; j < lines.length; j++) {
      const trimmed = lines[j].replace(/\r$/, '').trim()
      if (trimmed === '---' || trimmed === '...') {
        startIndex = j + 1
        break
      }
    }
  }

  for (let i = startIndex; i < lines.length; i++) {
    const rawLine = lines[i]

    if (!inComment) {
      const fence = FENCE.exec(rawLine)
      if (fence) {
        const char = fence[1][0]
        if (fenceChar === null) fenceChar = char
        else if (fenceChar === char) fenceChar = null
        continue
      }
    }
    if (fenceChar !== null) continue

    const stripped = stripLineHtmlComments(rawLine, inComment)
    inComment = stripped.inComment
    const line = stripped.text
    if (!line.trim()) continue

    const atx = ATX.exec(line)
    if (atx) {
      const text = cleanHeadingText(atx[2])
      if (text) pushItem(atx[1].length, text, i)
      continue
    }

    // Setext headings: "Title" followed by === or ---.
    if (i + 1 < lines.length && line.trim() && !/^\s*([-*+>|]|\d+[.)])\s/.test(line)) {
      const underline = SETEXT.exec(lines[i + 1])
      if (underline) {
        const text = cleanHeadingText(line)
        if (text) {
          pushItem(underline[1].startsWith('=') ? 1 : 2, text, i)
          i++
          continue
        }
      }
    }
  }

  return items
}
