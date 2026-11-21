/**
 * Pure Markdown parser and serializer for Burley self-contained inline comments.
 *
 * No IDs and no EOF footer — each comment lives directly at its target text
 * inside standard HTML comments so it stays 100% invisible in GitHub/external
 * Markdown viewers and directly readable/editable by humans and AI agents:
 *
 *   Range Edit (single-line):
 *     <!-- edit -->selected text<!-- /edit @author (YYYY-MM-DD): note -->
 *   Point Edit (single-line):
 *     <!-- edit @author (YYYY-MM-DD): note -->
 *   Range Discussion (single-line):
 *     <!-- discussion -->selected text<!-- /discussion @author (YYYY-MM-DD): note -->
 *   Multi-line / Threaded Discussion:
 *     <!-- discussion -->selected text<!-- /discussion
 *     @author (YYYY-MM-DD): first line
 *       continuation line
 *     > @replyAuthor (YYYY-MM-DD): reply line 1
 *       reply continuation
 *     -->
 *   Point Discussion (threaded):
 *     <!-- discussion
 *     @author (YYYY-MM-DD): first line
 *     > @replyAuthor (YYYY-MM-DD): reply line 1
 *     -->
 */

export type CommentKind = 'discussion' | 'edit'

export interface CommentMessage {
  author: string
  date: string
  body: string
}

export interface CommentAnchor {
  id: string
  kind: CommentKind
  isRange: boolean
  openFrom: number
  openTo: number
  closeFrom: number
  closeTo: number
  textFrom: number
  textTo: number
  snippet: string
  line: number
}

export interface DocComment {
  id: string
  kind: CommentKind
  anchor: CommentAnchor
  messages: CommentMessage[]
}

export interface ParsedDocComments {
  comments: DocComment[]
  anchors: CommentAnchor[]
}

interface TextRange {
  from: number
  to: number
}

interface ParsedCommentTag {
  role: 'open' | 'close' | 'point'
  kind: CommentKind
  from: number
  to: number
  messages: CommentMessage[]
}

const RANGE_OPEN_RE = /^<!-- (discussion|edit) -->$/
const RANGE_CLOSE_RE = /^<!-- \/(discussion|edit)(?: @|\r?\n@)/
const POINT_RE = /^<!-- (discussion|edit)(?: @|\r?\n@)/
const HTML_COMMENT_SCAN_RE = /<!--[\s\S]*?-->/g

const MSG_HEADER_RE = /^@(.+?)\s+\((\d{4}-\d{2}-\d{2})\): ?(.*)$/
const REPLY_HEADER_RE = /^>\s+@(.+?)\s+\((\d{4}-\d{2}-\d{2})\): ?(.*)$/

export function isBurleyCommentTag(rawComment: string): boolean {
  if (!rawComment.endsWith('-->')) return false
  if (RANGE_OPEN_RE.test(rawComment)) return true
  if (RANGE_CLOSE_RE.test(rawComment) || POINT_RE.test(rawComment)) {
    return parseTagMessages(rawComment).length > 0
  }
  return false
}

export function escapeCommentBody(body: string): string {
  return body.replace(/--/g, '-&#45;')
}

export function unescapeCommentBody(body: string): string {
  return body.replace(/-&#45;/g, '--')
}

export function sanitizeAuthor(author: string): string {
  const cleaned = author
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^@+/, '')
    .replace(/[()]/g, '')
    .trim()
  return cleaned || 'anonymous'
}

export function todayIsoDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function findCodeRanges(doc: string): TextRange[] {
  const ranges: TextRange[] = []
  let pos = 0
  let inFence: { char: string; len: number; from: number } | null = null

  while (pos < doc.length) {
    const nl = doc.indexOf('\n', pos)
    const lineEnd = nl === -1 ? doc.length : nl
    const rawLine = doc.slice(pos, lineEnd)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const nextPos = nl === -1 ? doc.length : nl + 1

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (inFence) {
      const closeMatch = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (closeMatch && closeMatch[1][0] === inFence.char && closeMatch[1].length >= inFence.len) {
        ranges.push({ from: inFence.from, to: nextPos })
        inFence = null
      }
      pos = nextPos
      continue
    }

    if (fenceMatch) {
      inFence = { char: fenceMatch[1][0], len: fenceMatch[1].length, from: pos }
      pos = nextPos
      continue
    }

    let i = 0
    while (i < line.length) {
      if (line[i] !== '`') {
        i++
        continue
      }
      let ticks = 0
      while (i + ticks < line.length && line[i + ticks] === '`') ticks++
      const closeIdx = line.indexOf('`'.repeat(ticks), i + ticks)
      if (closeIdx !== -1) {
        let endRun = closeIdx + ticks
        while (endRun < line.length && line[endRun] === '`') endRun++
        if (endRun - closeIdx === ticks) {
          ranges.push({ from: pos + i, to: pos + endRun })
          i = endRun
          continue
        }
      }
      i += ticks
    }

    pos = nextPos
  }

  if (inFence) {
    ranges.push({ from: inFence.from, to: doc.length })
  }
  return ranges
}

