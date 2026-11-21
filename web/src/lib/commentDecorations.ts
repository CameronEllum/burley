/**
 * CodeMirror 6 live-preview decorations for Burley inline Discussion & Edit comments.
 *
 * - Hides the bottom `<!-- burley-comments ... -->` block cleanly
 * - Hides inline `<!-- d:id -->` / `<!-- /d:id -->` / `<!-- e:id -->` tags
 * - Highlights range-anchored prose and adds a compact clickable pill after it
 * - Replaces point tags (`<!-- d:id /-->` / `<!-- e:id /-->`) with a clickable pin
 */
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { isMouseSelecting, mouseSelectingEnded, previewGeometryChanged } from './cm'
import { parseDocComments, type CommentKind } from './docComments'

export const setActiveCommentEffect = StateEffect.define<string | null>()
export const setPendingCommentEffect = StateEffect.define<{ from: number; to: number } | null>()

export const activeCommentField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setActiveCommentEffect)) {
        return effect.value
      }
    }
    return value
  },
})

export const pendingCommentField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPendingCommentEffect)) {
        return effect.value
      }
    }
    if (tr.docChanged && value) {
      const from = tr.changes.mapPos(value.from, 1)
      const to = tr.changes.mapPos(value.to, -1)
      return { from, to: Math.max(from, to) }
    }
    return value
  },
})

class PendingPointWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-doc-comment-pending-point'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
}

export interface CommentHoverRect {
  left: number
  top: number
  bottom: number
}

let commentClickHandler: ((id: string) => void) | null = null
let commentHoverHandler: ((id: string | null, rect: CommentHoverRect | null) => void) | null = null

export function setCommentClickHandler(fn: ((id: string) => void) | null): void {
  commentClickHandler = fn
}

export function setCommentHoverHandler(
  fn: ((id: string | null, rect: CommentHoverRect | null) => void) | null,
): void {
  commentHoverHandler = fn
}

class CommentMarkerWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly kind: CommentKind,
    readonly msgCount: number,
    readonly active: boolean,
    readonly isPoint: boolean,
  ) {
    super()
  }

  eq(other: CommentMarkerWidget): boolean {
    return (
      other.id === this.id &&
      other.kind === this.kind &&
      other.msgCount === this.msgCount &&
      other.active === this.active &&
      other.isPoint === this.isPoint
    )
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = [
      'cm-doc-comment-marker',
      this.kind === 'discussion' ? 'is-discussion' : 'is-edit',
      this.isPoint ? 'is-point' : 'is-range',
      this.active ? 'is-active' : '',
    ]
      .filter(Boolean)
      .join(' ')
    btn.dataset.commentId = this.id
    btn.title = this.kind === 'discussion' ? 'Open discussion thread' : 'Open edit note'
    btn.setAttribute('aria-label', btn.title)

    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '11')
    svg.setAttribute('height', '11')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(svgNS, 'path')
    if (this.kind === 'discussion') {
      path.setAttribute('d', 'M2.5 3h11v7.5H6.8L3.8 13v-2.5H2.5z')
    } else {
      path.setAttribute('d', 'M11.6 2.6l1.8 1.8L5.6 12.2 3 13l.8-2.6z')
    }
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.4')
    path.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(path)
    btn.appendChild(svg)

    if (this.kind === 'discussion' && this.msgCount > 1) {
      const count = document.createElement('span')
      count.className = 'cm-doc-comment-count'
      count.textContent = String(this.msgCount)
      btn.appendChild(count)
    }

    btn.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    btn.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      commentClickHandler?.(this.id)
    })
    btn.addEventListener('mouseenter', () => {
      const r = btn.getBoundingClientRect()
      commentHoverHandler?.(this.id, { left: r.left, top: r.top, bottom: r.bottom })
    })
    btn.addEventListener('mouseleave', () => {
      commentHoverHandler?.(null, null)
    })
    return btn
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildDocCommentDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString()
  const pending = state.field(pendingCommentField, false) ?? null
  if (!text.includes('<!--') && !pending) return Decoration.none

  const parsed = parseDocComments(text)
  const activeId = state.field(activeCommentField, false) ?? null
  const decorations: Range<Decoration>[] = []

  if (pending) {
    const from = Math.max(0, Math.min(pending.from, state.doc.length))
    const to = Math.max(from, Math.min(pending.to, state.doc.length))
    if (to > from) {
      decorations.push(Decoration.mark({ class: 'cm-doc-comment-pending' }).range(from, to))
    } else {
      decorations.push(
        Decoration.widget({ widget: new PendingPointWidget(), side: 1 }).range(from),
      )
    }
  }

  const msgCountById = new Map<string, number>()
  for (const c of parsed.comments) {
    msgCountById.set(c.id, c.messages.length)
  }

  for (const anchor of parsed.anchors) {
    const isActive = activeId === anchor.id
    const msgCount = msgCountById.get(anchor.id) ?? 0
    if (anchor.isRange) {
      decorations.push(Decoration.replace({}).range(anchor.openFrom, anchor.openTo))
      decorations.push(Decoration.replace({}).range(anchor.closeFrom, anchor.closeTo))
      if (anchor.textTo > anchor.textFrom) {
        decorations.push(
          Decoration.mark({
            class: [
              'cm-doc-comment-range',
              `cm-doc-comment-${anchor.kind}`,
              isActive ? 'is-active' : '',
            ]
              .filter(Boolean)
              .join(' '),
            attributes: { 'data-comment-id': anchor.id },
          }).range(anchor.textFrom, anchor.textTo),
        )
      }
      decorations.push(
        Decoration.widget({
          widget: new CommentMarkerWidget(anchor.id, anchor.kind, msgCount, isActive, false),
          side: 1,
        }).range(anchor.closeTo),
      )
    } else {
      decorations.push(
        Decoration.replace({
          widget: new CommentMarkerWidget(anchor.id, anchor.kind, msgCount, isActive, true),
        }).range(anchor.openFrom, anchor.openTo),
      )
    }
  }

  return Decoration.set(decorations, true)
}

