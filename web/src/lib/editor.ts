/**
 * CodeMirror 6 setup for Burley's live-preview editor.
 *
 * Extensions:
 *  - @codemirror/lang-markdown with GFM tables and fenced-code highlighting
 *  - codemirror-live-markdown for Obsidian-style mark-hiding, headings, tables
 *  - Burley's own math, image, link and fenced-block widget layers
 */
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Table, TaskList } from '@lezer/markdown'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import {
  collapseOnSelectionFacet,
  editorTheme,
  livePreviewPlugin,
  markdownStylePlugin,
  mouseSelectingField,
  setMouseSelecting,
} from 'codemirror-live-markdown'
import { filePathFacet, readOnlyFacet } from './cm'
import { blockPluginField } from './blockPlugins'
import { imagePreviewField } from './images'
import { blockMathField, inlineMathPlugin } from './math'
import { linkPreviewField, setLinkOpenHandler } from './links'
import { taskCheckboxField } from './tasks'
import { blockquoteStyler } from './quotes'
import { listMarkerStyler } from './lists'
import { tableEditorField } from './tables'
import { escapeElementKeymap } from './escape'
import { resolveRelative } from './paths'
import { setActiveView } from './viewRef'
import './plugins/plotly'

export interface SelectionInfo {
  line: number
  column: number
  selectedChars: number
}

export interface EditorOptions {
  onChange: (content: string) => void
  onSelectionChange: (info: SelectionInfo) => void
  onOpenPath?: (path: string) => void
}

export interface EditorController {
  readonly view: EditorView
  setDoc(path: string, content: string): void
  setReadOnly(readOnly: boolean): void
  setRawMode(raw: boolean): void
  getContent(): string
  focus(): void
  scrollToLine(line: number, column?: number): void
  destroy(): void
}

const burleyHighlightStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-muted)' },
  { tag: [t.link, t.url], color: 'hsl(var(--md-link))', textDecoration: 'underline' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.tagName], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syntax-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syntax-number)' },
  { tag: [t.comment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syntax-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syntax-type)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName)], color: 'var(--syntax-property)' },
  { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--syntax-punctuation)' },
  { tag: t.invalid, color: 'var(--danger-fg)' },
])

const burleyTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '16px',
    backgroundColor: 'var(--bg-app)',
    color: 'hsl(var(--foreground))',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-body)',
    lineHeight: '1.72',
    overflowY: 'auto',
  },
  '.cm-content': {
    maxWidth: 'var(--editor-measure, 820px)',
    width: '100%',
    margin: '0 auto',
    padding: '44px var(--editor-gutter, 48px) 140px',
    caretColor: 'var(--accent)',
    transition: 'max-width 0.16s ease, padding 0.16s ease',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection-strong) !important' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-placeholder': { color: 'hsl(var(--muted-foreground))' },
  '.cm-header-1': { fontWeight: '700', letterSpacing: '-0.02em' },
  '.cm-header-2': { fontWeight: '650', letterSpacing: '-0.01em' },
  '.cm-header-3, .cm-header-4, .cm-header-5, .cm-header-6': { fontWeight: '600' },
  '.cm-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
    backgroundColor: 'hsl(var(--muted))',
    padding: '2px 5px',
    borderRadius: '4px',
  },
  '.cm-strong': { fontWeight: '700' },
  '.cm-burley-math-inline': { padding: '0 1px' },
  '.cm-burley-math-block': { padding: '0.35em 0' },
  '.cm-burley-math-error': { color: 'var(--danger-fg)' },
  '.cm-burley-math-source-line': { backgroundColor: 'hsl(var(--muted) / 0.6)' },
})

const readOnlyCompartment = new Compartment()
const previewCompartment = new Compartment()

function readOnlyExtensions(value: boolean): Extension {
  return [EditorState.readOnly.of(value), EditorView.editable.of(!value), readOnlyFacet.of(value)]
}

/**
 * In read-only mode we still allow selecting text (to copy it) but ignore
 * cursor moves, so live-preview syntax stays collapsed while browsing.
 */
const readOnlySelectionGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.startState.facet(readOnlyFacet)) return tr
  if (tr.docChanged || !tr.selection) return tr
  const next = tr.newSelection.main
  const prev = tr.startState.selection.main
  if (next.empty && next.head !== prev.head) return []
  return tr
})

function previewExtensions(): Extension[] {
  return [
    collapseOnSelectionFacet.of(true),
    mouseSelectingField,
    livePreviewPlugin,
    markdownStylePlugin,
    tableEditorField(),
    blockPluginField(),
    imagePreviewField,
    linkPreviewField,
    inlineMathPlugin,
    blockMathField,
    taskCheckboxField,
    blockquoteStyler,
    listMarkerStyler,
  ]
}