function insideRanges(pos: number, ranges: TextRange[]): boolean {
  for (const r of ranges) {
    if (pos >= r.from && pos < r.to) return true
  }
  return false
}

function lineNumberAt(doc: string, pos: number): number {
  let line = 1
  const limit = Math.max(0, Math.min(pos, doc.length))
  for (let i = 0; i < limit; i++) {
    if (doc.charCodeAt(i) === 10) line++
  }
  return line
}

function parseTagMessages(rawComment: string): CommentMessage[] {
  // Strip closing `-->`
  if (!rawComment.endsWith('-->')) return []
  const withoutClose = rawComment.slice(0, -3)

  // Strip opening `<!-- /?(discussion|edit)`
  const headMatch = /^<!-- \/?(?:discussion|edit)/.exec(withoutClose)
  if (!headMatch) return []
  const rest = withoutClose.slice(headMatch[0].length)

  if (rest.startsWith(' ')) {
    // Single-line form: ` @author (YYYY-MM-DD): body `
    const line = rest.slice(1, rest.endsWith(' ') ? -1 : rest.length)
    const msgMatch = MSG_HEADER_RE.exec(line)
    if (!msgMatch) return []
    return [
      {
        author: unescapeCommentBody(msgMatch[1]),
        date: msgMatch[2],
        body: unescapeCommentBody(msgMatch[3] ?? ''),
      },
    ]
  }

  if (!rest.startsWith('\n') && !rest.startsWith('\r\n')) {
    return []
  }

  // Multi-line form: split into lines between opening delimiter and closing `-->`
  const lines = rest.split(/\r?\n/)
  // Drop leading empty string from initial newline
  if (lines.length > 0 && lines[0] === '') lines.shift()
  // Drop trailing empty line right before `-->`
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const messages: CommentMessage[] = []
  let current: CommentMessage | null = null

  for (const line of lines) {
    const primaryMatch = MSG_HEADER_RE.exec(line)
    if (primaryMatch && messages.length === 0) {
      current = {
        author: unescapeCommentBody(primaryMatch[1]),
        date: primaryMatch[2],
        body: unescapeCommentBody(primaryMatch[3] ?? ''),
      }
      messages.push(current)
      continue
    }

    const replyMatch = REPLY_HEADER_RE.exec(line)
    if (replyMatch && current) {
      current = {
        author: unescapeCommentBody(replyMatch[1]),
        date: replyMatch[2],
        body: unescapeCommentBody(replyMatch[3] ?? ''),
      }
      messages.push(current)
      continue
    }

    if (current && line.startsWith('  ')) {
      current.body += '\n' + unescapeCommentBody(line.slice(2))
    }
  }

  return messages
}

function serializePayloadTag(
  kind: CommentKind,
  isRange: boolean,
  messages: CommentMessage[],
): string {
  const prefix = isRange ? `/${kind}` : kind
  const list = kind === 'discussion' ? messages : messages.slice(0, 1)
  if (list.length === 0) {
    return `<!-- ${prefix} @anonymous (${todayIsoDate()}): -->`
  }

  const first = list[0]
  const firstAuthor = escapeCommentBody(sanitizeAuthor(first.author))
  const firstLines = escapeCommentBody(first.body).split(/\r?\n/)

  if (list.length === 1 && firstLines.length === 1) {
    return `<!-- ${prefix} @${firstAuthor} (${first.date}): ${firstLines[0]} -->`
  }

  const out: string[] = [`<!-- ${prefix}`]
  out.push(`@${firstAuthor} (${first.date}): ${firstLines[0] ?? ''}`)
  for (let i = 1; i < firstLines.length; i++) {
    out.push(`  ${firstLines[i]}`)
  }

  for (let m = 1; m < list.length; m++) {
    const reply = list[m]
    const replyAuthor = escapeCommentBody(sanitizeAuthor(reply.author))
    const replyLines = escapeCommentBody(reply.body).split(/\r?\n/)
    out.push(`> @${replyAuthor} (${reply.date}): ${replyLines[0] ?? ''}`)
    for (let i = 1; i < replyLines.length; i++) {
      out.push(`  ${replyLines[i]}`)
    }
  }

  out.push('-->')
  return out.join('\n')
}

