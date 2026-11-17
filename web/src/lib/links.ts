/**
 * Clickable links in the live preview.
 *
 * The library's link plugin does not rebuild on cursor movement, which makes
 * links impossible to edit by keyboard. This implementation follows the same
 * cursor-aware pattern as the math/image previews: rendered link text while the
 * cursor is away, raw Markdown while it is inside.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { setMouseSelecting } from 'codemirror-live-markdown'
import { filePathFacet, isMouseSelecting, mouseSelectingEnded, previewGeometryChanged, readOnlyFacet, selectionTouches } from './cm'
import { isExternalRef, resolveRelative } from './paths'
import { api } from './api'
import { getActiveView } from './viewRef'

const LINK_SYNTAX = /^\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^)\s]+))(?:\s+["']([^"']*)["'])?\s*\)$/
const MD_FILE = /\.(md|markdown|mdown|mkd)$/i

let openPathHandler: ((path: string) => void) | null = null
let linkClickBehavior: 'toggle' | 'open' = 'toggle'

/** Registered by the editor so `.md` links can navigate inside Burley. */
export function setLinkOpenHandler(handler: ((path: string) => void) | null): void {
  openPathHandler = handler
}

/** Ctrl/Cmd-click either reveals source ("toggle") or behaves like a click. */
export function setLinkClickBehavior(behavior: 'toggle' | 'open'): void {
  linkClickBehavior = behavior
}

class LinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly url: string,
    readonly title: string,
    readonly internalPath: string | null,
    readonly editPos: number,
  ) {
    super()
  }

  eq(other: LinkWidget): boolean {
    return (
      other.label === this.label &&
      other.url === this.url &&
      other.title === this.title &&
      other.internalPath === this.internalPath
    )
  }

  toDOM(): HTMLElement {
    const anchor = document.createElement('a')
    anchor.className = 'cm-burley-link'
    anchor.draggable = false
    anchor.textContent = this.label || this.url || 'link'
    anchor.title = `${this.internalPath || this.title || this.url} — Ctrl/Cmd-click to edit`

    let downX = 0
    let downY = 0
    anchor.addEventListener('mousedown', (event) => {
      downX = event.clientX
      downY = event.clientY
    })

    anchor.addEventListener('click', (event) => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) {
        event.preventDefault()
        return
      }
      const view = getActiveView()
      if ((event.ctrlKey || event.metaKey) && linkClickBehavior === 'toggle') {
        event.preventDefault()
        event.stopPropagation()
        if (!view) return
        const pos = Math.min(this.editPos, view.state.doc.length)
        view.dispatch({
          selection: { anchor: pos },
          effects: setMouseSelecting.of(false),
          scrollIntoView: true,
        })
        view.focus()
        return
      }
      if (this.internalPath) {
        event.preventDefault()
        event.stopPropagation()
        if (openPathHandler) openPathHandler(this.internalPath)
      }
    })

    if (this.internalPath) {
      anchor.href = '#'
      anchor.classList.add('cm-burley-link-internal')
    } else if (this.url) {
      anchor.href = this.url
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
    } else {
      anchor.href = '#'
    }
    return anchor
  }

  ignoreEvent(): boolean {
    return false
  }
}

function buildLinkDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  const currentFile = state.facet(filePathFacet)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Link') return
      if (!readOnly && selectionTouches(state, node.from, node.to)) return
      const raw = state.doc.sliceString(node.from, node.to).trim()
      const match = LINK_SYNTAX.exec(raw)
      if (!match) return
      const label = match[1] ?? ''
      const href = match[2] ?? match[3] ?? ''
      const title = match[4] ?? ''
      if (!href) return

      let internalPath: string | null = null
      let url = href
      if (href.startsWith('#')) {
        internalPath = `${currentFile}${href}`
        url = ''
      } else if (!isExternalRef(href)) {
        const hashIdx = href.indexOf('#')
        const hashPart = hashIdx >= 0 ? href.slice(hashIdx) : ''
        const resolved = resolveRelative(currentFile, href.split('#')[0])
        if (resolved && MD_FILE.test(resolved)) {
          internalPath = `${resolved}${hashPart}`
          url = ''
        } else if (resolved) {
          url = api.assetUrl(resolved)
        } else {
          return
        }
      }

      decorations.push(
        Decoration.replace({
          widget: new LinkWidget(label, url, title, internalPath, node.from + 1),
        }).range(node.from, node.to),
      )
    },
  })

  return Decoration.set(decorations, true)
}

/** Inline link previews with internal Markdown navigation. */
export const linkPreviewField: StateField<DecorationSet> = StateField.define<DecorationSet>({
  create: buildLinkDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured || previewGeometryChanged(tr) || mouseSelectingEnded(tr)) {
      return buildLinkDecorations(tr.state)
    }
    if (isMouseSelecting(tr.state)) return deco
    if (tr.selection || tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)) {
      return buildLinkDecorations(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})
