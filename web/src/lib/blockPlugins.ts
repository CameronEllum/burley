/**
 * Extensible fenced-code-block renderers for the live preview.
 *
 * Block widgets must be produced by a StateField (CodeMirror forbids block
 * decorations from view plugins). The field walks `FencedCode` nodes, looks up
 * a renderer for the language tag, and replaces the whole fence with a widget
 * whenever the selection is outside of it.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import katex from 'katex'
import hljs from 'highlight.js/lib/common'
import { filePathFacet, readOnlyFacet, selectionTouches } from './cm'
import { isExternalRef, resolveRelative } from './paths'
import { api } from './api'
import { getActiveView } from './viewRef'

export interface BlockContext {
  /** Lower-case language tag from the opening fence ("" if absent). */
  lang: string
  /** Raw body of the fenced block. */
  code: string
  /** Document positions of the whole fence and of its body. */
  from: number
  to: number
  editPos: number
  /** Vault-relative path of the file containing the block. */
  filePath: string
  /** Resolve a relative asset reference to a fetchable URL (null if invalid). */
  assetUrl: (ref: string) => string | null
}

export interface BlockRenderer {
  /** Build the widget contents. May render asynchronously. */
  render(ctx: BlockContext): HTMLElement
  /** Optional cleanup hook (e.g. disposing a Plotly chart). */
  destroy?(root: HTMLElement): void
}

const renderers = new Map<string, BlockRenderer>()

/** Register (or replace) the renderer for a fenced language tag. */
export function registerBlockRenderer(lang: string, renderer: BlockRenderer): void {
  renderers.set(lang.toLowerCase(), renderer)
}

export function getBlockRenderer(lang: string): BlockRenderer | undefined {
  return renderers.get(lang.toLowerCase())
}

const mathRenderer: BlockRenderer = {
  render(ctx) {
    const div = document.createElement('div')
    div.className = 'cm-burley-math-block-inner'
    try {
      div.innerHTML = katex.renderToString(ctx.code.trim(), {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      })
    } catch (err) {
      div.classList.add('cm-burley-math-error')
      div.textContent = `[math error] ${err instanceof Error ? err.message : String(err)}`
    }
    return div
  },
}

export const genericCodeRenderer: BlockRenderer = {
  render(ctx) {
    const pre = document.createElement('pre')
    pre.className = 'cm-burley-code'
    const code = document.createElement('code')
    if (ctx.lang) code.className = `language-${ctx.lang}`
    try {
      if (ctx.lang && hljs.getLanguage(ctx.lang)) {
        code.innerHTML = hljs.highlight(ctx.code, {
          language: ctx.lang,
          ignoreIllegals: true,
        }).value
      } else {
        code.textContent = ctx.code
      }
    } catch {
      code.textContent = ctx.code
    }
    pre.appendChild(code)
    return pre
  },
}

registerBlockRenderer('math', mathRenderer)
registerBlockRenderer('katex', mathRenderer)

export function assetUrlFor(currentFile: string, ref: string): string | null {
  if (!ref) return null
  if (isExternalRef(ref)) return ref
  const resolved = resolveRelative(currentFile, ref)
  return resolved ? api.assetUrl(resolved) : null
}

/** How many body lines a block has (for the header badge). */
function lineCount(code: string): number {
  if (!code) return 0
  return code.replace(/\n$/, '').split('\n').length
}

class BlockWidget extends WidgetType {
  renderedEl: HTMLElement | null = null

  constructor(
    readonly ctx: BlockContext,
    readonly renderer: BlockRenderer,
  ) {
    super()
  }

  eq(other: BlockWidget): boolean {
    return (
      other.renderer === this.renderer &&
      other.ctx.lang === this.ctx.lang &&
      other.ctx.code === this.ctx.code &&
      other.ctx.filePath === this.ctx.filePath
    )
  }