function parseRawTag(raw: string, from: number, to: number): ParsedCommentTag | null {
  const openMatch = RANGE_OPEN_RE.exec(raw)
  if (openMatch) {
    return {
      role: 'open',
      kind: openMatch[1] as CommentKind,
      from,
      to,
      messages: [],
    }
  }

  const closeMatch = RANGE_CLOSE_RE.exec(raw)
  if (closeMatch) {
    const messages = parseTagMessages(raw)
    if (messages.length === 0) return null
    return {
      role: 'close',
      kind: closeMatch[1] as CommentKind,
      from,
      to,
      messages,
    }
  }

  const pointMatch = POINT_RE.exec(raw)
  if (pointMatch) {
    const messages = parseTagMessages(raw)
    if (messages.length === 0) return null
    return {
      role: 'point',
      kind: pointMatch[1] as CommentKind,
      from,
      to,
      messages,
    }
  }

  return null
}

function cleanSnippet(raw: string, codeRanges: TextRange[], baseOffset: number): string {
  return raw.replace(/<!--[\s\S]*?-->/g, (match, offset: number) => {
    if (insideRanges(baseOffset + offset, codeRanges)) return match
    return isBurleyCommentTag(match) ? '' : match
  })
}

export function parseDocComments(doc: string): ParsedDocComments {
  if (!doc.includes('<!--')) {
    return { comments: [], anchors: [] }
  }

  const codeRanges = findCodeRanges(doc)
  const openStack: Record<CommentKind, ParsedCommentTag[]> = {
    discussion: [],
    edit: [],
  }
  const comments: DocComment[] = []

  HTML_COMMENT_SCAN_RE.lastIndex = 0
  for (let m = HTML_COMMENT_SCAN_RE.exec(doc); m; m = HTML_COMMENT_SCAN_RE.exec(doc)) {
    const from = m.index
    const to = from + m[0].length
    if (insideRanges(from, codeRanges)) continue

    const tag = parseRawTag(m[0], from, to)
    if (!tag) continue

    if (tag.role === 'open') {
      openStack[tag.kind].push(tag)
      continue
    }

    if (tag.role === 'point') {
      const id = `${tag.kind}:${tag.from}:${tag.to}`
      const messages = tag.kind === 'discussion' ? tag.messages : tag.messages.slice(0, 1)
      comments.push({
        id,
        kind: tag.kind,
        messages,
        anchor: {
          id,
          kind: tag.kind,
          isRange: false,
          openFrom: tag.from,
          openTo: tag.to,
          closeFrom: tag.from,
          closeTo: tag.to,
          textFrom: tag.to,
          textTo: tag.to,
          snippet: '',
          line: lineNumberAt(doc, tag.from),
        },
      })
      continue
    }

    // Close tag
    const open = openStack[tag.kind].pop()
    if (!open) continue
    const id = `${tag.kind}:${open.from}:${tag.to}`
    const messages = tag.kind === 'discussion' ? tag.messages : tag.messages.slice(0, 1)
    const rawSnippet = doc.slice(open.to, tag.from)
    comments.push({
      id,
      kind: tag.kind,
      messages,
      anchor: {
        id,
        kind: tag.kind,
        isRange: true,
        openFrom: open.from,
        openTo: open.to,
        closeFrom: tag.from,
        closeTo: tag.to,
        textFrom: open.to,
        textTo: tag.from,
        snippet: cleanSnippet(rawSnippet, codeRanges, open.to),
        line: lineNumberAt(doc, open.from),
      },
    })
  }

  comments.sort((a, b) => a.anchor.openFrom - b.anchor.openFrom)
  const anchors = comments.map((c) => c.anchor)
  return { comments, anchors }
}

function collectRawTagRanges(doc: string): TextRange[] {
  const ranges: TextRange[] = []
  for (const c of parseDocComments(doc).comments) {
    ranges.push({ from: c.anchor.openFrom, to: c.anchor.openTo })
    if (c.anchor.isRange) {
      ranges.push({ from: c.anchor.closeFrom, to: c.anchor.closeTo })
    }
  }
  return ranges
}