/** Live-preview decorations and click handling for inline Discussion & Edit comments. */
export function docCommentsField(): Extension {
  const decoField = StateField.define<DecorationSet>({
    create: buildDocCommentDecorations,
    update(deco, tr) {
      if (
        tr.docChanged ||
        tr.reconfigured ||
        previewGeometryChanged(tr) ||
        mouseSelectingEnded(tr) ||
        tr.effects.some((e) => e.is(setActiveCommentEffect) || e.is(setPendingCommentEffect))
      ) {
        return buildDocCommentDecorations(tr.state)
      }
      if (isMouseSelecting(tr.state)) return deco
      return deco
    },
    provide: (field) => EditorView.decorations.from(field),
  })

  const eventHandlers = EditorView.domEventHandlers({
    click(event) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return false
      const target = event.target as HTMLElement | null
      const hit = target?.closest<HTMLElement>('.cm-doc-comment-range[data-comment-id]')
      if (!hit) return false
      const id = hit.getAttribute('data-comment-id')
      if (!id) return false
      commentClickHandler?.(id)
      return true
    },
    mouseover(event) {
      const target = event.target as HTMLElement | null
      const hit = target?.closest<HTMLElement>(
        '.cm-doc-comment-marker[data-comment-id], .cm-doc-comment-range[data-comment-id]',
      )
      if (!hit) return false
      const id = hit.getAttribute('data-comment-id')
      if (!id) return false
      const r = hit.getBoundingClientRect()
      commentHoverHandler?.(id, { left: r.left, top: r.top, bottom: r.bottom })
      return false
    },
    mouseout(event) {
      const target = event.target as HTMLElement | null
      const fromHit = target?.closest<HTMLElement>(
        '.cm-doc-comment-marker[data-comment-id], .cm-doc-comment-range[data-comment-id]',
      )
      if (!fromHit) return false
      const related = event.relatedTarget as HTMLElement | null
      const toHit = related?.closest<HTMLElement>(
        '.cm-doc-comment-marker[data-comment-id], .cm-doc-comment-range[data-comment-id]',
      )
      if (toHit && toHit.getAttribute('data-comment-id') === fromHit.getAttribute('data-comment-id')) {
        return false
      }
      commentHoverHandler?.(null, null)
      return false
    },
  })

  return [decoField, eventHandlers]
}
