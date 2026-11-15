/** Shared Markdown → sanitized HTML renderer for chat and exports. */
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import katex from 'katex'

const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start(src: string) {
    return src.indexOf('$$')
  },
  tokenizer(src: string) {
    const match = /^\$\$\s*\n([\s\S]+?)\n\$\$(?:\n|$)/.exec(src)
    if (!match) return undefined
    return { type: 'blockMath', raw: match[0], text: match[1] }
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
    return src.indexOf('$')
  },
  tokenizer(src: string) {
    const match = /^\$\$([^$\n]+?)\$\$|^\$([^$\n]+?)\$/.exec(src)
    if (!match) return undefined
    return {
      type: 'inlineMath',
      raw: match[0],
      text: match[1] ?? match[2],
      display: !!match[1],
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

marked.use({ gfm: true, extensions: [blockMath, inlineMath] })

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
