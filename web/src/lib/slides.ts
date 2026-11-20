/**
 * Split a Markdown document into presentation slides on standalone `---`
 * horizontal rule lines, ignoring YAML frontmatter and fenced code blocks.
 */
export function splitSlides(markdown: string): string[] {
  let text = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // Strip leading YAML frontmatter if present
  const fm = /^---\n[\s\S]*?\n---\n?/.exec(text)
  if (fm) {
    text = text.slice(fm[0].length)
  }

  const lines = text.split('\n')
  const slides: string[] = []
  let buf: string[] = []
  let fenceChar = ''
  let fenceLen = 0

  for (const line of lines) {
    const trimmed = line.trim()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fenceChar) {
        fenceChar = marker[0]
        fenceLen = marker.length
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && trimmed.length === marker.length) {
        fenceChar = ''
        fenceLen = 0
      }
      buf.push(line)
      continue
    }

    if (!fenceChar && /^---+$/.test(trimmed)) {
      const slide = buf.join('\n').trim()
      if (slide) slides.push(slide)
      buf = []
      continue
    }

    buf.push(line)
  }

  const tail = buf.join('\n').trim()
  if (tail) slides.push(tail)
  return slides.length > 0 ? slides : ['']
}
