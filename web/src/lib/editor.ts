/**
 * CodeMirror 6 setup for Burley's live-preview editor.
 *
 * Extensions:
 *  - @codemirror/lang-markdown with GFM tables and fenced-code highlighting
 *  - codemirror-live-markdown for Obsidian-style mark-hiding, headings, tables
 *  - Burley's own math, image, link and fenced-block widget layers
 */
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { autocompletion } from '@codemirror/autocomplete'
import { EditorView, drawSelection, dropCursor, keymap, tooltips } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Table, TaskList } from '@lezer/markdown'
import { bracketMatching, forceParsing, HighlightStyle, syntaxHighlighting, syntaxTreeAvailable } from '@codemirror/language'
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
import { mathTooltipField } from './mathTooltip'
import { linkPreviewField, setLinkOpenHandler } from './links'
import { taskCheckboxField } from './tasks'
import { blockquoteStyler } from './quotes'
import { listMarkerStyler } from './lists'
import { tableEditorField } from './tables'
import { frontmatterField } from './frontmatter'
import { detailsField } from './details'
import { commentsField } from './comments'
import { luaCellsField, setLuaCellRunHandler } from './luaCells'
import { runLuaCell } from './lua/runner'
import { escapeElementKeymap } from './escape'
import { spellcheckExclusions } from './spellcheck'
import { slashCommands } from './slashCommands'
import { zenFocusExtensions } from './zenFocus'
import { resolveRelative } from './paths'
import { setActiveView } from './viewRef'
import './plugins/plotly'
import './plugins/mermaid'

export interface SelectionInfo {
  line: number
  column: number
  selectedChars: number
  from: number
  to: number
  /** Viewport coordinates of the selection, for floating toolbars. */
  anchor: { left: number; top: number; bottom: number } | null
}

export interface EditorOptions {
  onChange: (content: string) => void
  onSelectionChange: (info: SelectionInfo) => void
  onOpenPath?: (path: string) => void
  onFiles?: (files: File[], pos: number) => void
}

export interface EditorController {
  readonly view: EditorView
  setDoc(path: string, content: string): void
  reloadDoc(path: string, content: string): void
  setReadOnly(readOnly: boolean): void
  setRawMode(raw: boolean): void
  setZenFocus(enabled: boolean): void
  setSpellcheck(enabled: boolean): void
  getContent(): string
  getSelection(): string
  insertText(text: string): void
  insertTextAt(text: string, pos: number): number
  replaceRange(from: number, to: number, text: string): void
  replaceAll(content: string): void
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
const spellcheckCompartment = new Compartment()
const zenCompartment = new Compartment()

function readOnlyExtensions(value: boolean): Extension {
  return [EditorState.readOnly.of(value), EditorView.editable.of(!value), readOnlyFacet.of(value)]
}

function spellcheckExtensions(enabled: boolean): Extension {
  return [
    EditorView.contentAttributes.of({ spellcheck: enabled ? 'true' : 'false' }),
    ...(enabled ? [spellcheckExclusions] : []),
  ]
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
    frontmatterField(),
    detailsField(),
    commentsField(),
    luaCellsField(),
    livePreviewPlugin,
    markdownStylePlugin,
    tableEditorField(),
    blockPluginField(),
    imagePreviewField,
    linkPreviewField,
    inlineMathPlugin,
    blockMathField,
    mathTooltipField(),
    tooltips({ position: 'absolute' }),
    taskCheckboxField,
    blockquoteStyler,
    listMarkerStyler,
  ]
}

