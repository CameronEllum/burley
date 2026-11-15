/**
 * Collects every figure in the active note (images and Plotly blocks) so the
 * lightbox can browse them in document order.
 */
import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { filePathFacet } from './cm'
import { isExternalRef, resolveRelative } from './paths'
import { api } from './api'
import { getActiveView } from './viewRef'

export interface ImageFigure {
  kind: 'image'
  /** Document offset of the Markdown image syntax. */
  from: number
  src: string
  caption: string
}

export interface PlotlyFigure {
  kind: 'plotly'
  from: number
  /** Raw fenced-block body (JSON or a `src:` directive). */
  code: string
  filePath: string
  caption: string
}

export interface MermaidFigure {
  kind: 'mermaid'
  from: number
  code: string
  caption: string
}

export type FigureItem = ImageFigure | PlotlyFigure | MermaidFigure

const IMAGE_SYNTAX = /^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+["']([^"']*)["'])?\s*\)$/

function resolveImageUrl(filePath: string, src: string): string | null {
  if (!src) return null
  if (isExternalRef(src)) return src
  const resolved = resolveRelative(filePath, src)
  return resolved ? api.assetUrl(resolved) : null
}

/** All images and Plotly charts in `state`, top to bottom. */
export function collectFigures(state: EditorState): FigureItem[] {
  const figures: FigureItem[] = []
  const filePath = state.facet(filePathFacet)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Image') {
        const raw = state.doc.sliceString(node.from, node.to).trim()
        const match = IMAGE_SYNTAX.exec(raw)
        if (!match) return
        const url = resolveImageUrl(filePath, match[2] ?? match[3] ?? '')
        if (!url) return
        const alt = (match[1] ?? '').replace(/\|\d+$/, '').trim()
        figures.push({ kind: 'image', from: node.from, src: url, caption: alt || match[4] || '' })
        return
      }

      if (node.name !== 'FencedCode') return
      const info = node.node.getChild('CodeInfo')
      if (!info) return
      const lang = state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase()
      if (lang !== 'plotly' && lang !== 'mermaid') return
      const codeNode = node.node.getChild('CodeText')
      const code = codeNode ? state.doc.sliceString(codeNode.from, codeNode.to).replace(/\n$/, '') : ''
      if (lang === 'mermaid') {
        figures.push({ kind: 'mermaid', from: node.from, code, caption: 'Mermaid diagram' })
      } else {
        figures.push({ kind: 'plotly', from: node.from, code, filePath, caption: 'Plotly chart' })
      }
    },
  })

  return figures.sort((a, b) => a.from - b.from)
}

type FigureOpenHandler = (figures: FigureItem[], index: number) => void

let openHandler: FigureOpenHandler | null = null

/** Registered by the app to show the lightbox. */
export function setFigureOpenHandler(handler: FigureOpenHandler | null): void {
  openHandler = handler
}

/** Open the lightbox at the figure whose source begins at `from`. */
export function openFigureAt(from: number): void {
  const view = getActiveView()
  if (!view || !openHandler) return
  const figures = collectFigures(view.state)
  if (figures.length === 0) return
  let index = figures.findIndex((figure) => figure.from === from)
  if (index < 0) index = figures.findIndex((figure) => figure.from >= from)
  if (index < 0) index = 0
  openHandler(figures, index)
}
