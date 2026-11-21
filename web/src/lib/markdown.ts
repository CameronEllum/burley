/** Shared Markdown → sanitized HTML renderer for chat and exports. */
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'
import { isValidInlineMath } from './math'
import { colorSpecToPresentation, extractCellColor, parseColorAttrs } from './colors'

function earliestIndex(src: string, needles: string[]): number {
  let best = -1
  for (const needle of needles) {
    const idx = src.indexOf(needle)
    if (idx >= 0 && (best < 0 || idx < best)) best = idx
  }
  return best
}

const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    return earliestIndex(src, ['$$', '\\['])
  },
  tokenizer(src: string) {
    const match = /^\$\$\s*\n([\s\S]+?)\n\$\$(?:\n|$)|^\\\[\s*\n([\s\S]+?)\n\\\](?:\n|$)/.exec(src)
    if (!match) return undefined
    return { type: 'blockMath', raw: match[0], text: match[1] ?? match[2] }
  },
  renderer(token: any) {
    return katex.renderToString(token.text, {
      displayMode: true,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
  },
}

const inlineMath = {
  name: 'inlineMath',
  level: 'inline' as const,
  start(src: string) {
    return earliestIndex(src, ['$', '\\(', '\\['])
  },
  tokenizer(src: string) {
    const match =
      /^\$\$([^$\n]+?)\$\$(?!\$)|^\\\[([^\n]+?)(?<!\\)\\\]|^\$(?!\s)([^$\n]+?)(?<!\s)(?<!\\)\$(?!\$)(?!\d)|^\\\(([^\n]+?)(?<!\\)\\\)/.exec(
        src,
      )
    if (!match) return undefined
    const displayTex = match[1] ?? match[2]
    if (displayTex !== undefined) {
      if (!displayTex.trim()) return undefined
      return {
        type: 'inlineMath',
        raw: match[0],
        text: displayTex.trim(),
        display: true,
      }
    }
    if (match[3] !== undefined && !isValidInlineMath(match[3])) return undefined
    const inlineTex = match[3] ?? match[4] ?? ''
    if (!inlineTex.trim()) return undefined
    return {
      type: 'inlineMath',
      raw: match[0],
      text: inlineTex.trim(),
      display: false,
    }
  },
  renderer(token: any) {
    return katex.renderToString(token.text, {
      displayMode: token.display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    })
  },
}

const highlightMark = {
  name: 'highlightMark',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('==')
  },
  tokenizer(this: any, src: string) {
    const match = /^==(?=\S)((?:\\.|[^=\n]|=(?!=))*?\S)==/.exec(src)
    if (!match) return undefined
    return {
      type: 'highlightMark',
      raw: match[0],
      tokens: this.lexer.inlineTokens(match[1]),
    }
  },
  renderer(this: any, token: any) {
    return `<mark class="burley-highlight">${this.parser.parseInline(token.tokens)}</mark>`
  },
}

const bracketedColorSpan = {
  name: 'bracketedColorSpan',
  level: 'inline' as const,
  start(src: string) {
    return src.indexOf('[')
  },
  tokenizer(this: any, src: string) {
    const match = /^\[((?:\\.|[^\]\n])+)\]\{([^{}\n]+)\}/.exec(src)
    if (!match) return undefined
    const spec = parseColorAttrs(match[2], 'inline')
    if (!spec) return undefined
    return {
      type: 'bracketedColorSpan',
      raw: match[0],
      spec,
      tokens: this.lexer.inlineTokens(match[1]),
    }
  },
  renderer(this: any, token: any) {
    const pres = colorSpecToPresentation(token.spec, 'inline')
    const classAttr = pres.classes.length ? ` class="${pres.classes.join(' ')}"` : ''
    const styleAttr = pres.style ? ` style="${pres.style}"` : ''
    return `<span${classAttr}${styleAttr}>${this.parser.parseInline(token.tokens)}</span>`
  },
}

marked.use({
  gfm: true,
  extensions: [blockMath, inlineMath, highlightMark, bracketedColorSpan],
  renderer: {
    tablecell(token) {
      const { spec, content } = extractCellColor(token.text ?? '')
      if (!spec) return false
      const pres = colorSpecToPresentation(spec, 'cell')
      const body = marked.parseInline(content) as string
      const tag = token.header ? 'th' : 'td'
      const attrs: string[] = []
      if (token.align) attrs.push(`align="${token.align}"`)
      if (pres.classes.length) attrs.push(`class="${pres.classes.join(' ')}"`)
      if (pres.style) attrs.push(`style="${pres.style}"`)
      const attrStr = attrs.length ? ` ${attrs.join(' ')}` : ''
      return `<${tag}${attrStr}>${body}</${tag}>\n`
    },
  },
})

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown) as string
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
  })
}

export interface FencedBlock {
  lang: string
  code: string
}

export function extractFencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = []
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g
  for (let match = pattern.exec(markdown); match; match = pattern.exec(markdown)) {
    blocks.push({ lang: match[1].trim(), code: match[2].replace(/\n$/, '') })
  }
  return blocks
}