function markdownExtensions(readOnly: boolean, rawMode: boolean): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    bracketMatching(),
    EditorView.lineWrapping,
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [Table, TaskList],
    }),
    syntaxHighlighting(burleyHighlightStyle, { fallback: true }),
    editorTheme,
    burleyTheme,
    previewCompartment.of(rawMode ? [] : previewExtensions()),
    readOnlySelectionGuard,
    escapeElementKeymap,
    readOnlyCompartment.of(readOnlyExtensions(readOnly)),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  ]
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorController {
  if (opts.onOpenPath) {
    setLinkOpenHandler((path) => opts.onOpenPath?.(path))
  }

  let currentPath = ''
  let readOnly = false
  let rawMode = false

  const listener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      opts.onChange(update.state.doc.toString())
    }
    if (update.selectionSet || update.docChanged) {
      const head = update.state.selection.main.head
      const line = update.state.doc.lineAt(head)
      opts.onSelectionChange({
        line: line.number,
        column: head - line.from + 1,
        selectedChars: update.state.selection.ranges.reduce(
          (sum, range) => sum + Math.max(0, range.to - range.from),
          0,
        ),
      })
    }
  })

  const extensionsFor = (path: string): Extension[] => [
    ...markdownExtensions(readOnly, rawMode),
    listener,
    filePathFacet.of(path),
  ]

  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions: extensionsFor('') }),
    parent,
  })
  setActiveView(view)

  // Required by codemirror-live-markdown to avoid decoration churn while
  // dragging a text selection.
  const onMouseDown = () => {
    view.dispatch({ effects: setMouseSelecting.of(true) })
  }
  view.contentDOM.addEventListener('mousedown', onMouseDown)
  const onMouseUp = () => {
    requestAnimationFrame(() => {
      if (view.contentDOM.isConnected) {
        view.dispatch({ effects: setMouseSelecting.of(false) })
      }
    })
  }
  document.addEventListener('mouseup', onMouseUp)

  // Open relative Markdown links inside Burley rather than in a new tab.
  const onClick = (event: MouseEvent) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a') as HTMLAnchorElement | null
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return
    const resolved = resolveRelative(currentPath || view.state.facet(filePathFacet), href)
    if (resolved && /\.(md|markdown|mdown|mkd)$/i.test(resolved)) {
      event.preventDefault()
      opts.onOpenPath?.(resolved)
    }
  }
  view.contentDOM.addEventListener('click', onClick)

  return {
    view,

    setDoc(path: string, content: string) {
      currentPath = path
      const next = EditorState.create({ doc: content, extensions: extensionsFor(path) })
      view.setState(next)
      view.scrollDOM.scrollTop = 0
      view.scrollDOM.scrollLeft = 0
    },

    setReadOnly(value: boolean) {
      if (readOnly === value) return
      readOnly = value
      const scroller = view.scrollDOM
      const top = scroller.scrollTop
      const left = scroller.scrollLeft
      if (value) {
        // Park the cursor at the end of the document so no element is "active";
        // this must happen before the read-only guard is installed.
        view.dispatch({ selection: { anchor: view.state.doc.length } })
      }
      view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions(value)) })
      if (value) {
        requestAnimationFrame(() => {
          scroller.scrollTop = top
          scroller.scrollLeft = left
        })
      }
    },

    setRawMode(value: boolean) {
      if (rawMode === value) return
      rawMode = value
      view.dispatch({
        effects: previewCompartment.reconfigure(value ? [] : previewExtensions()),
      })
    },

    getContent() {
      return view.state.doc.toString()
    },

    focus() {
      view.focus()
    },

    scrollToLine(lineNumber: number, column = 1) {
      const doc = view.state.doc
      const line = doc.line(Math.max(1, Math.min(lineNumber, doc.lines)))
      const pos = Math.max(line.from, Math.min(line.from + column - 1, line.to))
      if (view.state.facet(readOnlyFacet)) {
        // Moving the selection is blocked while locked; scroll only.
        view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
        return
      }
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      })
      view.focus()
    },

    destroy() {
      view.contentDOM.removeEventListener('mousedown', onMouseDown)
      view.contentDOM.removeEventListener('click', onClick)
      document.removeEventListener('mouseup', onMouseUp)
      setLinkOpenHandler(null)
      setActiveView(null)
      view.destroy()
    },
  }
}
