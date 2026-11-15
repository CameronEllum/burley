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
}

const ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const SETEXT = /^\s{0,3}(=+|-+)\s*$/

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
}

/** Extract headings, skipping anything inside fenced code blocks. */
export function buildOutline(markdown: string): OutlineItem[] {
  const lines = markdown.split('\n')
  const items: OutlineItem[] = []
  let fenceChar: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const fence = FENCE.exec(line)
    if (fence) {
      const char = fence[1][0]
      if (fenceChar === null) fenceChar = char
      else if (fenceChar === char) fenceChar = null
      continue
    }
    if (fenceChar !== null) continue

    const atx = ATX.exec(line)
    if (atx) {
      const text = cleanHeadingText(atx[2])
      if (text) {
        const level = atx[1].length
        items.push({ level, text, line: i + 1, id: `${i + 1}-${text}` })
      }
      continue
    }

    // Setext headings: "Title" followed by === or ---.
    if (i + 1 < lines.length && line.trim() && !/^\s*([-*+>|]|\d+[.)])\s/.test(line)) {
      const underline = SETEXT.exec(lines[i + 1])
      if (underline) {
        const text = cleanHeadingText(line)
        if (text) {
          const level = underline[1].startsWith('=') ? 1 : 2
          items.push({ level, text, line: i + 1, id: `${i + 1}-${text}` })
          i++
          continue
        }
      }
    }
  }

  return items
}