export function addCommentToDoc(
  doc: string,
  opts: {
    kind: CommentKind
    from: number
    to: number
    author: string
    body: string
    date?: string
  },
): { doc: string; id: string } {
  const tagRanges = collectRawTagRanges(doc)
  let from = Math.max(0, Math.min(opts.from, doc.length))
  let to = Math.max(from, Math.min(opts.to, doc.length))
  const wasEmpty = from === to

  for (const r of tagRanges) {
    if (from > r.from && from < r.to) {
      from = wasEmpty ? r.from : r.to
    }
    if (to > r.from && to < r.to) {
      to = r.from
    }
  }
  if (to < from) to = from

  if (from < to) {
    while (to > from && (doc[to - 1] === '\n' || doc[to - 1] === '\r')) {
      to--
    }
  }

  const msg: CommentMessage = {
    author: sanitizeAuthor(opts.author),
    date: opts.date ?? todayIsoDate(),
    body: opts.body.trim(),
  }

  if (from === to) {
    const tag = serializePayloadTag(opts.kind, false, [msg])
    const nextDoc = doc.slice(0, from) + tag + doc.slice(from)
    return {
      doc: nextDoc,
      id: `${opts.kind}:${from}:${from + tag.length}`,
    }
  }

  const openTag = `<!-- ${opts.kind} -->`
  const closeTag = serializePayloadTag(opts.kind, true, [msg])
  const nextDoc = doc.slice(0, from) + openTag + doc.slice(from, to) + closeTag + doc.slice(to)
  const closeTo = to + openTag.length + closeTag.length
  return {
    doc: nextDoc,
    id: `${opts.kind}:${from}:${closeTo}`,
  }
}

function replaceCommentPayload(
  doc: string,
  comment: DocComment,
  nextMessages: CommentMessage[],
): { doc: string; id: string } {
  const nextTag = serializePayloadTag(comment.kind, comment.anchor.isRange, nextMessages)
  const replaceFrom = comment.anchor.isRange ? comment.anchor.closeFrom : comment.anchor.openFrom
  const replaceTo = comment.anchor.isRange ? comment.anchor.closeTo : comment.anchor.openTo
  const nextDoc = doc.slice(0, replaceFrom) + nextTag + doc.slice(replaceTo)
  const newCloseTo = replaceFrom + nextTag.length
  return {
    doc: nextDoc,
    id: `${comment.kind}:${comment.anchor.openFrom}:${newCloseTo}`,
  }
}

export function addReplyToDoc(
  doc: string,
  id: string,
  opts: { author: string; body: string; date?: string },
): { doc: string; id: string } {
  const comment = parseDocComments(doc).comments.find((c) => c.id === id)
  if (!comment || comment.kind !== 'discussion') return { doc, id }
  const trimmed = opts.body.trim()
  if (!trimmed) return { doc, id }
  const nextMessages = [
    ...comment.messages,
    {
      author: sanitizeAuthor(opts.author),
      date: opts.date ?? todayIsoDate(),
      body: trimmed,
    },
  ]
  return replaceCommentPayload(doc, comment, nextMessages)
}

export function editCommentMessageInDoc(
  doc: string,
  id: string,
  messageIndex: number,
  nextBody: string,
): { doc: string; id: string } {
  const comment = parseDocComments(doc).comments.find((c) => c.id === id)
  if (!comment || messageIndex < 0 || messageIndex >= comment.messages.length) {
    return { doc, id }
  }
  const trimmed = nextBody.trim()
  if (!trimmed) return { doc, id }
  const nextMessages = [...comment.messages]
  nextMessages[messageIndex] = { ...nextMessages[messageIndex], body: trimmed }
  return replaceCommentPayload(doc, comment, nextMessages)
}

export function deleteReplyFromDoc(
  doc: string,
  id: string,
  messageIndex: number,
): { doc: string; id: string } {
  if (messageIndex <= 0) return { doc, id }
  const comment = parseDocComments(doc).comments.find((c) => c.id === id)
  if (!comment || comment.kind !== 'discussion' || messageIndex >= comment.messages.length) {
    return { doc, id }
  }
  const nextMessages = comment.messages.filter((_, i) => i !== messageIndex)
  return replaceCommentPayload(doc, comment, nextMessages)
}

export function deleteCommentFromDoc(doc: string, id: string): string {
  const comment = parseDocComments(doc).comments.find((c) => c.id === id)
  if (!comment) return doc
  const a = comment.anchor
  if (!a.isRange) {
    return doc.slice(0, a.openFrom) + doc.slice(a.openTo)
  }
  return doc.slice(0, a.openFrom) + doc.slice(a.openTo, a.closeFrom) + doc.slice(a.closeTo)
}
