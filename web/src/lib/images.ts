/**
 * Relative image previews for Markdown `![alt](path)` syntax.
 *
 * Images are resolved against the directory of the open file and served
 * through `/api/asset`, so a note can reference `img/plot.png` next to it.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { filePathFacet, isMouseSelecting, mouseSelectingEnded, previewGeometryChanged, readOnlyFacet, selectionTouches } from './cm'
import { isExternalRef, resolveRelative } from './paths'
import { api } from './api'
import { getActiveView } from './viewRef'
import { openFigureAt } from './figures'

const IMAGE_SYNTAX = /^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+["']([^"']*)["'])?\s*\)$/

interface ImageInfo {
  url: string
  alt: string
  title: string
  width: number | null
}

function parseImageAlt(alt: string): { alt: string; width: number | null } {
  // Obsidian style: ![caption|320](image.png)
  const pipe = alt.lastIndexOf('|')
  if (pipe > -1) {
    const tail = alt.slice(pipe + 1).trim()
    if (/^\d+$/.test(tail)) {
      return { alt: alt.slice(0, pipe).trim(), width: Number(tail) }
    }
  }
  return { alt: alt.trim(), width: null }
}

function resolveInfo(currentFile: string, src: string, altRaw: string, title: string): ImageInfo | null {
  const { alt, width } = parseImageAlt(altRaw)
  if (isExternalRef(src)) return { url: src, alt, title, width }
  const resolved = resolveRelative(currentFile, src)
  if (!resolved) return null
  return { url: api.assetUrl(resolved), alt, title, width }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly info: ImageInfo,
    readonly editPos: number,
    readonly figureFrom: number,
    readonly readOnly: boolean,
  ) {
    super()
  }

  eq(other: ImageWidget): boolean {
    return (
      other.info.url === this.info.url &&
      other.info.alt === this.info.alt &&
      other.info.title === this.info.title &&
      other.info.width === this.info.width &&
      other.figureFrom === this.figureFrom &&
      other.readOnly === this.readOnly
    )
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-burley-image'
    const img = document.createElement('img')
    img.src = this.info.url
    img.alt = this.info.alt
    img.title = this.info.title || this.info.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    img.draggable = false
    if (this.info.width) img.style.maxWidth = `${this.info.width}px`
    img.addEventListener('load', () => {
      getActiveView()?.requestMeasure()
    })
    img.addEventListener('error', () => {
      wrap.classList.add('cm-burley-image-error')
      wrap.textContent = `⚠ image not found: ${this.info.alt || this.info.url}`
      getActiveView()?.requestMeasure()
    })
    wrap.appendChild(img)
    if (this.info.alt) {
      const caption = document.createElement('span')
      caption.className = 'cm-burley-image-caption'
      caption.textContent = this.info.alt
      wrap.appendChild(caption)
    }

    const expand = document.createElement('button')
    expand.type = 'button'
    expand.className = 'cm-burley-image-expand'
    expand.textContent = '⤢'
    expand.title = 'Open figure full-screen'
    expand.addEventListener('mousedown', (event) => event.stopPropagation())
    expand.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      openFigureAt(this.figureFrom)
    })
    wrap.appendChild(expand)

    wrap.addEventListener('mousedown', (event) => {
      if (event.altKey || this.readOnly) {
        event.preventDefault()
        event.stopPropagation()
        openFigureAt(this.figureFrom)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const view = getActiveView()
      if (!view) return
      const pos = Math.min(this.editPos, view.state.doc.length)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    })
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildImageDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  const currentFile = state.facet(filePathFacet)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Image') return
      if (!readOnly && selectionTouches(state, node.from, node.to)) return
      const raw = state.doc.sliceString(node.from, node.to)
      const match = IMAGE_SYNTAX.exec(raw.trim())
      if (!match) return
      const src = match[2] ?? match[3] ?? ''
      const info = resolveInfo(currentFile, src, match[1] ?? '', match[4] ?? '')
      if (!info) return
      decorations.push(
        Decoration.replace({
          widget: new ImageWidget(info, node.from + 2, node.from, readOnly),
        }).range(node.from, node.to),
      )
    },
  })

  return Decoration.set(decorations, true)
}

/** Inline image previews with vault-relative URL resolution. */
export const imagePreviewField: StateField<DecorationSet> = StateField.define<DecorationSet>({
  create: buildImageDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured || previewGeometryChanged(tr) || mouseSelectingEnded(tr)) {
      return buildImageDecorations(tr.state)
    }
    if (isMouseSelecting(tr.state)) return deco
    if (tr.selection || tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)) {
      return buildImageDecorations(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})