function markdownExtensions(readOnly: boolean, rawMode: boolean, spellcheck: boolean): Extension[] {
  return [
    history(),
    autocompletion({ override: [slashCommands], icons: false }),
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
    spellcheckCompartment.of(spellcheckExtensions(spellcheck)),
    zenCompartment.of([]),
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
  setLuaCellRunHandler(runLuaCell)

  let currentPath = ''
  let readOnly = false
  let rawMode = false
  let zenFocus = false
  let spellcheck = false
  let parseRefreshTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Large notes are parsed lazily; nudge the parser until the tree covers the
   * document so tables, fenced blocks, links and math render everywhere (not
   * just in the initially parsed viewport).
   */
  function refreshParsedPreview(target: EditorView): void {
    if (parseRefreshTimer) {
      clearTimeout(parseRefreshTimer)
      parseRefreshTimer = null
    }
    let attempts = 0
    const tick = () => {
      parseRefreshTimer = null
      if (!target.dom.isConnected) return
      if (syntaxTreeAvailable(target.state, target.state.doc.length)) return
      try {
        const complete = forceParsing(target, target.state.doc.length, 40)
        if (complete || attempts++ >= 150) return
      } catch {
        return
      }
      parseRefreshTimer = setTimeout(tick, 20)
    }
    parseRefreshTimer = setTimeout(tick, 0)
  }

  let pointerDown = false

  const listener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      opts.onChange(update.state.doc.toString())
    }
    if (update.selectionSet || update.docChanged) {
      const head = update.state.selection.main.head
      const line = update.state.doc.lineAt(head)
      const main = update.state.selection.main
      let anchor: SelectionInfo['anchor'] = null
      if (main.to > main.from) {
        const start = update.view.coordsAtPos(main.from)
        const end = update.view.coordsAtPos(main.to)
        const headCoords = update.view.coordsAtPos(main.head)
        if (start && end) {
          anchor = {
            left: Math.min(window.innerWidth - 24, Math.max(24, (start.left + end.right) / 2)),
            top: Math.min(start.top, end.top),
            bottom: Math.max(start.bottom, end.bottom),
          }
        } else if (headCoords) {
          anchor = {
            left: Math.min(window.innerWidth - 24, Math.max(24, headCoords.left)),
            top: headCoords.top,
            bottom: headCoords.bottom,
          }
        }
      }
      opts.onSelectionChange({
        line: line.number,
        column: head - line.from + 1,
        selectedChars: update.state.selection.ranges.reduce(
          (sum, range) => sum + Math.max(0, range.to - range.from),
          0,
        ),
        from: main.from,
        to: main.to,
        anchor,
      })
    }
  })

  const extensionsFor = (path: string): Extension[] => [
    ...markdownExtensions(readOnly, rawMode, spellcheck),
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
  const onMouseDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.cm-burley-table-widget, .cm-burley-details-wrap, .cm-burley-block, .cm-burley-lua-cell')) {
      return
    }
    pointerDown = true
    view.dispatch({ effects: setMouseSelecting.of(true) })
  }
  view.contentDOM.addEventListener('mousedown', onMouseDown, true)
  const onMouseUp = () => {
    pointerDown = false
    requestAnimationFrame(() => {
      if (
        !pointerDown &&
        view.contentDOM.isConnected &&
        view.state.field(mouseSelectingField, false)
      ) {
        view.dispatch({ effects: setMouseSelecting.of(false) })
      }
    })
  }
  document.addEventListener('mouseup', onMouseUp)

  const imageFiles = (data: DataTransfer | null): File[] =>
    Array.from(data?.files ?? []).filter((file) => file.type.startsWith('image/'))

  const onPaste = (event: ClipboardEvent) => {
    const files = imageFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    opts.onFiles?.(files, view.state.selection.main.from)
  }
  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
  }
  const onDrop = (event: DragEvent) => {
    const files = imageFiles(event.dataTransfer)
    if (files.length === 0) return
    event.preventDefault()
    const position =
      view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
    opts.onFiles?.(files, position)
  }
  view.contentDOM.addEventListener('paste', onPaste)
  view.contentDOM.addEventListener('dragover', onDragOver)
  view.contentDOM.addEventListener('drop', onDrop)

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
      refreshParsedPreview(view)
    },

    reloadDoc(path: string, content: string) {
      currentPath = path
      const scroller = view.scrollDOM
      const top = scroller.scrollTop
      const left = scroller.scrollLeft
      const prevAnchor = Math.min(view.state.selection.main.head, content.length)
      const next = EditorState.create({
        doc: content,
        selection: { anchor: prevAnchor },
        extensions: extensionsFor(path),
      })
      view.setState(next)
      refreshParsedPreview(view)
      requestAnimationFrame(() => {
        scroller.scrollTop = top
        scroller.scrollLeft = left
      })
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

    setZenFocus(value: boolean) {
      if (zenFocus === value) return
      zenFocus = value
      view.dispatch({
        effects: zenCompartment.reconfigure(value ? zenFocusExtensions() : []),
      })
    },

    setSpellcheck(value: boolean) {
      if (spellcheck === value) return
      spellcheck = value
      view.dispatch({
        effects: spellcheckCompartment.reconfigure(spellcheckExtensions(value)),
      })
    },

    getContent() {
      return view.state.doc.toString()
    },

    getSelection() {
      const range = view.state.selection.main
      return view.state.doc.sliceString(range.from, range.to)
    },

    insertText(text: string) {
      const range = view.state.selection.main
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
        scrollIntoView: true,
      })
      view.focus()
    },

    insertTextAt(text: string, pos: number): number {
      const at = Math.max(0, Math.min(pos, view.state.doc.length))
      view.dispatch({
        changes: { from: at, insert: text },
        selection: { anchor: at + text.length },
        scrollIntoView: true,
      })
      view.focus()
      return at + text.length
    },

    replaceRange(from: number, to: number, text: string) {
      const start = Math.max(0, Math.min(from, view.state.doc.length))
      const end = Math.max(start, Math.min(to, view.state.doc.length))
      view.dispatch({
        changes: { from: start, to: end, insert: text },
        selection: { anchor: start + text.length },
        scrollIntoView: true,
      })
      view.focus()
    },

    replaceAll(content: string) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: { anchor: 0 },
      })
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
      view.contentDOM.removeEventListener('mousedown', onMouseDown, true)
      view.contentDOM.removeEventListener('click', onClick)
      view.contentDOM.removeEventListener('paste', onPaste)
      view.contentDOM.removeEventListener('dragover', onDragOver)
      view.contentDOM.removeEventListener('drop', onDrop)
      document.removeEventListener('mouseup', onMouseUp)
      setLinkOpenHandler(null)
      setActiveView(null)
      if (parseRefreshTimer) {
        clearTimeout(parseRefreshTimer)
        parseRefreshTimer = null
      }
      view.destroy()
    },
  }
}