  toDOM(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-burley-block'
    root.dataset.lang = this.ctx.lang || 'code'

    const head = document.createElement('div')
    head.className = 'cm-burley-block-head'

    const label = document.createElement('span')
    label.className = 'cm-burley-block-lang'
    label.textContent = this.ctx.lang || 'code'
    head.appendChild(label)

    const lines = document.createElement('span')
    lines.className = 'cm-burley-block-lines'
    lines.textContent = `${lineCount(this.ctx.code)} lines`
    head.appendChild(lines)

    const spacer = document.createElement('span')
    spacer.className = 'cm-burley-block-spacer'
    head.appendChild(spacer)

    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'cm-burley-block-btn'
    edit.textContent = 'Edit'
    edit.title = 'Show the raw block source'
    edit.addEventListener('mousedown', (e) => e.stopPropagation())
    edit.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const view = getActiveView()
      if (!view) return
      const pos = Math.min(this.ctx.editPos, view.state.doc.length)
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true })
      view.focus()
    })
    head.appendChild(edit)

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'cm-burley-block-btn'
    copy.textContent = 'Copy'
    copy.title = 'Copy the block source'
    copy.addEventListener('mousedown', (e) => e.stopPropagation())
    copy.addEventListener('click', async (e) => {
      e.preventDefault()
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(this.ctx.code)
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Failed'
      }
      setTimeout(() => {
        copy.textContent = 'Copy'
      }, 1200)
    })
    head.appendChild(copy)

    root.appendChild(head)

    const body = document.createElement('div')
    body.className = 'cm-burley-block-body'
    try {
      const rendered = this.renderer.render(this.ctx)
      this.renderedEl = rendered
      body.appendChild(rendered)
    } catch (err) {
      body.appendChild(errorBox(err))
    }
    root.appendChild(body)

    return root
  }

  destroy(dom: HTMLElement): void {
    try {
      this.renderer.destroy?.(this.renderedEl ?? dom)
    } catch {
      /* ignore cleanup errors */
    }
  }

  ignoreEvent(): boolean {
    // Interactive widgets (Plotly) must receive their own pointer events.
    return true
  }
}

export function errorBox(err: unknown): HTMLElement {
  const box = document.createElement('div')
  box.className = 'cm-burley-block-error'
  const strong = document.createElement('strong')
  strong.textContent = 'Block error'
  const msg = document.createElement('code')
  msg.textContent = err instanceof Error ? err.message : String(err)
  box.appendChild(strong)
  box.appendChild(msg)
  return box
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  const currentFile = state.facet(filePathFacet)

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      const codeInfo = node.node.getChild('CodeInfo')
      const codeText = node.node.getChild('CodeText')
      const rawLang = codeInfo ? state.doc.sliceString(codeInfo.from, codeInfo.to) : ''
      const lang = rawLang.trim().split(/\s+/)[0].toLowerCase()
      if (lang === 'lua-run') return
      const code = codeText ? state.doc.sliceString(codeText.from, codeText.to) : ''
      const renderer = renderers.get(lang) ?? genericCodeRenderer

      if (!readOnly && selectionTouches(state, node.from, node.to)) {
        // Reveal the raw source for editing, in a monospace font.
        for (let pos = node.from; pos <= node.to; ) {
          const line = state.doc.lineAt(pos)
          decorations.push(Decoration.line({ class: 'cm-burley-source-code' }).range(line.from))
          pos = line.to + 1
        }
        return
      }

      const ctx: BlockContext = {
        lang,
        code,
        from: node.from,
        to: node.to,
        editPos: codeText ? codeText.from : node.from + 3,
        filePath: currentFile,
        assetUrl: (ref) => assetUrlFor(currentFile, ref),
      }
      decorations.push(
        Decoration.replace({ widget: new BlockWidget(ctx, renderer), block: true }).range(node.from, node.to),
      )
    },
  })

  return Decoration.set(decorations, true)
}

/** Live-preview rendering for fenced code blocks with a renderer registry. */
export function blockPluginField(): Extension {
  return StateField.define<DecorationSet>({
    create: buildBlockDecorations,
    update(deco, tr) {
      if (tr.docChanged || tr.reconfigured) return buildBlockDecorations(tr.state)
      if (tr.selection || tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)) {
        return buildBlockDecorations(tr.state)
      }
      return deco
    },
    provide: (field) => EditorView.decorations.from(field),
  })
}

/** Built-in plotly support is registered by `plugins/plotly.ts`. */
