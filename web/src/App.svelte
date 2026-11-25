<script lang="ts">
  import { onMount, tick } from 'svelte'
  import fuzzysort from 'fuzzysort'
  import { api, ConflictError, streamAgentChat, type AgentInfo, type AgentTestResult, type AppSettings, type Entry, type FileData, type FlatFile, type ReleaseInfo, type TreeResponse } from './lib/api'
  import { createEditor, type EditorController, type SelectionInfo } from './lib/editor'
  import { countWords, decodeForEditor, defaultFormat, encodeForSave, type TextFormat } from './lib/text'
  import { baseName, dirOf, formatBytes, isHtmlPath, isMarkdownPath, normalizeExplicitPath, openNoteInNewTab, stripMdExt } from './lib/paths'
  import type { PaletteCommand } from './lib/palette'
  import { setLinkClickBehavior } from './lib/links'
import { restartLuaVM, setLuaDocument, setLuaNotifyHandler } from './lib/lua/runner'
import { setFigureOpenHandler, type FigureItem } from './lib/figures'
import { bugReportUrl, openExternal, REPO_URL } from './lib/project'
import { cleanSuggestion, SPARKLE_LABELS, SPARKLE_PROMPTS, type SparkleAction } from './lib/sparkle'
import { wordDiff } from './lib/diff'
  import { renderMarkdown, extractFencedBlocks, type FencedBlock } from './lib/markdown'
  import { buildExportHtml, downloadHtml, exportFileName, printPdf } from './lib/export'
  import SettingsModal from './components/SettingsModal.svelte'
  import ShortcutsModal from './components/ShortcutsModal.svelte'
  import { buildOutline, type OutlineItem } from './lib/outline'
  import {
    applyTheme,
    isDarkPalette,
    isLightPalette,
    nextThemeMode,
    storePalettes,
    storeThemeMode,
    storedDarkPalette,
    storedLightPalette,
    storedThemeMode,
    watchSystemTheme,
    type DarkPalette,
    type LightPalette,
    type ThemeMode,
  } from './lib/theme'
  import FileTree from './components/FileTree.svelte'
  import SearchModal from './components/SearchModal.svelte'
  import ConflictModal from './components/ConflictModal.svelte'
  import PresentationModal from './components/PresentationModal.svelte'
  import FigureLightbox from './components/FigureLightbox.svelte'
  import CommentsPanel from './components/CommentsPanel.svelte'
  import {
    addCommentToDoc,
    addReplyToDoc,
    deleteCommentFromDoc,
    deleteReplyFromDoc,
    editCommentMessageInDoc,
    parseDocComments,
    type CommentKind,
    type DocComment,
  } from './lib/docComments'

  type SaveState = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error'

  const LAST_PATH_KEY = 'burley:last-path'
  const SIDEBAR_KEY = 'burley:sidebar'
  const SIDEBAR_TAB_KEY = 'burley:sidebar-tab'
  const SIDEBAR_WIDTH_KEY = 'burley:sidebar-width'
  const TALK_WIDTH_KEY = 'burley:talk-width'
  const WIDE_MODE_KEY = 'burley:wide-mode'
  const FAVORITES_OPEN_KEY = 'burley:favorites-open'
  const RAW_MODE_KEY = 'burley:raw-mode'
  const SCOPE_KEY = 'burley:scope'
  const ZEN_KEY = 'burley:zen'
  const COMMENT_AUTHOR_KEY = 'burley:comment-author'
  const SIDEBAR_MIN = 220
  const SIDEBAR_MAX = 560
  const TALK_MIN = 220
  const TALK_MAX = 720
  const TALK_DEFAULT = 350

  let tree = $state<Entry[]>([])
  let files = $state<FlatFile[]>([])
  let root = $state('')
  let loading = $state(true)
  let treeComplete = $state(true)
  let loadError = $state('')
  let scopePath = $state<string | null>(null)

  let currentPath = $state('')
  let format = $state<TextFormat>(defaultFormat)
  let hash = $state('')
  let modTime = $state(0)
  let content = $state('')
  let dirty = $state(false)
  let saveState = $state<SaveState>('saved')
  let saveError = $state('')
  let loadingFile = $state(false)

  let readOnly = $state(false)
  let sidebarOpen = $state(true)
  let sidebarTab = $state<'files' | 'outline'>('files')
  let sidebarWidth = $state(302)
  let wideMode = $state(false)
  let markdownStyle = $state<AppSettings['markdownStyle']>('default')
  let autoSave = $state(true)
  let ctrlClickLink = $state<'toggle' | 'open'>('toggle')
  let spellCheck = $state(false)
  let fileTypes = $state<string[]>(['markdown', 'html'])
  let backgroundScan = $state(false)
  let agentPins = $state<Record<string, string>>({})
  let disabledAgents = $state<string[]>([])
  let rawMode = $state(false)
  let htmlFrameNonce = $state(0)
  const isCurrentHtml = $derived(isHtmlPath(currentPath))
  const htmlFrameSrc = $derived(
    isCurrentHtml ? `/raw/${encodeURI(currentPath)}?v=${htmlFrameNonce}` : '',
  )
  let zenMode = $state(false)
  let scrollProgress = $state(0)
  let figureOpen = $state(false)
  let figureItems = $state<FigureItem[]>([])
  let figureIndex = $state(0)
  let appVersion = $state('')
  let repoUrl = $state(REPO_URL)
  let releaseInfo = $state<ReleaseInfo | null>(null)
  let checkingRelease = $state(false)
  let settingsOpen = $state(false)
  let shortcutsOpen = $state(false)
  let rightPanel = $state<null | 'talk' | 'comments'>(null)
  const talkOpen = $derived(rightPanel === 'talk')
  const commentsOpen = $derived(rightPanel === 'comments')
  let talkWidth = $state(TALK_DEFAULT)
  let talkAgent = $state('')
  let talkMode = $state<'ask' | 'edit'>('ask')
  let commentAuthor = $state('')
  let commentAuthorSetting = $state('')
  let commentHoverPreview = $state(true)
  let demoSeen = $state(false)
  let serverDemoMode = $state(false)
  let virtualDemoActive = $state(false)
  let demoTree = $state<Entry[]>([])
  let demoFiles = $state<FlatFile[]>([])
  let savedRealPath = $state('')
  let readOnlyBeforeDemo = false
  const effectiveCommentAuthor = $derived(commentAuthorSetting || commentAuthor)
  let activeCommentId = $state<string | null>(null)
  let hoveredComment = $state<{
    id: string
    left: number
    top: number
    bottom: number
  } | null>(null)
  let hoverCloseTimer: ReturnType<typeof setTimeout> | null = null
  let commentDraft = $state<{
    from: number
    to: number
    snippet: string
    line: number
    openedPanel: boolean
    autoFocus?: boolean
  } | null>(null)

  const parsedComments = $derived(
    currentPath && !isCurrentHtml && content
      ? parseDocComments(content)
      : { comments: [], anchors: [] },
  )
  const docComments = $derived(parsedComments.comments)
  const hoveredDocComment = $derived(
    commentHoverPreview && hoveredComment
      ? (docComments.find((c) => c.id === hoveredComment!.id) ?? null)
      : null,
  )

  interface TalkDebug {
    command?: string
    args?: string[]
    exitCode?: number
    durationMs?: number
    stderr?: string
    error?: string
  }

  interface TalkMessage {
    role: 'user' | 'assistant'
    content: string
    action?: SparkleAction
    /** Selection the request was about, for the quote and rewrite diff. */
    selection?: string
    from?: number
    to?: number
    path?: string
    applied?: boolean
    debug?: TalkDebug
  }

  let allAgents = $state<AgentInfo[]>([])
  let agentPathEnv = $state('')
  let talkDiagOpen = $state(false)
  let agentTests = $state<Record<string, AgentTestResult>>({})
  let agentTesting = $state<Record<string, boolean>>({})
  let agentTestSeq: Record<string, number> = {}
  let agentTestInFlightModel: Record<string, string> = {}

  function isAgentEnabled(id: string): boolean {
    return !disabledAgents.includes(id)
  }

  function agentRank(agent: AgentInfo): number {
    if (!agent.available) return 4
    if (!isAgentEnabled(agent.id)) return 3
    if (agentTests[agent.id]?.confirmed) return 0
    if (agentTesting[agent.id] || !agentTests[agent.id]) return 1
    return 2
  }

  const sortedAllAgents = $derived.by(() => [...allAgents].sort((a, b) => agentRank(a) - agentRank(b)))
  const agents = $derived.by(() => sortedAllAgents.filter((a) => a.available && isAgentEnabled(a.id)))

  $effect(() => {
    if (agents.length === 0) {
      talkAgent = ''
      return
    }
    if (!talkAgent || !agents.some((a) => a.id === talkAgent)) {
      talkAgent = agents[0].id
      return
    }
    if (
      !talkStreaming &&
      talkMessages.length === 0 &&
      agentTests[talkAgent]?.confirmed === false &&
      agentTests[agents[0].id]?.confirmed === true
    ) {
      talkAgent = agents[0].id
    }
  })
  let talkMessages = $state<TalkMessage[]>([])
  let talkPinnedSelection = $state('')
  let selectedRange = $state<{ text: string; from: number; to: number } | null>(null)
  let talkInput = $state('')
  let talkStreaming = $state(false)
  let talkError = $state('')
  let talkMessagesEl = $state<HTMLDivElement | null>(null)
  let talkAbort: AbortController | null = null
  const TALK_SELECTION_ACTIONS: Array<{ id: Exclude<SparkleAction, 'ask'>; label: string; hint: string }> = [
    { id: 'explain', label: 'Explain', hint: 'What does this mean?' },
    { id: 'summarize', label: 'Summarize', hint: 'Condense into bullets' },
    { id: 'shorten', label: 'Shorten', hint: 'Tighten the wording' },
    { id: 'rewrite', label: 'Rewrite', hint: 'Polish and compare' },
  ]
  const activeTalkSelection = $derived<{ text: string; from?: number; to?: number } | null>(
    selectedRange ?? (talkPinnedSelection ? { text: talkPinnedSelection, from: undefined, to: undefined } : null),
  )
  let exportMenuOpen = $state(false)
  let exporting = $state(false)
  let favorites = $state<string[]>([])
  let favoritesOpen = $state(true)
  let dragFavoritePath = $state<string | null>(null)
  let treeFilter = $state('')
  let treeCollapseSignal = $state(0)
  let treeScrollEl = $state<HTMLElement | null>(null)
  let rescanningFolder = $state('')
  let themeMode = $state<ThemeMode>(storedThemeMode())
  let lightTheme = $state<LightPalette>(storedLightPalette())
  let darkTheme = $state<DarkPalette>(storedDarkPalette())
  let cursor = $state<SelectionInfo>({ line: 1, column: 1, selectedChars: 0, from: 0, to: 0, anchor: null })

  let searchOpen = $state(false)
  let searchInitial = $state('')
  let searchTriggerEl = $state<HTMLButtonElement | null>(null)
  let paletteAnchor = $state({ left: 0, top: 0, width: 0 })
  let restoreEditorFocus = false
  let recent = $state<string[]>([])
  let recentSaveTimer: ReturnType<typeof setTimeout> | null = null
  let conflictData = $state<FileData | null>(null)
  let conflictOpen = $state(false)
  let presentOpen = $state(false)

  let splitPath = $state('')
  let splitContent = $state('')
  let splitHash = $state('')
  let splitLoading = $state(false)
  let splitHtmlNonce = $state(0)
  const isSplitHtml = $derived(isHtmlPath(splitPath))
  const splitHtmlSrc = $derived(
    isSplitHtml ? `/raw/${encodeURI(splitPath)}?v=${splitHtmlNonce}` : '',
  )
  const splitHtmlRendered = $derived(
    !isSplitHtml && splitPath ? renderMarkdown(splitContent) : '',
  )

  let quitOpen = $state(false)
  let shuttingDown = $state(false)
  let contextMenu = $state<{ x: number; y: number; path: string; isDir: boolean } | null>(null)
  let contextMenuHasAssets = $state(false)
  let currentHasAssets = $state(false)
  let pendingDelete = $state<{ path: string; isDir: boolean } | null>(null)
  let deleteDialogEl = $state<HTMLDialogElement | null>(null)
  let pendingProperties = $state<{ path: string; isDir: boolean; sizeBytes: number } | null>(null)
  let propertiesDialogEl = $state<HTMLDialogElement | null>(null)
  let pendingRename = $state<{ path: string; isDir: boolean } | null>(null)
  let renameDialogEl = $state<HTMLDialogElement | null>(null)
  let renameInput = $state<HTMLInputElement | null>(null)
  let renameValue = $state('')
  let renameError = $state('')
  let renameBusy = $state(false)
  let newDocDialogEl = $state<HTMLDialogElement | null>(null)
  let newDocInput = $state<HTMLInputElement | null>(null)
  let newDocFolder = $state('')
  let newDocName = $state('')
  let newDocError = $state('')
  let newDocBusy = $state(false)

  let toast = $state('')
  let toastError = $state(false)

  let editorHost: HTMLDivElement
  let editor: EditorController | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saving = false
  let saveQueued = false
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let treePollTimer: ReturnType<typeof setTimeout> | null = null
  let treeRequestId = 0

  const words = $derived(countWords(content))
  const readMinutes = $derived(Math.max(1, Math.round(words / 220)))
  const absolutePath = $derived.by(() => {
    if (!currentPath) return ''
    const separator = root.includes('\\') ? '\\' : '/'
    return `${root.replace(/[\\/]+$/, '')}${separator}${currentPath.split('/').join(separator)}`
  })
  const modifiedLabel = $derived(
    modTime
      ? new Date(modTime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '',
  )
  const outline = $derived(buildOutline(content))
  const activeHeading = $derived.by<OutlineItem | null>(() => {
    let current: OutlineItem | null = null
    for (const item of outline) {
      if (item.line <= cursor.line) current = item
      else break
    }
    return current
  })
  const activeHeadingLine = $derived(activeHeading?.line ?? 0)
  const fileByPath = $derived(new Map(files.map((file) => [file.path, file])))
  const favoriteItems = $derived.by(() =>
    favorites.map((path) => ({
      path,
      name: baseName(path),
      dir: dirOf(path),
      exists: !treeComplete || fileByPath.has(path),
    })),
  )
  const filteredFavorites = $derived.by(() => {
    const query = treeFilter.trim()
    if (!query) return favoriteItems
    return fuzzysort
      .go(query, favoriteItems, { key: 'path', limit: 40, threshold: -20000 })
      .map((result) => result.obj)
  })
  const showFavorites = $derived(!treeFilter.trim() || filteredFavorites.length > 0)
  const currentIsFavorite = $derived(!!currentPath && favorites.includes(currentPath))
  const scopedEntry = $derived(scopePath ? findFolder(tree, scopePath) : null)
  const treeEntries = $derived(scopePath ? (scopedEntry?.children ?? []) : tree)
  const visibleTreeEntries = $derived(virtualDemoActive ? demoTree : treeEntries)
  const visiblePaletteFiles = $derived(virtualDemoActive ? demoFiles : files)

  $effect(() => {
    const path = currentPath
    const heading = activeHeading
    if (!path) return
    replaceUrl(path, heading?.slug ?? '')
  })
  const paletteCommands = $derived<PaletteCommand[]>([
    {
      id: 'toggle-readonly',
      label: readOnly ? 'Turn off Read-Only mode' : 'Turn on Read-Only mode',
      keywords: 'lock browse editing',
      run: () => void toggleReadOnly(),
    },
    {
      id: 'toggle-sidebar',
      label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
      keywords: 'tree panel files',
      run: toggleSidebar,
    },
    {
      id: 'toggle-favorite',
      label: currentIsFavorite ? 'Remove current file from favorites' : 'Add current file to favorites',
      keywords: 'star pin bookmark',
      run: () => toggleFavorite(currentPath),
    },
    {
      id: 'refresh-tree',
      label: 'Refresh file tree',
      keywords: 'reload files rescan',
      run: () => void refreshTree(true),
    },
    {
      id: 'toggle-wide',
      label: wideMode ? 'Use narrow reading width' : 'Use wide reading width',
      keywords: 'layout margins measure',
      run: toggleWideMode,
    },
    {
      id: 'cycle-theme',
      label: `Change theme (currently ${themeMode})`,
      keywords: 'dark light system appearance',
      run: cycleTheme,
    },
    {
      id: 'toggle-raw',
      label: rawMode ? 'Show live preview' : 'Show raw Markdown',
      keywords: 'source editor',
      run: toggleRawMode,
    },
    {
      id: 'reload-file',
      label: 'Reload & re-render file',
      keywords: 'refresh assets images charts',
      run: () => void reloadCurrentFile(),
    },
    {
      id: 'present-slides',
      label: 'Present slides (---)',
      keywords: 'presentation deck slideshow f5',
      run: () => {
        if (currentPath && !isCurrentHtml) presentOpen = true
      },
    },
    {
      id: 'add-comment',
      label: 'Add comment (Alt+C)',
      keywords: 'discussion edit annotate review note',
      run: openCommentDraft,
    },
    {
      id: 'toggle-comments',
      label: commentsOpen ? 'Hide Comments panel' : 'Show Comments panel',
      keywords: 'discussions edits review annotations',
      run: toggleComments,
    },
    {
      id: 'toggle-split',
      label: splitPath ? 'Close split pane' : 'Open current file in split pane',
      keywords: 'side by side compare view',
      run: () => {
        if (splitPath) closeSplit()
        else if (currentPath) void openInSplit(currentPath)
      },
    },
    {
      id: 'toggle-zen',
      label: zenMode ? 'Exit Zen mode' : 'Enter Zen mode',
      keywords: 'focus distraction free writing reading',
      run: toggleZenMode,
    },
    {
      id: 'open-demo',
      label: virtualDemoActive ? 'Exit Feature Demo' : 'Open Feature Demo',
      keywords: 'tour examples tutorial built-in',
      run: () => {
        if (virtualDemoActive) void exitVirtualDemo()
        else void openVirtualDemo()
      },
    },
    {
      id: 'restart-lua',
      label: 'Restart Lua VM',
      keywords: 'lua cell sandbox reset',
      run: () => {
        restartLuaVM()
        flash('Lua VM restarted')
      },
    },
    {
      id: 'report-bug',
      label: 'Report a bug on GitHub',
      keywords: 'issue problem github feedback help',
      run: () => openExternal(bugReportUrl(repoUrl, appVersion, currentPath)),
    },
    {
      id: 'markdown-style',
      label: `Change Markdown style (currently ${markdownStyle})`,
      keywords: 'github academic compact typography',
      run: cycleMarkdownStyle,
    },
    {
      id: 'settings',
      label: 'Open settings',
      keywords: 'preferences behaviour appearance',
      run: () => {
        settingsOpen = true
      },
    },
    {
      id: 'shortcuts',
      label: 'Show keyboard shortcuts',
      keywords: 'help keys cheatsheet',
      run: () => {
        shortcutsOpen = true
      },
    },
    {
      id: 'export-html',
      label: 'Export note as HTML',
      keywords: 'download save offline',
      run: () => void runExport('html'),
    },
    {
      id: 'export-pdf',
      label: 'Export note as PDF',
      keywords: 'download print save',
      run: () => void runExport('pdf'),
    },
    {
      id: 'spellcheck',
      label: spellCheck ? 'Turn off spell checking' : 'Turn on spell checking',
      keywords: 'spelling squiggles',
      run: () => updateSetting({ spellCheck: !spellCheck }),
    },
  ])
  const saveLabel = $derived(
    saveState === 'saved'
      ? 'Saved'
      : saveState === 'saving'
        ? 'Saving…'
        : saveState === 'unsaved'
          ? 'Unsaved'
          : saveState === 'conflict'
            ? 'Conflict'
            : 'Save failed',
  )

  onMount(() => {
    const storedSidebar = localStorage.getItem(SIDEBAR_KEY)
    if (storedSidebar !== null) sidebarOpen = storedSidebar === '1'
    const storedTab = localStorage.getItem(SIDEBAR_TAB_KEY)
    if (storedTab === 'files' || storedTab === 'outline') sidebarTab = storedTab
    const storedWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    if (Number.isFinite(storedWidth) && storedWidth >= SIDEBAR_MIN) {
      sidebarWidth = clampSidebarWidth(storedWidth)
    }
    const storedTalkWidth = Number(localStorage.getItem(TALK_WIDTH_KEY))
    if (Number.isFinite(storedTalkWidth) && storedTalkWidth >= TALK_MIN) {
      talkWidth = clampTalkWidth(storedTalkWidth)
    }
    wideMode = localStorage.getItem(WIDE_MODE_KEY) === '1'
    rawMode = localStorage.getItem(RAW_MODE_KEY) === '1'
    zenMode = localStorage.getItem(ZEN_KEY) === '1'
    const storedAuthor = localStorage.getItem(COMMENT_AUTHOR_KEY)
    if (storedAuthor) commentAuthor = storedAuthor
    const storedFavoritesOpen = localStorage.getItem(FAVORITES_OPEN_KEY)
    if (storedFavoritesOpen !== null) favoritesOpen = storedFavoritesOpen === '1'

    applyTheme(themeMode, lightTheme, darkTheme)
    const unwatchTheme = watchSystemTheme(() => {
      if (themeMode === 'system') applyTheme('system', lightTheme, darkTheme)
    })

    editor = createEditor(editorHost, {
      onChange: handleEditorChange,
      onSelectionChange: (info) => {
        cursor = info
        if (info.selectedChars > 0) {
          const text = editor?.getSelection() ?? ''
          selectedRange = text.trim() ? { text, from: info.from, to: info.to } : null
          if (commentsOpen && currentPath && !isCurrentHtml) {
            const nextDraft = prepareCommentDraftFromSelection(false, false)
            if (nextDraft) {
              commentDraft = nextDraft
            } else if (commentDraft?.autoFocus === false) {
              commentDraft = null
            }
          }
        } else {
          selectedRange = null
          if (commentsOpen && commentDraft?.autoFocus === false) {
            commentDraft = null
          }
        }
      },
      onOpenPath: (path) => {
        const hashIdx = path.indexOf('#')
        if (hashIdx >= 0) {
          const targetPath = path.slice(0, hashIdx) || currentPath
          const hash = path.slice(hashIdx + 1)
          void openFile(targetPath, undefined, hash ? { hash } : {})
        } else {
          void openFile(path)
        }
      },
      onFiles: (files, pos) => {
        void uploadImages(files, pos)
      },
      onSelectComment: (id) => {
        hoveredComment = null
        activeCommentId = id
        rightPanel = 'comments'
      },
      onHoverComment: (id, rect) => {
        if (hoverCloseTimer) {
          clearTimeout(hoverCloseTimer)
          hoverCloseTimer = null
        }
        if (!commentHoverPreview || !id || !rect) {
          hoverCloseTimer = setTimeout(() => {
            hoverCloseTimer = null
            hoveredComment = null
          }, 120)
          return
        }
        hoveredComment = {
          id,
          left: Math.min(window.innerWidth - 336, Math.max(12, rect.left)),
          top: rect.top,
          bottom: rect.bottom,
        }
      },
    })
    editor.setRawMode(rawMode)
    editor.setSpellcheck(spellCheck)
    editor.setZenFocus(zenMode)
    setLuaNotifyHandler((message) => flash(message))
    setFigureOpenHandler((figures, index) => {
      figureItems = figures
      figureIndex = index
      figureOpen = true
    })

    const scroller = editor.view.scrollDOM
    let scrollFrame = 0
    const measureScroll = () => {
      scrollFrame = 0
      const max = scroller.scrollHeight - scroller.clientHeight
      scrollProgress = max > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / max)) : 0
    }
    const onScroll = () => {
      if (scrollFrame) return
      scrollFrame = requestAnimationFrame(measureScroll)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    measureScroll()

    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('keydown', paletteShortcut, true)
    const onResize = () => {
      if (searchOpen) updatePaletteAnchor()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('popstate', onPopState)
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        void checkExternalFileChange()
        if (treeComplete && !loading && !virtualDemoActive) {
          void refreshTree(false, true, treeVersion)
        }
      }
    }
    window.addEventListener('focus', onFocusOrVisible)
    document.addEventListener('visibilitychange', onFocusOrVisible)
    const filePollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') void checkExternalFileChange()
    }, 3000)
    void initialLoad()
    void loadMeta()

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('keydown', paletteShortcut, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
      clearInterval(filePollTimer)
      unwatchTheme()
      setLuaNotifyHandler(null)
      setFigureOpenHandler(null)
      scroller.removeEventListener('scroll', onScroll)
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      if (treePollTimer) clearTimeout(treePollTimer)
      if (toastTimer) clearTimeout(toastTimer)
      if (saveTimer) clearTimeout(saveTimer)
      if (recentSaveTimer) clearTimeout(recentSaveTimer)
      editor?.destroy()
      editor = null
    }
  })

  async function initialLoad() {
    await refreshTree()
    await Promise.all([loadFavorites(), loadSettings(), loadRecent(), loadAgents(false), loadMeta()])
    confirmAgentsInBackground()
    const storedScope = localStorage.getItem(SCOPE_KEY)
    if (storedScope && findFolder(tree, storedScope)) scopePath = storedScope
    const params = new URLSearchParams(window.location.search)
    const requested = params.get('file') ?? ''
    const initialHash = window.location.hash.replace(/^#/, '')
    if (requested.startsWith('_demo/')) {
      await openVirtualDemo(requested, initialHash)
      return
    }
    if (!serverDemoMode && !demoSeen && !requested) {
      demoSeen = true
      void persistSettings()
      await openVirtualDemo('_demo/welcome.md')
      return
    }
    const stored = localStorage.getItem(LAST_PATH_KEY)
    const exists = (path: string | null): path is string =>
      !!path && files.some((file) => file.path === path)
    const target =
      (exists(requested) && requested) ||
      (exists(stored) && stored) ||
      files.find((file) => !file.path.includes('/'))?.path ||
      files[0]?.path ||
      ''
    if (target) {
      await openFile(target, undefined, {
        history: 'replace',
        hash: target === requested ? initialHash : '',
      })
    }
  }

  let treeVersion = 0

  function compareTreeEntries(a: Entry, b: Entry): number {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  }

  function insertSortedEntry(list: Entry[], item: Entry) {
    let idx = list.findIndex((existing) => compareTreeEntries(item, existing) < 0)
    if (idx === -1) idx = list.length
    list.splice(idx, 0, item)
  }

  function removeTreeNode(entries: Entry[], targetPath: string): boolean {
    const slash = targetPath.lastIndexOf('/')
    if (slash === -1) {
      const idx = entries.findIndex((e) => !e.isDir && e.path === targetPath)
      if (idx === -1) return false
      entries.splice(idx, 1)
      return true
    }
    const parentPath = targetPath.slice(0, slash)
    const parts = parentPath.split('/')
    const chain: { list: Entry[]; idx: number }[] = []
    let list = entries
    let prefix = ''
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part
      const dirIdx = list.findIndex((e) => e.isDir && e.path === prefix)
      if (dirIdx === -1) return false
      chain.push({ list, idx: dirIdx })
      list = list[dirIdx].children ?? []
    }
    const fileIdx = list.findIndex((e) => !e.isDir && e.path === targetPath)
    if (fileIdx === -1) return false
    list.splice(fileIdx, 1)
    for (let i = chain.length - 1; i >= 0; i--) {
      const { list: parentList, idx } = chain[i]
      if ((parentList[idx].children?.length ?? 0) === 0) {
        parentList.splice(idx, 1)
      } else {
        break
      }
    }
    return true
  }

  function insertTreeNode(entries: Entry[], file: FlatFile) {
    const parts = file.path.split('/')
    let list = entries
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      prefix = prefix ? `${prefix}/${name}` : name
      let dir = list.find((e) => e.isDir && e.path === prefix)
      if (!dir) {
        dir = { name, path: prefix, isDir: true, modTime: 0, size: 0, children: [] }
        insertSortedEntry(list, dir)
      }
      const children = dir.children ?? (dir.children = [])
      list = children
    }
    const existing = list.find((e) => !e.isDir && e.path === file.path)
    if (existing) {
      existing.modTime = file.modTime
      existing.size = file.size
      return
    }
    insertSortedEntry(list, {
      name: file.name,
      path: file.path,
      isDir: false,
      modTime: file.modTime,
      size: file.size,
    })
  }

  function updateTreeNode(entries: Entry[], file: FlatFile) {
    const parts = file.path.split('/')
    let list = entries
    let prefix = ''
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      const dir = list.find((e) => e.isDir && e.path === prefix)
      if (!dir || !dir.children) {
        insertTreeNode(entries, file)
        return
      }
      list = dir.children
    }
    const existing = list.find((e) => !e.isDir && e.path === file.path)
    if (existing) {
      existing.modTime = file.modTime
      existing.size = file.size
    } else {
      insertTreeNode(entries, file)
    }
  }

  function applyTreeDelta(response: TreeResponse) {
    for (const removedPath of response.removed ?? []) {
      removeTreeNode(tree, removedPath)
      const idx = files.findIndex((f) => f.path === removedPath)
      if (idx !== -1) files.splice(idx, 1)
    }
    for (const updatedFile of response.updated ?? []) {
      updateTreeNode(tree, updatedFile)
      const existing = files.find((f) => f.path === updatedFile.path)
      if (existing) {
        existing.modTime = updatedFile.modTime
        existing.size = updatedFile.size
      } else {
        files.push(updatedFile)
      }
    }
    for (const addedFile of response.added ?? []) {
      insertTreeNode(tree, addedFile)
      if (!files.some((f) => f.path === addedFile.path)) {
        files.push(addedFile)
      }
    }
    if ((response.added?.length ?? 0) > 0) {
      files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()))
    }
  }

  async function refreshTree(refresh = false, quiet = false, since?: number) {
    const requestId = ++treeRequestId
    if (treePollTimer) {
      clearTimeout(treePollTimer)
      treePollTimer = null
    }
    if (!quiet) loading = true
    try {
      const response = await api.tree(undefined, refresh, since)
      if (requestId !== treeRequestId) return
      if (response.unchanged) {
        treeVersion = response.version ?? treeVersion
        treeComplete = response.done
        loading = false
        return
      }
      if (response.delta) {
        treeVersion = response.version ?? treeVersion
        applyTreeDelta(response)
        treeComplete = response.done
        loading = false
        if (scopePath && !findFolder(tree, scopePath)) {
          scopePath = null
          localStorage.removeItem(SCOPE_KEY)
        }
        return
      }
      treeVersion = response.version ?? 0
      tree = response.tree
      files = response.files
      root = response.root
      treeComplete = response.done
      loadError = response.error ?? ''
      loading = false
      if (scopePath && !findFolder(tree, scopePath)) {
        scopePath = null
        localStorage.removeItem(SCOPE_KEY)
      }
      if (!response.done) {
        treePollTimer = setTimeout(() => {
          treePollTimer = null
          void refreshTree(false, true)
        }, 250)
      }
    } catch (err) {
      if (requestId !== treeRequestId) return
      loadError = err instanceof Error ? err.message : String(err)
      flash(loadError, true)
      loading = false
      treeComplete = true
    }
  }

  $effect(() => {
    editor?.setActiveComment(activeCommentId)
  })

  $effect(() => {
    editor?.setPendingComment(
      commentDraft && rightPanel === 'comments'
        ? { from: commentDraft.from, to: commentDraft.to }
        : null,
    )
  })

  const expandedWatchDirs = new Set<string>()
  let watchSyncTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleWatchSync() {
    if (virtualDemoActive) return
    if (watchSyncTimer) clearTimeout(watchSyncTimer)
    watchSyncTimer = setTimeout(() => {
      watchSyncTimer = null
      if (virtualDemoActive) return
      const dirs = new Set<string>(expandedWatchDirs)
      const activeDir = dirOf(currentPath)
      if (activeDir) dirs.add(activeDir)
      if (scopePath) dirs.add(scopePath)
      void api.watchTreeDirs([...dirs]).catch(() => {})
    }, 250)
  }

  function handleFolderToggle(path: string, isOpen: boolean) {
    if (isOpen) expandedWatchDirs.add(path)
    else expandedWatchDirs.delete(path)
    scheduleWatchSync()
  }

  $effect(() => {
    void currentPath
    void scopePath
    void virtualDemoActive
    scheduleWatchSync()
  })

  $effect(() => {
    if (virtualDemoActive) return
    const timer = setInterval(() => {
      if (treeComplete && !loading && !document.hidden && !virtualDemoActive) {
        void refreshTree(false, true, treeVersion)
      }
    }, 5_000)
    return () => clearInterval(timer)
  })

  async function rescanFolder(path: string) {
    if (!path || rescanningFolder === path) return
    rescanningFolder = path
    try {
      const response = await api.rescanFolder(path)
      tree = response.tree
      files = response.files
      root = response.root
      treeComplete = response.done
      loadError = response.error ?? ''
      flash(`Rescanned ${path}`)
    } catch (err) {
      flash(`Could not rescan ${path}: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      if (rescanningFolder === path) rescanningFolder = ''
    }
  }

  async function scrollTreeToPath(targetPath: string) {
    await tick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const container = treeScrollEl
    if (!container) return
    const rows = container.querySelectorAll<HTMLElement>('.file-row[data-path]')
    for (const row of rows) {
      if (row.dataset.path === targetPath) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' })
        break
      }
    }
  }

  function applyFile(data: FileData, line?: number, headingSlug?: string) {
    if (currentPath !== data.path) {
      activeCommentId = null
    }
    commentDraft = null
    selectedRange = null
    talkPinnedSelection = ''
    const decoded = decodeForEditor(data.content)
    currentPath = data.path
    format = decoded.format
    hash = data.hash
    modTime = data.modTime
    content = decoded.text
    dirty = false
    saveError = ''
    saveState = 'saved'
    conflictData = null
    conflictOpen = false
    if (!data.path.startsWith('_demo/') && !files.some((f) => f.path === data.path)) {
      const added: FlatFile = {
        path: data.path,
        name: baseName(data.path),
        modTime: data.modTime,
        size: new TextEncoder().encode(data.content).length,
      }
      insertTreeNode(tree, added)
      files.push(added)
    }
    editor?.setDoc(data.path, decoded.text)
    htmlFrameNonce += 1
    setLuaDocument(data.path)
    editor?.setReadOnly(readOnly)
    cursor = { line: 1, column: 1, selectedChars: 0, from: 0, to: 0, anchor: null }
    if (!data.path.startsWith('_demo/')) rememberRecent(data.path)
    currentAssetsStamp = ''
    void refreshCurrentAssets(data.path)
    if (line) {
      setTimeout(() => editor?.scrollToLine(line), 0)
    } else if (headingSlug) {
      const heading = buildOutline(decoded.text).find((item) => item.slug === headingSlug)
      if (heading) {
        setTimeout(() => editor?.scrollToLine(heading.line), 0)
      }
    }
  }

  function buildAppUrl(path: string, slug: string): string {
    const url = new URL(window.location.href)
    if (path) url.searchParams.set('file', path)
    else url.searchParams.delete('file')
    url.hash = slug ? `#${slug}` : ''
    return url.toString()
  }

  function replaceUrl(path: string, slug: string) {
    const next = buildAppUrl(path, slug)
    if (next === window.location.href) return
    window.history.replaceState({ file: path, slug }, '', next)
  }

  function scrollToHeadingSlug(slug: string) {
    if (!slug) return
    const heading = buildOutline(content).find((item) => item.slug === slug)
    if (heading) editor?.scrollToLine(heading.line)
  }

  function onPopState() {
    const params = new URLSearchParams(window.location.search)
    const file = params.get('file') ?? ''
    const slug = window.location.hash.replace(/^#/, '')
    if (!file) return
    if (file === currentPath) {
      scrollToHeadingSlug(slug)
      return
    }
    void openFile(file, undefined, { history: 'none', hash: slug })
  }

  async function openFile(
    path: string,
    line?: number,
    options: { history?: 'push' | 'replace' | 'none'; hash?: string } = {},
  ) {
    if (!path) return
    if (!path.startsWith('_demo/') && virtualDemoActive) {
      virtualDemoActive = false
      if (readOnly !== readOnlyBeforeDemo) {
        readOnly = readOnlyBeforeDemo
        editor?.setReadOnly(readOnly)
      }
    }
    if (path === currentPath) {
      if (line) editor?.scrollToLine(line)
      else if (options.hash) scrollToHeadingSlug(options.hash)
      return
    }
    if (dirty) {
      const ok = await saveNow()
      if (!ok) {
        flash('Resolve the conflict before switching notes.', true)
        return
      }
    }
    loadingFile = true
    try {
      const data = await api.file(path)
      applyFile(data, line, options.hash)
      if (!path.startsWith('_demo/')) localStorage.setItem(LAST_PATH_KEY, path)
      const mode = options.history ?? 'push'
      if (mode !== 'none') {
        const next = buildAppUrl(path, options.hash ?? '')
        if (next !== window.location.href) {
          const method = mode === 'push' ? 'pushState' : 'replaceState'
          window.history[method]({ file: path, slug: options.hash ?? '' }, '', next)
        }
      }
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true)
    } finally {
      loadingFile = false
    }
  }

  let fileCheckInFlight = false
  let talkEditStreaming = false
  let currentAssetsStamp = ''
  let reloadingFile = $state(false)

  async function checkExternalFileChange() {
    const path = currentPath
    if (!path || fileCheckInFlight || talkEditStreaming || loadingFile || reloadingFile || saveState === 'saving' || conflictOpen) return
    fileCheckInFlight = true
    try {
      const remote = await api.file(path)
      if (currentPath !== path || talkEditStreaming) return
      if (remote.hash !== hash) {
        const decoded = decodeForEditor(remote.content)
        if (!dirty) {
          format = decoded.format
          content = decoded.text
          hash = remote.hash
          modTime = remote.modTime
          dirty = false
          saveState = 'saved'
          saveError = ''
          editor?.reloadDoc(remote.path, decoded.text)
          htmlFrameNonce += 1
          void refreshCurrentAssets(remote.path)
          flash(`Reloaded ${baseName(remote.path)} (changed on disk)`)
          return
        }
        if (decoded.text === content) {
          if (saveTimer) {
            clearTimeout(saveTimer)
            saveTimer = null
          }
          format = decoded.format
          hash = remote.hash
          modTime = remote.modTime
          dirty = false
          saveState = 'saved'
          saveError = ''
          void refreshCurrentAssets(remote.path)
          return
        }
        conflictData = remote
        saveState = 'conflict'
        conflictOpen = true
        return
      }
      if (!isHtmlPath(path)) {
        const assetRes = await api.fileAssets(path)
        if (currentPath !== path) return
        currentHasAssets = assetRes.hasAssets
        const nextStamp = assetRes.stamp ?? ''
        if (nextStamp && currentAssetsStamp && nextStamp !== currentAssetsStamp) {
          currentAssetsStamp = nextStamp
          editor?.rerender()
          flash(`Reloaded assets for ${baseName(path)}`)
        } else if (!currentAssetsStamp && nextStamp) {
          currentAssetsStamp = nextStamp
        }
      }
    } catch {
      /* ignore transient poll errors */
    } finally {
      fileCheckInFlight = false
      if (splitPath) void refreshSplitIfChanged()
    }
  }

  async function reloadCurrentFile() {
    const path = currentPath
    if (!path || reloadingFile || loadingFile) return
    reloadingFile = true
    try {
      const remote = await api.file(path)
      if (currentPath !== path) return
      if (dirty && remote.hash !== hash) {
        conflictData = remote
        saveState = 'conflict'
        conflictOpen = true
        return
      }
      if (!dirty) {
        const decoded = decodeForEditor(remote.content)
        format = decoded.format
        content = decoded.text
        hash = remote.hash
        modTime = remote.modTime
        dirty = false
        saveState = 'saved'
        saveError = ''
        editor?.reloadDoc(remote.path, decoded.text)
      } else {
        editor?.rerender()
      }
      htmlFrameNonce += 1
      await refreshCurrentAssets(path)
      flash(`Reloaded ${baseName(path)}`)
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true)
    } finally {
      reloadingFile = false
    }
  }

  async function openInSplit(path: string) {
    if (!path) return
    splitLoading = true
    try {
      const data = await api.file(path)
      const decoded = decodeForEditor(data.content)
      splitPath = data.path
      splitContent = decoded.text
      splitHash = data.hash
      splitHtmlNonce += 1
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true)
    } finally {
      splitLoading = false
    }
  }

  function closeSplit() {
    splitPath = ''
    splitContent = ''
    splitHash = ''
  }

  async function swapSplit() {
    if (!splitPath) return
    const nextMain = splitPath
    const nextSplit = currentPath
    await openFile(nextMain)
    if (nextSplit) {
      await openInSplit(nextSplit)
    } else {
      closeSplit()
    }
  }

  async function refreshSplitIfChanged() {
    const target = splitPath
    if (!target || splitLoading) return
    try {
      const remote = await api.file(target)
      if (splitPath !== target || remote.hash === splitHash) return
      const decoded = decodeForEditor(remote.content)
      splitContent = decoded.text
      splitHash = remote.hash
      splitHtmlNonce += 1
    } catch {
      /* ignore transient poll errors */
    }
  }

  function handleEditorChange(next: string) {
    content = next
    dirty = true
    if (saveState !== 'conflict') {
      saveState = 'unsaved'
      saveError = ''
    }
    scheduleSave()
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer)
    if (saveState === 'conflict' || readOnly || !autoSave) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void saveNow()
    }, 1500)
  }

  async function saveNow(allowInReadOnly = false): Promise<boolean> {
    if (!currentPath || (readOnly && !allowInReadOnly)) return false
    if (saveState === 'conflict') {
      conflictOpen = true
      return false
    }
    if (!dirty) {
      saveState = 'saved'
      return true
    }
    if (saving) {
      saveQueued = true
      return false
    }
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }

    saving = true
    saveState = 'saving'
    const snapshot = content
    try {
      const saved = await api.save(currentPath, encodeForSave(snapshot, format), hash)
      hash = saved.hash
      modTime = saved.modTime
      if (content === snapshot) {
        dirty = false
        saveState = 'saved'
      } else {
        saveState = 'unsaved'
        scheduleSave()
      }
      void refreshCurrentAssets(currentPath)
      return true
    } catch (err) {
      if (err instanceof ConflictError) {
        const remoteDecoded = decodeForEditor(err.current.content)
        if (remoteDecoded.text === content) {
          format = remoteDecoded.format
          hash = err.current.hash
          modTime = err.current.modTime
          dirty = false
          saveState = 'saved'
          saveError = ''
          void refreshCurrentAssets(currentPath)
          return true
        }
        conflictData = err.current
        conflictOpen = true
        saveState = 'conflict'
        return false
      }
      saveState = 'error'
      saveError = err instanceof Error ? err.message : String(err)
      flash(saveError, true)
      return false
    } finally {
      saving = false
      if (saveQueued) {
        saveQueued = false
        scheduleSave()
      }
    }
  }

  async function keepMine() {
    if (!conflictData || !currentPath) return
    saving = true
    saveState = 'saving'
    try {
      const saved = await api.save(currentPath, encodeForSave(content, format), conflictData.hash)
      hash = saved.hash
      modTime = saved.modTime
      dirty = false
      saveState = 'saved'
      conflictData = null
      conflictOpen = false
      flash('Saved your version.')
    } catch (err) {
      if (err instanceof ConflictError) {
        conflictData = err.current
        saveState = 'conflict'
        flash('The file changed again on disk. Review the new version.', true)
      } else {
        saveState = 'error'
        saveError = err instanceof Error ? err.message : String(err)
        flash(saveError, true)
      }
    } finally {
      saving = false
    }
  }

  function takeTheirs() {
    if (!conflictData) return
    const data: FileData = { ...conflictData, path: currentPath }
    applyFile(data)
    flash('Reloaded from disk.')
  }

  async function toggleReadOnly() {
    if (!readOnly && dirty) {
      const ok = await saveNow()
      if (!ok) {
        flash('Save your changes before locking the note.', true)
        return
      }
    }
    readOnly = !readOnly
    editor?.setReadOnly(readOnly)
    if (!readOnly) editor?.focus()
  }

  function toggleSidebar() {
    sidebarOpen = !sidebarOpen
    localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0')
  }

  function setSidebarTab(tab: 'files' | 'outline') {
    sidebarTab = tab
    localStorage.setItem(SIDEBAR_TAB_KEY, tab)
  }

  function clampSidebarWidth(width: number): number {
    const max = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN + 80, window.innerWidth * 0.55))
    return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)))
  }

  function setSidebarWidth(width: number, persist = true) {
    sidebarWidth = clampSidebarWidth(width)
    if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
  }

  function startSidebarResize(event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
    const startX = event.clientX
    const startWidth = sidebarWidth
    document.body.classList.add('resizing-sidebar')

    const onMove = (moveEvent: PointerEvent) => {
      sidebarWidth = clampSidebarWidth(startWidth + moveEvent.clientX - startX)
    }
    const onUp = () => {
      document.body.classList.remove('resizing-sidebar')
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function handleResizerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16))
  }

  function clampTalkWidth(width: number): number {
    const max = Math.min(TALK_MAX, Math.max(TALK_MIN + 80, window.innerWidth * 0.6))
    return Math.round(Math.min(max, Math.max(TALK_MIN, width)))
  }

  function setTalkWidth(width: number, persist = true) {
    talkWidth = clampTalkWidth(width)
    if (persist) localStorage.setItem(TALK_WIDTH_KEY, String(talkWidth))
  }

  function startTalkResize(event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
    const startX = event.clientX
    const startWidth = talkWidth
    document.body.classList.add('resizing-talk')

    const onMove = (moveEvent: PointerEvent) => {
      talkWidth = clampTalkWidth(startWidth + (startX - moveEvent.clientX))
    }
    const onUp = () => {
      document.body.classList.remove('resizing-talk')
      localStorage.setItem(TALK_WIDTH_KEY, String(talkWidth))
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function handleTalkResizerKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setTalkWidth(talkWidth + (event.key === 'ArrowLeft' ? 16 : -16))
  }

  function toggleWideMode() {
    wideMode = !wideMode
    localStorage.setItem(WIDE_MODE_KEY, wideMode ? '1' : '0')
    void persistSettings()
  }

  function cycleTheme() {
    themeMode = nextThemeMode(themeMode)
    storeThemeMode(themeMode)
    applyTheme(themeMode, lightTheme, darkTheme)
    void persistSettings()
  }

  async function persistSettings() {
    try {
      await api.saveSettings({
        theme: themeMode,
        lightTheme,
        darkTheme,
        wideMode,
        markdownStyle,
        autoSave,
        ctrlClickLink,
        spellCheck,
        fileTypes,
        backgroundScan,
        commentHoverPreview,
        commentAuthor: commentAuthorSetting,
        demoSeen,
        agentModels: agentPins,
        disabledAgents,
      })
    } catch (err) {
      flash(`Could not save settings: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  function updateSetting(patch: Partial<AppSettings>) {
    if (patch.theme) {
      themeMode = patch.theme
      storeThemeMode(themeMode)
      applyTheme(themeMode, lightTheme, darkTheme)
    }
    if (patch.lightTheme) {
      lightTheme = patch.lightTheme
      storePalettes(lightTheme, darkTheme)
      applyTheme(themeMode, lightTheme, darkTheme)
    }
    if (patch.darkTheme) {
      darkTheme = patch.darkTheme
      storePalettes(lightTheme, darkTheme)
      applyTheme(themeMode, lightTheme, darkTheme)
    }
    if (patch.wideMode !== undefined) {
      wideMode = patch.wideMode
      localStorage.setItem(WIDE_MODE_KEY, wideMode ? '1' : '0')
    }
    if (patch.markdownStyle) markdownStyle = patch.markdownStyle
    if (patch.ctrlClickLink) {
      ctrlClickLink = patch.ctrlClickLink
      setLinkClickBehavior(ctrlClickLink)
    }
    if (patch.autoSave !== undefined) {
      autoSave = patch.autoSave
      if (!autoSave && saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      } else if (autoSave && dirty) {
        scheduleSave()
      }
    }
    if (patch.spellCheck !== undefined) {
      spellCheck = patch.spellCheck
      editor?.setSpellcheck(spellCheck)
    }
    if (patch.fileTypes !== undefined) {
      fileTypes = patch.fileTypes
    }
    if (patch.backgroundScan !== undefined) {
      backgroundScan = patch.backgroundScan
    }
    if (patch.commentHoverPreview !== undefined) {
      commentHoverPreview = patch.commentHoverPreview
      if (!commentHoverPreview) hoveredComment = null
    }
    if (patch.commentAuthor !== undefined) {
      const clean = patch.commentAuthor.trim().replace(/^@+/, '')
      commentAuthorSetting = clean
      if (clean) {
        commentAuthor = clean
        localStorage.setItem(COMMENT_AUTHOR_KEY, clean)
      }
    }
    if (patch.demoSeen !== undefined) {
      demoSeen = patch.demoSeen
    }
    if (patch.disabledAgents !== undefined) {
      const prevDisabled = new Set(disabledAgents)
      disabledAgents = patch.disabledAgents
      const nextDisabled = new Set(disabledAgents)
      for (const agent of allAgents) {
        if (agent.available && prevDisabled.has(agent.id) && !nextDisabled.has(agent.id)) {
          void runAgentTest(agent.id)
        }
      }
    }
    if (patch.agentModels !== undefined) {
      const prevPins = agentPins
      agentPins = patch.agentModels
      for (const agent of allAgents) {
        if (
          agent.available &&
          isAgentEnabled(agent.id) &&
          (prevPins[agent.id] ?? '') !== (agentPins[agent.id] ?? '')
        ) {
          void runAgentTest(agent.id, agentPins[agent.id] ?? '')
        }
      }
    }
    if (patch.fileTypes !== undefined) {
      void persistSettings().then(() => refreshTree(true))
    } else {
      void persistSettings()
    }
  }

  function toggleRawMode() {
    rawMode = !rawMode
    localStorage.setItem(RAW_MODE_KEY, rawMode ? '1' : '0')
    editor?.setRawMode(rawMode)
    if (!rawMode && isCurrentHtml) {
      if (dirty) {
        void saveNow().then(() => {
          htmlFrameNonce += 1
        })
      } else {
        htmlFrameNonce += 1
      }
    }
  }

  function toggleZenMode() {
    zenMode = !zenMode
    localStorage.setItem(ZEN_KEY, zenMode ? '1' : '0')
    editor?.setZenFocus(zenMode)
    if (zenMode) {
      commentDraft = null
      rightPanel = null
      scrollProgress = 0
    }
    requestAnimationFrame(() => editor?.focus())
  }

  function cycleMarkdownStyle() {
    const order: AppSettings['markdownStyle'][] = ['default', 'github', 'academic', 'compact']
    const index = order.indexOf(markdownStyle)
    updateSetting({ markdownStyle: order[(index + 1) % order.length] })
  }

  async function loadSettings() {
    try {
      const response = await api.settings()
      if (response.exists) {
        themeMode = response.settings.theme
        lightTheme = isLightPalette(response.settings.lightTheme) ? response.settings.lightTheme : lightTheme
        darkTheme = isDarkPalette(response.settings.darkTheme) ? response.settings.darkTheme : darkTheme
        wideMode = response.settings.wideMode
        markdownStyle = response.settings.markdownStyle
        autoSave = response.settings.autoSave
        ctrlClickLink = response.settings.ctrlClickLink
        spellCheck = response.settings.spellCheck
        fileTypes = response.settings.fileTypes ?? ['markdown', 'html']
        backgroundScan = response.settings.backgroundScan ?? false
        commentHoverPreview = response.settings.commentHoverPreview ?? true
        commentAuthorSetting = response.settings.commentAuthor ?? ''
        demoSeen = response.settings.demoSeen ?? false
        if (commentAuthorSetting) commentAuthor = commentAuthorSetting
        agentPins = response.settings.agentModels ?? {}
        disabledAgents = response.settings.disabledAgents ?? []
        applyTheme(themeMode, lightTheme, darkTheme)
        storeThemeMode(themeMode)
        storePalettes(lightTheme, darkTheme)
        localStorage.setItem(WIDE_MODE_KEY, wideMode ? '1' : '0')
        setLinkClickBehavior(ctrlClickLink)
        editor?.setSpellcheck(spellCheck)
      } else {
        // First run on this EC2 host: migrate local browser preferences.
        await api.saveSettings({
          theme: themeMode,
          lightTheme,
          darkTheme,
          wideMode,
          markdownStyle,
          autoSave,
          ctrlClickLink,
          spellCheck,
          fileTypes,
          backgroundScan,
          commentHoverPreview,
          commentAuthor: commentAuthorSetting,
          demoSeen,
          agentModels: agentPins,
          disabledAgents,
        })
      }
    } catch (err) {
      flash(`Could not load settings: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  async function loadReleaseInfo(refresh: boolean) {
    if (refresh) checkingRelease = true
    try {
      const info = await api.release(refresh)
      releaseInfo = info
      if (info.current) appVersion = info.current
      if (info.repo) repoUrl = info.repo
      if (refresh) {
        flash(
          info.updateAvailable
            ? `Burley ${info.latest} is available`
            : info.error
              ? 'Could not check for updates right now'
              : 'Burley is up to date',
          !!info.error,
        )
      }
    } catch (err) {
      if (refresh) {
        flash(`Could not check for updates: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    } finally {
      if (refresh) checkingRelease = false
    }
  }

  async function loadMeta() {
    try {
      const meta = await api.health()
      if (meta.version) appVersion = meta.version
      if (meta.repo) repoUrl = meta.repo
      if (meta.user && !commentAuthor) commentAuthor = meta.user
      if (meta.demoMode !== undefined) serverDemoMode = meta.demoMode
    } catch {
      /* health is best-effort */
    }
    void loadReleaseInfo(false)
  }

  async function openVirtualDemo(targetPath = '_demo/welcome.md', hash = '') {
    try {
      const res = await api.demoTree()
      demoTree = res.tree
      demoFiles = res.files
      if (!virtualDemoActive) {
        savedRealPath = currentPath.startsWith('_demo/') ? savedRealPath : currentPath
        readOnlyBeforeDemo = readOnly
        if (!readOnly) {
          readOnly = true
          editor?.setReadOnly(true)
        }
      }
      virtualDemoActive = true
      sidebarOpen = true
      sidebarTab = 'files'
      await openFile(targetPath, undefined, { history: 'replace', hash })
    } catch (err) {
      flash(`Could not open demo: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  async function exitVirtualDemo() {
    virtualDemoActive = false
    if (readOnly !== readOnlyBeforeDemo) {
      readOnly = readOnlyBeforeDemo
      editor?.setReadOnly(readOnly)
    }
    const target =
      (savedRealPath && files.some((f) => f.path === savedRealPath) && savedRealPath) ||
      files.find((f) => !f.path.includes('/'))?.path ||
      files[0]?.path ||
      ''
    if (target) {
      await openFile(target, undefined, { history: 'replace' })
    } else {
      currentPath = ''
      content = ''
      dirty = false
      editor?.setDoc('', '')
      replaceUrl('', '')
    }
  }

  async function loadFavorites() {
    try {
      const response = await api.favorites()
      favorites = response.favorites
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true)
    }
  }

  async function uploadImages(files: File[], pos: number) {
    if (!currentPath) {
      flash('Open a note before pasting or dropping an image.', true)
      return
    }
    let insertPos = pos
    let uploaded = 0
    for (const file of files) {
      try {
        const asset = await api.uploadAsset(currentPath, file)
        const alt = file.name.replace(/\.[^.]+$/, '').trim() || 'image'
        insertPos = editor?.insertTextAt(`![${alt}](${asset.ref})`, insertPos) ?? insertPos
        uploaded++
      } catch (err) {
        flash(`Image upload failed: ${err instanceof Error ? err.message : String(err)}`, true)
      }
    }
    if (uploaded > 0) {
      flash(`Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'}`)
      void refreshCurrentAssets(currentPath)
    }
  }

  async function refreshCurrentAssets(path: string) {
    currentHasAssets = false
    if (!path || isHtmlPath(path)) {
      currentAssetsStamp = ''
      return
    }
    try {
      const res = await api.fileAssets(path)
      if (currentPath === path) {
        currentHasAssets = res.hasAssets
        currentAssetsStamp = res.stamp ?? ''
      }
    } catch {
      /* ignore */
    }
  }

  function confirmAgentsInBackground() {
    for (const agent of allAgents) {
      if (agent.available && isAgentEnabled(agent.id)) {
        void runAgentTest(agent.id)
      }
    }
  }

  async function loadAgents(confirm = true) {
    try {
      const response = await api.agents()
      allAgents = response.agents
      agentPathEnv = response.pathEnv ?? ''
      if (confirm) confirmAgentsInBackground()
    } catch (err) {
      flash(`Could not detect CLI agents: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  async function runAgentTest(id: string, modelOverride?: string) {
    const model = modelOverride !== undefined ? modelOverride : (agentPins[id] ?? '')
    if (agentTesting[id] && agentTestInFlightModel[id] === model) return
    const seq = (agentTestSeq[id] ?? 0) + 1
    agentTestSeq[id] = seq
    agentTestInFlightModel[id] = model
    agentTesting = { ...agentTesting, [id]: true }
    try {
      const res = await api.testAgent(id, model)
      if (agentTestSeq[id] !== seq) return
      agentTests = { ...agentTests, [id]: res }
      if (res.pathEnv) agentPathEnv = res.pathEnv
    } catch (err) {
      if (agentTestSeq[id] !== seq) return
      agentTests = {
        ...agentTests,
        [id]: {
          agent: id,
          available: false,
          confirmed: false,
          exitCode: -1,
          error: err instanceof Error ? err.message : String(err),
        },
      }
    } finally {
      if (agentTestSeq[id] === seq) {
        delete agentTestInFlightModel[id]
        agentTesting = { ...agentTesting, [id]: false }
      }
    }
  }

  function toggleTalk() {
    commentDraft = null
    rightPanel = rightPanel === 'talk' ? null : 'talk'
  }

  function prepareCommentDraftFromSelection(openedPanel = false, autoFocus = false) {
    if (!currentPath || isCurrentHtml || !editor) return null
    const sel = editor.view.state.selection.main
    const from = Math.min(sel.from, sel.to)
    const to = Math.max(sel.from, sel.to)
    if (from >= to) return null
    const snippet = editor.view.state.doc.sliceString(from, to)
    if (!snippet.trim()) return null
    const line = editor.view.state.doc.lineAt(from).number
    return { from, to, snippet, line, openedPanel, autoFocus }
  }

  function toggleComments() {
    if (!currentPath || isCurrentHtml) return
    if (rightPanel === 'comments') {
      commentDraft = null
      rightPanel = null
    } else {
      rightPanel = 'comments'
      if (!commentDraft) {
        commentDraft = prepareCommentDraftFromSelection(false, true)
      }
    }
  }

  function closeCommentsPanel() {
    commentDraft = null
    if (rightPanel === 'comments') rightPanel = null
  }

  function applyCommentMutation(nextDoc: string, nextActiveId?: string | null) {
    if (!editor || nextDoc === content) return
    editor.applyDocMutation(nextDoc)
    if (nextActiveId !== undefined) activeCommentId = nextActiveId
    void saveNow(true)
  }

  function openCommentDraft() {
    if (!currentPath || isCurrentHtml || !editor) return
    const sel = editor.view.state.selection.main
    const from = Math.min(sel.from, sel.to)
    const to = Math.max(sel.from, sel.to)
    const line = editor.view.state.doc.lineAt(from).number
    const snippet = from < to ? editor.view.state.doc.sliceString(from, to) : ''
    const openedPanel = commentDraft ? commentDraft.openedPanel : rightPanel !== 'comments'
    rightPanel = 'comments'
    commentDraft = { from, to, snippet, line, openedPanel, autoFocus: true }
  }

  function cancelCommentDraft() {
    const shouldClose = !!commentDraft?.openedPanel
    commentDraft = null
    if (shouldClose && rightPanel === 'comments') {
      rightPanel = null
    }
    requestAnimationFrame(() => editor?.focus())
  }

  function submitNewComment(payload: { kind: CommentKind; author: string; body: string }) {
    if (!commentDraft) return
    const trimmedAuthor = payload.author.trim()
    if (trimmedAuthor && trimmedAuthor !== 'anonymous') {
      commentAuthor = trimmedAuthor
      localStorage.setItem(COMMENT_AUTHOR_KEY, trimmedAuthor)
    }
    const { from, to } = commentDraft
    const res = addCommentToDoc(content, {
      kind: payload.kind,
      from,
      to,
      author: trimmedAuthor || commentAuthor || 'anonymous',
      body: payload.body,
    })
    commentDraft = null
    rightPanel = 'comments'
    applyCommentMutation(res.doc, res.id)
  }

  function handleAddReply(id: string, author: string, body: string) {
    const trimmedAuthor = author.trim()
    if (trimmedAuthor && trimmedAuthor !== 'anonymous') {
      commentAuthor = trimmedAuthor
      localStorage.setItem(COMMENT_AUTHOR_KEY, trimmedAuthor)
    }
    const res = addReplyToDoc(content, id, { author: trimmedAuthor || commentAuthor || 'anonymous', body })
    applyCommentMutation(res.doc, res.id)
  }

  function handleEditComment(id: string, messageIndex: number, body: string) {
    const res = editCommentMessageInDoc(content, id, messageIndex, body)
    applyCommentMutation(res.doc, res.id)
  }

  function handleDeleteReply(id: string, messageIndex: number) {
    const res = deleteReplyFromDoc(content, id, messageIndex)
    applyCommentMutation(res.doc, res.id)
  }

  function handleDeleteComment(id: string) {
    const nextDoc = deleteCommentFromDoc(content, id)
    applyCommentMutation(nextDoc, activeCommentId === id ? null : activeCommentId)
  }

  function handleSelectCommentFromPanel(comment: DocComment) {
    activeCommentId = comment.id
    if (comment.anchor && editor) {
      const pos = comment.anchor.isRange ? comment.anchor.textFrom : comment.anchor.openFrom
      editor.scrollToPos(pos)
    }
  }

  async function runExport(kind: 'html' | 'pdf') {
    if (!currentPath || exporting) return
    exportMenuOpen = false
    exporting = true
    try {
      const html = await buildExportHtml({
        markdown: content,
        path: currentPath,
        markdownStyle,
      })
      if (kind === 'html') {
        downloadHtml(html, exportFileName(currentPath))
        flash('HTML export downloaded')
      } else {
        printPdf(html)
        flash('Opening the print dialog — choose “Save as PDF”')
      }
    } catch (err) {
      flash(`Export failed: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      exporting = false
    }
  }

  function newTalkChat() {
    talkAbort?.abort()
    talkAbort = null
    talkStreaming = false
    talkEditStreaming = false
    talkMessages = []
    talkError = ''
    talkPinnedSelection = ''
  }

  function insertTalkBlock(block: FencedBlock) {
    editor?.insertText(block.code)
  }

  function talkKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void sendTalk()
    }
  }

  async function streamTalk(options: {
    prompt: string
    display: string
    selection: string
    action?: SparkleAction
    mode?: 'ask' | 'edit'
    range?: { from: number; to: number }
  }): Promise<void> {
    if (!talkAgent || talkStreaming) return
    const runMode = options.mode ?? talkMode
    const targetPath = currentPath
    if (runMode === 'edit' && dirty && targetPath && !readOnly) {
      const saved = await saveNow()
      if (!saved) return
    }

    const history = talkMessages
      .filter((message) => message.content.trim())
      .slice(-8)
      .map((message) => ({ role: message.role, content: message.content }))

    const user: TalkMessage = { role: 'user', content: options.display }
    if (options.selection) user.selection = options.selection
    const assistant: TalkMessage = { role: 'assistant', content: '' }
    if (options.action) assistant.action = options.action
    if (options.selection) assistant.selection = options.selection
    if (options.range) {
      assistant.from = options.range.from
      assistant.to = options.range.to
      assistant.path = targetPath
    }
    talkMessages = [...talkMessages, user, assistant]
    const assistantIndex = talkMessages.length - 1

    talkStreaming = true
    talkEditStreaming = runMode === 'edit'
    talkError = ''
    talkAbort = new AbortController()
    try {
      await streamAgentChat(
        {
          agent: talkAgent,
          prompt: options.prompt,
          path: targetPath,
          mode: runMode,
          selection: options.selection,
          history,
        },
        (event, data) => {
          if (event === 'meta') {
            const messages = [...talkMessages]
            messages[assistantIndex] = {
              ...messages[assistantIndex],
              debug: {
                ...messages[assistantIndex].debug,
                command: typeof data.executable === 'string' ? data.executable : undefined,
                args: Array.isArray(data.args) ? data.args : undefined,
              },
            }
            talkMessages = messages
          } else if (event === 'delta' && typeof data.text === 'string') {
            const messages = [...talkMessages]
            messages[assistantIndex] = {
              ...messages[assistantIndex],
              content: messages[assistantIndex].content + data.text,
            }
            talkMessages = messages
          } else if (event === 'debug') {
            const messages = [...talkMessages]
            messages[assistantIndex] = {
              ...messages[assistantIndex],
              debug: {
                ...messages[assistantIndex].debug,
                command: typeof data.command === 'string' ? data.command : messages[assistantIndex].debug?.command,
                args: Array.isArray(data.args) ? data.args : messages[assistantIndex].debug?.args,
                exitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
                durationMs: typeof data.durationMs === 'number' ? data.durationMs : undefined,
                stderr: typeof data.stderr === 'string' ? data.stderr : undefined,
              },
            }
            talkMessages = messages
          } else if (event === 'done' && data.file && typeof data.file.content === 'string') {
            const filePath = typeof data.file.path === 'string' && data.file.path ? data.file.path : targetPath
            if (!filePath || filePath !== currentPath) return
            const decoded = decodeForEditor(data.file.content)
            // Apply via dispatch on the existing state so Ctrl+Z can undo the agent edit,
            // then clear the dirty state/autosave timer triggered by updateListener.
            editor?.applyDocMutation(decoded.text)
            if (saveTimer) {
              clearTimeout(saveTimer)
              saveTimer = null
            }
            format = decoded.format
            content = decoded.text
            if (typeof data.file.hash === 'string') hash = data.file.hash
            if (typeof data.file.modTime === 'number') modTime = data.file.modTime
            dirty = false
            saveState = 'saved'
            saveError = ''
            conflictData = null
            conflictOpen = false
            htmlFrameNonce += 1
            void refreshCurrentAssets(filePath)
            flash('Agent updated the note (Ctrl+Z to undo)')
          } else if (event === 'error') {
            const msg = data.message ?? 'Agent failed'
            talkError = msg
            const messages = [...talkMessages]
            messages[assistantIndex] = {
              ...messages[assistantIndex],
              debug: { ...messages[assistantIndex].debug, error: msg },
            }
            talkMessages = messages
          }
        },
        talkAbort.signal,
      )
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        talkError = err instanceof Error ? err.message : String(err)
      }
    } finally {
      talkStreaming = false
      talkEditStreaming = false
      talkAbort = null
    }
  }

  async function sendTalk() {
    const prompt = talkInput.trim()
    if (!prompt || talkStreaming || !talkAgent) return
    talkInput = ''
    const selection = selectedRange?.text || talkPinnedSelection
    if (selectedRange?.text) talkPinnedSelection = selectedRange.text
    await streamTalk({ prompt, display: prompt, selection })
  }

  $effect(() => {
    talkMessages
    talkStreaming
    const element = talkMessagesEl
    if (element) element.scrollTop = element.scrollHeight
  })

  // ------------------------------------------------------- selection actions in Talk

  function runTalkSelectionAction(action: Exclude<SparkleAction, 'ask'>) {
    const sel = activeTalkSelection
    if (!sel || !talkAgent) return
    if (talkStreaming) {
      flash('Talk is still answering — try again in a moment.', true)
      return
    }
    const prompt = SPARKLE_PROMPTS[action]
    const display = `${SPARKLE_LABELS[action]} the selection`
    rightPanel = 'talk'
    talkMode = 'ask'
    talkPinnedSelection = sel.text
    void streamTalk({
      prompt,
      display,
      selection: sel.text,
      action,
      mode: 'ask',
      range: sel.from !== undefined && sel.to !== undefined ? { from: sel.from, to: sel.to } : undefined,
    })
  }

  function openSelectionInTalk() {
    if (!selectedRange) return
    rightPanel = 'talk'
    talkMode = 'ask'
    talkPinnedSelection = selectedRange.text
  }

  function clearTalkSelection() {
    talkPinnedSelection = ''
    selectedRange = null
  }

  function talkRangeValid(message: TalkMessage): boolean {
    if (message.from === undefined || message.to === undefined || !message.selection) return false
    if (message.path !== currentPath) return false
    return (editor?.getContent() ?? '').slice(message.from, message.to) === message.selection
  }

  function markTalkMessage(index: number, patch: Partial<TalkMessage>) {
    const messages = [...talkMessages]
    messages[index] = { ...messages[index], ...patch }
    talkMessages = messages
  }

  function replaceTalkSuggestion(index: number) {
    const message = talkMessages[index]
    if (!message || readOnly || !message.content.trim() || !talkRangeValid(message)) return
    const from = message.from
    const to = message.to
    const text = cleanSuggestion(message.content)
    if (from === undefined || to === undefined || !text) return
    editor?.replaceRange(from, to, text)
    markTalkMessage(index, { applied: true })
    flash('Selection replaced')
  }

  function insertTalkSuggestion(index: number) {
    const message = talkMessages[index]
    if (!message || readOnly || !message.content.trim() || !talkRangeValid(message)) return
    const to = message.to
    const text = cleanSuggestion(message.content)
    if (to === undefined || !text) return
    editor?.insertTextAt(`\n\n${text}`, to)
    markTalkMessage(index, { applied: true })
    flash('Inserted below the selection')
  }

  function copyTalkSuggestion(index: number) {
    const message = talkMessages[index]
    if (!message?.content.trim()) return
    void navigator.clipboard
      .writeText(cleanSuggestion(message.content))
      .then(() => flash('Copied the suggestion'))
      .catch(() => flash('Could not copy to the clipboard', true))
  }

  /** One-line excerpt for the selection quote in Talk. */
  function excerpt(text: string, max = 180): string {
    const compact = text.replace(/\s+/g, ' ').trim()
    return compact.length > max ? `${compact.slice(0, max)}…` : compact
  }

  function selectionWords(text: string): number {
    return text.trim() ? text.trim().split(/\s+/).length : 0
  }

  async function loadRecent() {
    try {
      const response = await api.recent()
      recent = response.recent.slice(0, 10)
    } catch (err) {
      flash(`Could not load recent files: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  function rememberRecent(path: string) {
    if (!path) return
    recent = [path, ...recent.filter((entry) => entry !== path)].slice(0, 10)
    if (recentSaveTimer) clearTimeout(recentSaveTimer)
    recentSaveTimer = setTimeout(() => {
      recentSaveTimer = null
      void api.saveRecent(recent).catch((err) => {
        flash(`Could not save recent files: ${err instanceof Error ? err.message : String(err)}`, true)
      })
    }, 250)
  }
  async function persistFavorites(next: string[]) {
    const previous = favorites
    favorites = next
    try {
      const response = await api.saveFavorites(next)
      favorites = response.favorites
    } catch (err) {
      favorites = previous
      flash(err instanceof Error ? err.message : String(err), true)
    }
  }

  function toggleFavorite(path: string) {
    if (!path) return
    const next = favorites.includes(path)
      ? favorites.filter((favorite) => favorite !== path)
      : [...favorites, path]
    void persistFavorites(next)
  }

  function toggleFavoritesOpen() {
    favoritesOpen = !favoritesOpen
    localStorage.setItem(FAVORITES_OPEN_KEY, favoritesOpen ? '1' : '0')
  }

  function favoriteDragStart(event: DragEvent, path: string) {
    dragFavoritePath = path
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', path)
    }
  }

  function favoriteDrop(event: DragEvent, targetPath: string) {
    event.preventDefault()
    const fromPath = dragFavoritePath
    dragFavoritePath = null
    if (!fromPath || fromPath === targetPath) return
    const next = favorites.filter((path) => path !== fromPath)
    const targetIndex = next.indexOf(targetPath)
    next.splice(targetIndex < 0 ? next.length : targetIndex, 0, fromPath)
    void persistFavorites(next)
  }

  function jumpToOutline(item: OutlineItem) {
    editor?.scrollToLine(item.line)
  }

  function requestQuit() {
    quitOpen = true
  }

  function showContextMenu(event: MouseEvent, path: string, isDir: boolean) {
    event.preventDefault()
    const width = 225
    const height = isDir ? (scopePath ? 242 : 207) : 227
    contextMenuHasAssets = false
    contextMenu = {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      path,
      isDir,
    }
    if (!isDir) {
      void api
        .fileAssets(path)
        .then((res) => {
          if (contextMenu && !contextMenu.isDir && contextMenu.path === path) {
            contextMenuHasAssets = res.hasAssets
          }
        })
        .catch(() => {})
    }
  }

  function downloadNote(path: string, withAssets = false) {
    contextMenu = null
    exportMenuOpen = false
    if (!path) return
    const link = document.createElement('a')
    link.href = api.downloadUrl(path, withAssets)
    link.download = ''
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function scopeToFolder() {
    if (!contextMenu?.isDir) return
    scopePath = contextMenu.path
    localStorage.setItem(SCOPE_KEY, scopePath)
    contextMenu = null
  }

  function unscopeFolder() {
    scopePath = null
    localStorage.removeItem(SCOPE_KEY)
    contextMenu = null
  }

  function computePropertiesSize(targetPath: string, isDir: boolean): number {
    if (!isDir) {
      return files.find((f) => f.path === targetPath)?.size ?? 0
    }
    const prefix = `${targetPath}/`
    let total = 0
    for (const file of files) {
      if (file.path.startsWith(prefix)) {
        total += file.size
      }
    }
    return total
  }

  function requestProperties() {
    const target = contextMenu
    contextMenu = null
    if (!target) return
    pendingProperties = {
      path: target.path,
      isDir: target.isDir,
      sizeBytes: computePropertiesSize(target.path, target.isDir),
    }
    propertiesDialogEl?.showModal()
  }

  function closePropertiesDialog() {
    propertiesDialogEl?.close()
    pendingProperties = null
  }

  function handleWindowPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement | null
    if (exportMenuOpen && !target?.closest('.export-wrap')) exportMenuOpen = false
    if (!contextMenu) return
    if (target?.closest('.context-menu')) return
    contextMenu = null
  }
  function fullVaultPath(relPath: string): string {
    if (!root) return relPath
    const sep = root.includes('\\') ? '\\' : '/'
    const base = root.replace(/[\\/]+$/, '')
    const cleanRel = relPath.replace(/^\/+/, '').split('/').join(sep)
    return cleanRel ? `${base}${sep}${cleanRel}` : base
  }

  async function copyContextPath() {
    const path = contextMenu?.path
    contextMenu = null
    if (!path) return
    const full = fullVaultPath(path)
    try {
      await navigator.clipboard.writeText(full)
      flash(`Copied ${full}`)
    } catch {
      flash(`Could not copy path`, true)
    }
  }

  async function requestRename() {
    const target = contextMenu
    contextMenu = null
    if (!target) return
    const slash = target.path.lastIndexOf('/')
    const base = slash >= 0 ? target.path.slice(slash + 1) : target.path
    pendingRename = { path: target.path, isDir: target.isDir }
    renameValue = target.isDir ? base : base.replace(/\.(md|markdown|mdown|mkd)$/i, '')
    renameError = ''
    renameBusy = false
    await tick()
    renameDialogEl?.showModal()
    requestAnimationFrame(() => {
      renameInput?.focus()
      renameInput?.select()
    })
  }

  function closeRenameDialog() {
    renameDialogEl?.close()
    pendingRename = null
    renameValue = ''
    renameError = ''
    renameBusy = false
  }

  function remapPathPrefix(p: string, from: string, to: string, isDir: boolean): string {
    if (p === from) return to
    if (isDir && p.startsWith(from + '/')) return to + p.slice(from.length)
    return p
  }

  async function confirmRename() {
    if (renameBusy || !pendingRename) return
    const { path: fromPath, isDir } = pendingRename
    let name = renameValue.trim().replace(/[\\/:*?"<>|]+/g, '-')
    if (!name || name === '.' || name === '..') {
      renameError = isDir ? 'Enter a folder name.' : 'Enter a note name.'
      return
    }
    if (!isDir) {
      const origExtMatch = fromPath.match(/\.(md|markdown|mdown|mkd)$/i)
      const hasMdExt = /\.(md|markdown|mdown|mkd)$/i.test(name)
      if (!hasMdExt) name += origExtMatch ? origExtMatch[0] : '.md'
    }
    const slash = fromPath.lastIndexOf('/')
    const parent = slash >= 0 ? fromPath.slice(0, slash) : ''
    const toPath = parent ? `${parent}/${name}` : name
    if (toPath === fromPath) {
      closeRenameDialog()
      return
    }
    renameBusy = true
    renameError = ''
    try {
      await api.rename(fromPath, toPath)
      closeRenameDialog()
      const updatedFavs = favorites.map((entry) => remapPathPrefix(entry, fromPath, toPath, isDir))
      if (updatedFavs.some((entry, idx) => entry !== favorites[idx])) {
        await persistFavorites(updatedFavs)
      }
      if (scopePath) {
        const nextScope = remapPathPrefix(scopePath, fromPath, toPath, isDir)
        if (nextScope !== scopePath) {
          scopePath = nextScope
          localStorage.setItem(SCOPE_KEY, scopePath)
        }
      }
      if (currentPath) {
        const nextCurrent = remapPathPrefix(currentPath, fromPath, toPath, isDir)
        if (nextCurrent !== currentPath) {
          currentPath = nextCurrent
          localStorage.setItem(LAST_PATH_KEY, currentPath)
          window.history.replaceState({ file: currentPath }, '', buildAppUrl(currentPath, ''))
        }
      }
      await refreshTree(false, true)
      flash(`Renamed to ${toPath}`)
    } catch (err) {
      renameError = err instanceof Error ? err.message : String(err)
      renameBusy = false
    }
  }

  async function requestDelete() {
    const target = contextMenu
    contextMenu = null
    if (!target) return
    pendingDelete = { path: target.path, isDir: target.isDir }
    await tick()
    deleteDialogEl?.showModal()
  }

  async function requestAddDocument() {
    newDocFolder = contextMenu?.path ?? ''
    contextMenu = null
    newDocName = ''
    newDocError = ''
    await tick()
    newDocDialogEl?.showModal()
    requestAnimationFrame(() => newDocInput?.focus())
  }

  function closeNewDocDialog() {
    newDocDialogEl?.close()
    newDocFolder = ''
    newDocName = ''
    newDocError = ''
    newDocBusy = false
  }

  async function confirmAddDocument() {
    if (newDocBusy) return
    let name = newDocName.trim().replace(/[\\/:*?"<>|]+/g, '-')
    if (!name) {
      newDocError = 'Enter a note name.'
      return
    }
    if (!/\.md$/i.test(name)) name += '.md'
    const fullPath = newDocFolder ? `${newDocFolder}/${name}` : name
    if (files.some((file) => file.path === fullPath)) {
      newDocError = 'A note with that name already exists.'
      return
    }
    newDocBusy = true
    newDocError = ''
    const title = name.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled'
    try {
      await api.save(fullPath, `# ${title}\n\n`, '')
      closeNewDocDialog()
      await refreshTree(true)
      await openFile(fullPath)
      flash(`Created ${fullPath}`)
    } catch (err) {
      newDocError = err instanceof Error ? err.message : String(err)
      newDocBusy = false
    }
  }

  function closeDeleteDialog() {
    deleteDialogEl?.close()
    pendingDelete = null
  }

  async function confirmDelete() {
    const target = pendingDelete
    if (!target) return
    const { path, isDir } = target
    try {
      await api.deleteFile(path)
      closeDeleteDialog()
      const matchesDeleted = (entry: string) => entry === path || (isDir && entry.startsWith(path + '/'))
      if (favorites.some(matchesDeleted)) {
        await persistFavorites(favorites.filter((entry) => !matchesDeleted(entry)))
      }
      if (scopePath && matchesDeleted(scopePath)) {
        scopePath = null
        localStorage.removeItem(SCOPE_KEY)
      }
      await refreshTree(false, true)
      if (currentPath && matchesDeleted(currentPath)) clearCurrentFile()
      flash(`Deleted ${path}`)
    } catch (err) {
      flash(`Could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  function clearCurrentFile() {
    currentPath = ''
    currentHasAssets = false
    selectedRange = null
    talkPinnedSelection = ''
    content = ''
    hash = ''
    modTime = 0
    dirty = false
    saveError = ''
    saveState = 'saved'
    conflictData = null
    conflictOpen = false
    format = defaultFormat
    editor?.setDoc('', '')
    localStorage.removeItem(LAST_PATH_KEY)
    window.history.replaceState({}, '', buildAppUrl('', ''))
  }

  function cancelQuit() {
    quitOpen = false
  }

  async function confirmQuit() {
    quitOpen = false
    if (dirty) {
      const ok = await saveNow()
      if (!ok) {
        flash('Resolve the conflict before quitting.', true)
        return
      }
    }
    shuttingDown = true
    try {
      await api.quit()
    } catch {
      // The server closes the connection as it exits; that is expected.
    }
  }

  function updatePaletteAnchor() {
    const rect = searchTriggerEl?.getBoundingClientRect()
    if (!rect) return
    const width = Math.min(Math.max(rect.width, 360), window.innerWidth - 24)
    const left = Math.min(
      Math.max(12, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - 12,
    )
    paletteAnchor = { left, top: rect.bottom + 6, width }
  }

  function openSearch(initial = '') {
    updatePaletteAnchor()
    restoreEditorFocus = !!editor?.view.hasFocus
    searchInitial = initial
    searchOpen = true
  }

  function closeSearch() {
    searchOpen = false
    if (restoreEditorFocus) {
      requestAnimationFrame(() => editor?.focus())
    }
  }

  function paletteShortcut(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.stopPropagation()
      toggleZenMode()
      return
    }
    if (event.key === 'F1') {
      event.preventDefault()
      openSearch('')
      return
    }
    if (event.key === 'F5' && !presentOpen && currentPath && !isCurrentHtml) {
      event.preventDefault()
      presentOpen = true
      return
    }
    if (event.altKey && event.key.toLowerCase() === 't') {
      event.preventDefault()
      toggleTalk()
      return
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.code === 'KeyC' || event.key.toLowerCase() === 'c')) {
      if (currentPath && !isCurrentHtml) {
        event.preventDefault()
        event.stopPropagation()
        openCommentDraft()
        return
      }
    }
    if (
      (event.key === '?' || (event.key === '/' && event.shiftKey)) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !isTypingTarget(document.activeElement)
    ) {
      event.preventDefault()
      shortcutsOpen = true
      return
    }
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
      event.preventDefault()
      shortcutsOpen = true
      return
    }
    const key = event.key.toLowerCase()
    if (key === 'p' && !event.shiftKey) {
      event.preventDefault()
      openSearch('')
    } else if (key === 'f' && event.shiftKey) {
      event.preventDefault()
      openSearch('?')
    } else if (key === 'o' && event.shiftKey) {
      event.preventDefault()
      openSearch('@')
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && commentDraft) {
      event.preventDefault()
      cancelCommentDraft()
      return
    }
    if (event.key === 'Escape' && shortcutsOpen) {
      event.preventDefault()
      shortcutsOpen = false
      return
    }
    if (event.key === 'Escape' && settingsOpen) {
      event.preventDefault()
      settingsOpen = false
      return
    }
    if (event.key === 'Escape' && quitOpen) {
      event.preventDefault()
      quitOpen = false
      return
    }
    if (event.key === 'Escape' && contextMenu) {
      event.preventDefault()
      contextMenu = null
      return
    }
    if (event.altKey && event.key === 'Enter' && selectedRange) {
      event.preventDefault()
      openSelectionInTalk()
      return
    }
    if (event.key === 'Escape' && zenMode) {
      event.preventDefault()
      toggleZenMode()
      return
    }
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      if (saveState === 'conflict') conflictOpen = true
      else void saveNow()
    } else if (key === 'b' && !event.shiftKey) {
      event.preventDefault()
      toggleSidebar()
    } else if (key === 'r' && event.shiftKey) {
      event.preventDefault()
      void refreshTree(true)
    }
  }

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    if (!dirty || !currentPath || readOnly) return
    if (saveState !== 'conflict') {
      try {
        void fetch('/api/file', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: currentPath,
            content: encodeForSave(content, format),
            expectedHash: hash,
          }),
          keepalive: true,
        })
      } catch {
        /* best effort */
      }
    }
    event.preventDefault()
    event.returnValue = ''
  }

  function findFolder(entries: Entry[], path: string): Entry | null {
    for (const entry of entries) {
      if (entry.isDir) {
        if (entry.path === path) return entry
        const nested = findFolder(entry.children ?? [], path)
        if (nested) return nested
      }
    }
    return null
  }

  function flash(message: string, error = false) {
    toast = message
    toastError = error
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast = ''
    }, 2800)
  }

  /** Short model label for chips (the provider prefix is implied by the agent). */
  function shortModel(id: string): string {
    if (!id) return ''
    return id.split('/').pop() || id
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null
    if (!element) return false
    const tag = element.tagName
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      element.isContentEditable === true
    )
  }
</script>

<svelte:window onkeydown={handleKeydown} onpointerdown={handleWindowPointerDown} />

<div class="app-shell" class:zen={zenMode}>
  {#if zenMode}
    <div class="zen-progress" style={`width: ${Math.round(scrollProgress * 100)}%`} aria-hidden="true"></div>
  {/if}
  <header class="topbar">
    <div class="topbar-left">
      <a class="brand" href={repoUrl} target="_blank" rel="noopener noreferrer" title="Burley on GitHub">
        <span class="brand-mark" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="26" height="26" fill="none">
            <defs>
              <clipPath id="burley-brand-clip">
                <rect width="32" height="32" rx="7" />
              </clipPath>
            </defs>
            <rect width="32" height="32" rx="7" fill="#c2410c" />
            <g clip-path="url(#burley-brand-clip)">
              <path d="M0 9.5 C6 4.5 12 13.5 18 9.5 C24 5.5 28 11.5 32 8.5 L32 23.5 C27 27.5 22 20.5 16 24.5 C10 28.5 5 21.5 0 25 Z" fill="#fff7ed" opacity="0.22" />
              <path d="M1.5 17.5 C7.5 13.5 13.5 21.5 19.5 17.5 C24.5 14 28.5 18.5 30.5 16.5" stroke="#fff7ed" stroke-width="1.3" stroke-linecap="round" opacity="0.26" />
              <rect x="4.5" y="18.2" width="8.2" height="4.4" rx="2.2" fill="#fff7ed" />
              <rect x="12.2" y="13.8" width="7.2" height="4" rx="2" fill="#fff7ed" opacity="0.95" />
              <rect x="19.6" y="10.2" width="6" height="3.4" rx="1.7" fill="#fff7ed" opacity="0.9" />
            </g>
          </svg>
        </span>
        <span class="brand-name">Burley</span>
      </a>

      <span class="pill {saveState}" class:inactive={!currentPath} title={saveError || saveLabel}>
        <span class="pill-dot"></span>
        {currentPath ? saveLabel : 'Ready'}
      </span>

      {#if currentPath}
        <button
          class="icon-btn favorite-star"
          class:on={currentIsFavorite}
          title={currentIsFavorite ? 'Remove current note from favorites' : 'Add current note to favorites'}
          aria-label="Toggle favorite"
          aria-pressed={currentIsFavorite}
          onclick={() => toggleFavorite(currentPath)}
        >
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
            <path
              d="M10 2.9l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.7l-4.2 2.2.8-4.7L3.2 7.9l4.7-.7z"
              fill={currentIsFavorite ? 'currentColor' : 'none'}
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/if}
    </div>

    <button
      class="search-trigger"
      bind:this={searchTriggerEl}
      title="Quick open (Ctrl+P / F1)"
      onclick={() => openSearch('')}
    >
      <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M12.4 12.4L16.5 16.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      <span class="search-trigger-label">Search files…</span>
    </button>

    <div class="toolbar">
      <div class="export-wrap">
        <button
          class="icon-btn"
          aria-label="Export note"
          title="Export as HTML or PDF"
          disabled={!currentPath || exporting}
          onclick={() => (exportMenuOpen = !exportMenuOpen)}
        >
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M10 2.8v8.4M6.8 8l3.2 3.2L13.2 8M4 13.2v3.2h12v-3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </button>
        {#if exportMenuOpen}
          <div class="export-menu" role="menu" aria-label="Export note">
            <button class="export-item" role="menuitem" onclick={() => void runExport('html')}>Export as HTML</button>
            <button class="export-item" role="menuitem" onclick={() => void runExport('pdf')}>Export as PDF</button>
            <button class="export-item" role="menuitem" onclick={() => downloadNote(currentPath, false)}>Download (.md)</button>
            {#if currentHasAssets}
              <button class="export-item" role="menuitem" onclick={() => downloadNote(currentPath, true)}>Download with Assets (.zip)</button>
            {/if}
          </div>
        {/if}
      </div>
      <button class="icon-btn talk-btn" class:on={talkOpen} title="Talk to an AI agent (Alt+T)" aria-label="Toggle Talk panel" onclick={toggleTalk}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
          <path d="M9.2 2.8l1.4 4.2 4.2 1.4-4.2 1.4-1.4 4.2-1.4-4.2-4.2-1.4 4.2-1.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M15.2 12.6l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z" fill="currentColor" />
        </svg>
      </button>
      <button
        class="icon-btn comments-btn"
        class:on={commentsOpen}
        title="Comments panel (Alt+C to add comment)"
        aria-label="Toggle Comments panel"
        disabled={!currentPath || isCurrentHtml}
        onclick={toggleComments}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <path d="M2.6 3.8h10.2v6.6H6.5L3.6 12.8v-2.4h-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M13 7.4h4.4v6.4h-1v2l-2.4-2H8.4v-2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        </svg>
        {#if docComments.length > 0}
          <span class="comments-badge">{docComments.length}</span>
        {/if}
      </button>
      <button
        class="icon-btn present-btn"
        title="Present slides (F5)"
        aria-label="Present slides"
        disabled={!currentPath || isCurrentHtml}
        onclick={() => (presentOpen = true)}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <rect x="2.8" y="3.8" width="14.4" height="10.4" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8.5 7l4.2 2.4-4.2 2.4z" fill="currentColor" />
          <path d="M6.8 16.4h6.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="icon-btn split-btn"
        class:on={!!splitPath}
        title={splitPath ? 'Close split pane' : 'Open current file in split pane'}
        aria-label="Toggle split pane"
        aria-pressed={!!splitPath}
        disabled={!splitPath && !currentPath}
        onclick={() => {
          if (splitPath) closeSplit()
          else if (currentPath) void openInSplit(currentPath)
        }}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
          <rect x="3" y="4" width="14" height="12" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M10 4v12" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
      <button
        class="icon-btn reload-btn"
        title="Reload file & re-render"
        aria-label="Reload file and re-render"
        disabled={!currentPath || reloadingFile}
        onclick={() => void reloadCurrentFile()}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" class:spinning={reloadingFile}>
          <path d="M16 10a6 6 0 1 1-1.7-4.2M16 3.5v3.3h-3.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        class="icon-btn raw-btn"
        class:on={rawMode}
        title={rawMode ? 'Show live preview' : 'Show raw Markdown'}
        aria-label="Toggle raw Markdown"
        aria-pressed={rawMode}
        onclick={toggleRawMode}
      >
        <span class="raw-glyph" aria-hidden="true">&lt;/&gt;</span>
      </button>
      <button
        class="icon-btn width-btn"
        class:on={wideMode}
        title={wideMode ? 'Use narrow reading width' : 'Use wide reading width'}
        aria-label={wideMode ? 'Use narrow reading width' : 'Use wide reading width'}
        aria-pressed={wideMode}
        onclick={toggleWideMode}
      >
        {#if wideMode}
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M3 4v12M17 4v12M8.5 7l-2.5 3 2.5 3M11.5 7l2.5 3-2.5 3M6 10h8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        {:else}
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M4.5 4v12M15.5 4v12M7.5 10h5M9.5 7.5L7 10l2.5 2.5M10.5 7.5L13 10l-2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        {/if}
      </button>
      <button class="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (Ctrl+?)" onclick={() => (shortcutsOpen = true)}>
        <span class="shortcut-glyph" aria-hidden="true">?</span>
      </button>
      <button
        class="icon-btn theme-btn"
        title={`Theme: ${themeMode} — click to cycle system / light / dark`}
        aria-label={`Theme: ${themeMode}`}
        onclick={cycleTheme}
      >
        {#if themeMode === 'system'}
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
            <rect x="2.8" y="3.6" width="14.4" height="10.2" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M10 3.6v10.2" stroke="currentColor" stroke-width="1.3" />
            <path d="M7.2 16.4h5.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <path d="M10 3.6a5.1 5.1 0 0 1 0 10.2z" fill="currentColor" opacity="0.55" />
          </svg>
        {:else if themeMode === 'light'}
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
            <circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M10 2.4v2M10 15.6v2M2.4 10h2M15.6 10h2M4.6 4.6l1.4 1.4M14 14l1.4 1.4M15.4 4.6L14 6M6 14l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        {:else}
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">
            <path d="M15.6 12.4A6.4 6.4 0 0 1 7.6 4.4a6.6 6.6 0 1 0 8 8z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          </svg>
        {/if}
      </button>
      <button class="icon-btn" aria-label="Open settings" title="Settings" onclick={() => (settingsOpen = true)}>
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linejoin="round"
          />
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </button>
      <button class="toggle-btn" class:on={readOnly} title="Toggle read-only mode" onclick={toggleReadOnly}>
        {#if readOnly}
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><rect x="5" y="9" width="10" height="7.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M7.4 9V6.9a2.6 2.6 0 0 1 5.2 0V9" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        {:else}
          <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><rect x="5" y="9" width="10" height="7.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M7.4 9V6.9a2.6 2.6 0 0 1 5 1.1" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
        {/if}
        <span>Read-only</span>
      </button>
      <button class="icon-btn" class:on={sidebarOpen} title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar" onclick={toggleSidebar}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M12.5 4v12" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <button class="icon-btn" class:on={zenMode} title="Zen mode (Ctrl+Shift+Z)" aria-label="Toggle Zen mode" onclick={toggleZenMode}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M3.2 6h13.6M5.6 10h8.8M3.2 14h13.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
      </button>
      <span class="toolbar-sep" aria-hidden="true"></span>
      <button class="icon-btn quit-btn" title="Quit Burley (stops the local server)" aria-label="Quit Burley" onclick={requestQuit}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M10 2.6v6.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /><path d="M6.1 5.1a6.1 6.1 0 1 0 7.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
      </button>
    </div>
  </header>

  <main class="workspace" class:collapsed={!sidebarOpen || zenMode} class:talk-open={rightPanel !== null} class:zen={zenMode} style={`--sidebar-width: ${sidebarWidth}px; --talk-width: ${talkWidth}px`}>
    <aside class="sidebar" class:closed={!sidebarOpen || zenMode} aria-label="Sidebar">
      <div class="sidebar-tabs" role="tablist" aria-label="Sidebar panels">
        <button
          class="sidebar-tab"
          class:active={sidebarTab === 'files'}
          role="tab"
          aria-selected={sidebarTab === 'files'}
          onclick={() => setSidebarTab('files')}
        >
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M2.8 5.1c0-.6.5-1.1 1.1-1.1h3.4l1.4 1.5h7.4c.6 0 1.1.5 1.1 1.1v8.2c0 .6-.5 1.1-1.1 1.1H3.9c-.6 0-1.1-.5-1.1-1.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
          <span>Files</span>
          <span class="tab-count">{files.length}</span>
        </button>
        <button
          class="sidebar-tab"
          class:active={sidebarTab === 'outline'}
          role="tab"
          aria-selected={sidebarTab === 'outline'}
          onclick={() => setSidebarTab('outline')}
        >
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4 5.2h1.2M4 10h1.2M4 14.8h1.2M7.6 5.2h8.4M7.6 10h8.4M7.6 14.8h5.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          <span>Outline</span>
          <span class="tab-count">{outline.length}</span>
        </button>
      </div>

      {#if sidebarTab === 'files'}
        {#if virtualDemoActive}
          <div class="scope-banner">
            <span class="scope-label">Built-in <strong>Feature Demo</strong></span>
            <button class="scope-clear" onclick={() => void exitVirtualDemo()}>Exit Demo</button>
          </div>
        {:else if scopePath}
          <div class="scope-banner">
            <span class="scope-label">Scoped to <strong>{scopePath}</strong></span>
            <button class="scope-clear" onclick={unscopeFolder}>Unscope</button>
          </div>
        {/if}
        <div class="filter-wrap">
          <div class="filter-input-wrap">
            <input
              class="tree-filter"
              placeholder="Filter notes…"
              title="Filter favorites and notes (Enter opens an explicit path)"
              spellcheck="false"
              bind:value={treeFilter}
              onkeydown={(event) => {
                if (event.key !== 'Enter') return
                const explicit = normalizeExplicitPath(treeFilter, root)
                if (explicit && (isMarkdownPath(explicit) || isHtmlPath(explicit))) {
                  event.preventDefault()
                  void openFile(explicit)
                }
              }}
            />
            {#if treeFilter}
              <button class="clear-filter" aria-label="Clear filter" onclick={() => (treeFilter = '')}>×</button>
            {/if}
          </div>
          <button
            class="icon-btn small"
            title="Collapse all folders"
            aria-label="Collapse all folders"
            onclick={() => (treeCollapseSignal += 1)}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true">
              <path d="M6 5.5L10 9l4-3.5M6 14.5L10 11l4 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button
            class="icon-btn small"
            title="Reload folder (Ctrl+Shift+R)"
            aria-label="Reload folder"
            onclick={() => void refreshTree(true)}
          >
            <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M15.6 8.1A5.7 5.7 0 1 0 16 11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><path d="M15.9 4.4v3.9h-3.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        </div>

        {#if showFavorites}
          <div class="favorites" class:collapsed={!favoritesOpen}>
            <button class="favorites-head" aria-expanded={favoritesOpen} onclick={toggleFavoritesOpen}>
              <span class="chevron" class:open={favoritesOpen} aria-hidden="true">
                <svg viewBox="0 0 16 16" width="11" height="11"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
              </span>
              <svg class="favorites-star-icon" viewBox="0 0 20 20" width="12" height="12" aria-hidden="true"><path d="M10 2.9l2.1 4.3 4.7.7-3.4 3.3.8 4.7L10 13.7l-4.2 2.2.8-4.7L3.2 7.9l4.7-.7z" fill="currentColor" /></svg>
              <span class="favorites-title">Favorites</span>
              <span class="tab-count">{filteredFavorites.length}</span>
              <span class="grow"></span>
            </button>

            {#if favoritesOpen}
              {#if favorites.length === 0}
                <p class="favorites-empty">Star a note to pin it here.</p>
              {:else if filteredFavorites.length === 0}
                <p class="favorites-empty">No favorites match “{treeFilter.trim()}”.</p>
              {:else}
                <ul class="favorites-list">
                  {#each filteredFavorites as favorite (favorite.path)}
                    <li
                      class="favorite-item"
                      class:missing={!favorite.exists}
                      class:dragging={dragFavoritePath === favorite.path}
                      draggable="true"
                      ondragstart={(event) => favoriteDragStart(event, favorite.path)}
                      ondragover={(event) => event.preventDefault()}
                      ondrop={(event) => favoriteDrop(event, favorite.path)}
                      ondragend={() => (dragFavoritePath = null)}
                    >
                      <button
                        class="favorite-row"
                        title={favorite.exists ? favorite.path : `Missing: ${favorite.path}`}
                        onclick={() => {
                          if (!favorite.exists) return
                          void openFile(favorite.path).then(() => scrollTreeToPath(favorite.path))
                        }}
                        onmousedown={(event) => {
                          if (event.button === 1 && favorite.exists) event.preventDefault()
                        }}
                        onauxclick={(event) => {
                          if (event.button === 1 && favorite.exists) {
                            event.preventDefault()
                            event.stopPropagation()
                            openNoteInNewTab(favorite.path)
                          }
                        }}
                      >
                        <span class="favorite-pin" aria-hidden="true">★</span>
                        <span class="favorite-name">{stripMdExt(favorite.name)}</span>
                        <span class="favorite-dir">{favorite.dir}</span>
                        {#if !favorite.exists}<span class="favorite-missing">missing</span>{/if}
                      </button>
                      <button
                        class="favorite-remove"
                        title={favorite.exists ? 'Remove from favorites' : 'Remove missing favorite'}
                        aria-label="Remove favorite"
                        onclick={() => toggleFavorite(favorite.path)}
                      >×</button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </div>
        {/if}

        <div class="tree-scroll" bind:this={treeScrollEl}>
          {#if loading && files.length === 0}
            <p class="tree-status">Loading…</p>
          {:else if loadError}
            <p class="tree-status error">{loadError}</p>
          {:else if files.length === 0 && !treeComplete}
            <p class="tree-status">Scanning…</p>
          {:else}
            <FileTree
              entries={visibleTreeEntries}
              selectedPath={currentPath}
              filter={treeFilter}
              favorites={favorites}
              rescanningPath={rescanningFolder}
              collapseSignal={treeCollapseSignal}
              ontogglefavorite={(path) => toggleFavorite(path)}
              ontogglefolder={handleFolderToggle}
              onrescan={(path) => void rescanFolder(path)}
              oncontext={showContextMenu}
              onselect={(path) => void openFile(path)}
            />
          {/if}
        </div>

        <div class="sidebar-foot">
          <span>{files.length} note{files.length === 1 ? '' : 's'}</span>
          <span class="grow"></span>
          {#if !treeComplete}
            <span class="tree-scanning" title="Scanning the folder for Markdown files…">scanning…</span>
          {:else}
            <span title="Autosave after 1.5s of inactivity">autosave on</span>
          {/if}
        </div>
      {:else}
        <div class="outline-scroll">
          {#if !currentPath}
            <p class="tree-status">Open a note to see its outline.</p>
          {:else if outline.length === 0}
            <p class="tree-status">No headings in this note.</p>
          {:else}
            <ul class="outline-list">
              {#each outline as item (item.id)}
                <li>
                  <button
                    class="outline-item level-{item.level}"
                    class:active={item.line === activeHeadingLine}
                    style={`padding-left: ${10 + (item.level - 1) * 13}px`}
                    title={`Line ${item.line}`}
                    onclick={() => jumpToOutline(item)}
                  >
                    {item.text}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        <div class="sidebar-foot">
          <span>{outline.length} heading{outline.length === 1 ? '' : 's'}</span>
          <span class="grow"></span>
          <span>Click to jump</span>
        </div>
      {/if}

      <button
        type="button"
        class="sidebar-resizer"
        aria-label="Resize sidebar"
        title="Drag to resize — double-click to reset"
        onpointerdown={startSidebarResize}
        onkeydown={handleResizerKeydown}
        ondblclick={() => setSidebarWidth(302)}
      ></button>
    </aside>


    <div class="editor-stage" class:has-split={!!splitPath}>
      <section class="editor-pane">
      <div
        class="editor-host"
        class:wide={wideMode}
        class:raw={rawMode}
        hidden={isCurrentHtml && !rawMode}
        data-md-style={markdownStyle}
        bind:this={editorHost}
        style={`--editor-measure: ${zenMode ? '760px' : wideMode ? '1200px' : '820px'}; --editor-gutter: ${zenMode ? '32px' : wideMode ? '28px' : '48px'}`}
      ></div>
      {#if isCurrentHtml && !rawMode}
        <iframe
          class="html-frame"
          title={currentPath}
          src={htmlFrameSrc}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        ></iframe>
      {/if}

      {#if !currentPath}
        <div class="empty-state">
          <div class="empty-card">
            <span class="empty-mark">B</span>
            <h1>Burley</h1>
            <p>
              {#if files.length}
                Pick a note from the sidebar, or press <kbd>Ctrl P</kbd> to jump to one.
              {:else if !treeComplete}
                Scanning the folder for Markdown files…
              {:else}
                No Markdown files were found in this folder. Start the server with <code>--root</code> pointing at your
                notes.
              {/if}
            </p>
            <div class="empty-actions">
              <button class="primary" onclick={() => openSearch('')}>Open a note</button>
              <button class="secondary" onclick={() => void refreshTree(true)}>Reload folder</button>
            </div>
            {#if root}<code class="root-path">{root}</code>{/if}
          </div>
        </div>
      {/if}

      {#if loadingFile}
        <div class="loading-bar" role="status" aria-label="Loading note"></div>
      {/if}
      </section>

      {#if splitPath}
        <aside class="split-pane" aria-label={`Split view: ${splitPath}`}>
          <header class="split-head">
            <span class="split-path" title={splitPath}>{splitPath}</span>
            <span class="grow"></span>
            <button
              type="button"
              class="talk-icon"
              title="Swap with main pane"
              aria-label="Swap with main pane"
              onclick={() => void swapSplit()}
            >
              ⇄
            </button>
            <button
              type="button"
              class="talk-icon"
              title="Reload split pane"
              aria-label="Reload split pane"
              onclick={() => void openInSplit(splitPath)}
            >
              ↻
            </button>
            <button
              type="button"
              class="talk-icon"
              title="Close split pane"
              aria-label="Close split pane"
              onclick={closeSplit}
            >
              ×
            </button>
          </header>
          <div class="split-body">
            {#if isSplitHtml}
              <iframe
                class="html-frame"
                title={splitPath}
                src={splitHtmlSrc}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              ></iframe>
            {:else}
              <article class="split-doc" data-md-style={markdownStyle}>
                {@html splitHtmlRendered}
              </article>
            {/if}
          </div>
        </aside>
      {/if}
    </div>

    {#if talkOpen}
      <aside class="talk-panel" aria-label="Talk">
        <header class="talk-head">
          <span class="talk-title">Talk</span>
          {#if agents.length > 1}
            <select class="talk-agent-select" bind:value={talkAgent}>
              {#each agents as agent (agent.id)}
                <option value={agent.id}>{agent.name}</option>
              {/each}
            </select>
          {:else if agents.length === 1}
            <span class="talk-agent-name">{agents[0].name}</span>
          {/if}
          {#if agentPins[talkAgent]}
            <span class="talk-model" title={`Pinned model: ${agentPins[talkAgent]}`}>{shortModel(agentPins[talkAgent])}</span>
          {/if}
          <span class="grow"></span>
          <button
            class="talk-icon"
            class:on={talkDiagOpen}
            title="Agent diagnostics"
            aria-label="Agent diagnostics"
            onclick={() => (talkDiagOpen = !talkDiagOpen)}
          >
            <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true"><path d="M12.7 3.8a4 4 0 0 0-5.1 5.1L3.8 12.7a1.5 1.5 0 0 0 2.1 2.1l3.8-3.8a4 4 0 0 0 5.1-5.1l-2.2 2.2-1.8-.4-.4-1.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
          </button>
          <button class="talk-icon" title="New chat" aria-label="New chat" onclick={newTalkChat}>+</button>
          <button class="talk-icon" title="Close Talk" aria-label="Close Talk" onclick={() => (rightPanel = null)}>×</button>
        </header>

        {#if talkDiagOpen || agents.length === 0}
          <div class="talk-diag">
            <div class="talk-diag-head">
              <strong>Agent diagnostics</strong>
              <button class="talk-insert" onclick={() => void loadAgents(true)}>Re-detect</button>
            </div>
            <ul class="talk-diag-list">
              {#each sortedAllAgents as item (item.id)}
                {@const testRes = agentTests[item.id]}
                {@const testing = !!agentTesting[item.id]}
                {@const enabled = isAgentEnabled(item.id)}
                {#if !item.available}
                  <li class="talk-diag-row not-found">
                    <div class="talk-diag-main">
                      <span class="talk-diag-dot missing"></span>
                      <span class="talk-diag-name">{item.name}</span>
                      <code class="talk-diag-path">{item.id}</code>
                      <span class="talk-diag-badge">not found</span>
                    </div>
                  </li>
                {:else}
                  <li class="talk-diag-row" class:disabled={!enabled}>
                    <div class="talk-diag-main">
                      <span
                        class="talk-diag-dot"
                        class:ok={!!testRes?.confirmed && !testing}
                        class:testing={testing}
                      ></span>
                      <span class="talk-diag-name">{item.name}</span>
                      <code class="talk-diag-path" title={item.path}>{item.path}</code>
                      {#if !enabled}
                        <span class="talk-diag-badge">disabled</span>
                      {/if}
                      <button
                        class="talk-insert"
                        disabled={testing}
                        onclick={() => void runAgentTest(item.id)}
                      >
                        {testing ? 'Testing…' : 'Test'}
                      </button>
                    </div>
                    {#if testRes}
                      <pre class="talk-diag-out">{`${testRes.confirmed ? 'confirmed' : 'failed'} · exit ${testRes.exitCode}${testRes.durationMs != null ? ` (${testRes.durationMs}ms)` : ''}${testRes.reply ? `\nreply: ${testRes.reply}` : ''}${testRes.stderr && testRes.stderr !== testRes.error ? `\nstderr: ${testRes.stderr}` : ''}${testRes.error ? `\nerror: ${testRes.error}` : ''}`}</pre>
                    {/if}
                  </li>
                {/if}
              {/each}
            </ul>
            {#if agentPathEnv}
              <details class="talk-diag-path-env">
                <summary>Server PATH</summary>
                <pre class="talk-diag-out">{agentPathEnv}</pre>
              </details>
            {/if}
          </div>
        {/if}

        {#if agents.length === 0}
          <p class="talk-empty">
            No supported CLI agents were found on this server. Install <code>claude</code>,
            <code>codex</code>, <code>gemini</code>, <code>opencode</code>, <code>cursor-agent</code>,
            <code>devin</code>, or <code>pi</code> (or check Server PATH above) and click Re-detect.
          </p>
        {:else}
          <div class="talk-modes">
            <button class="talk-mode" class:active={talkMode === 'ask'} onclick={() => (talkMode = 'ask')}>Ask</button>
            <button class="talk-mode" class:active={talkMode === 'edit'} onclick={() => (talkMode = 'edit')}>Edit</button>
            {#if talkPinnedSelection}
              <button
                class="talk-context"
                title="The selection sent with this conversation"
                onclick={clearTalkSelection}
              >
                selection · {selectionWords(talkPinnedSelection)}w ✕
              </button>
            {/if}
            <span class="talk-mode-hint">{talkMode === 'edit' ? 'may edit this note' : 'read-only'}</span>
          </div>

          <div class="talk-messages" bind:this={talkMessagesEl}>
            {#if talkMessages.length === 0}
              <p class="talk-hint">
                Ask about <strong>{baseName(currentPath) || 'this note'}</strong>. Use Edit mode to let the agent change
                the file on disk.
              </p>
            {/if}
            {#each talkMessages as message, index (index)}
              {#if message.role === 'user'}
                <div class="talk-message user">
                  <p>{message.content}</p>
                  {#if message.selection}
                    <blockquote class="talk-quote">{excerpt(message.selection)}</blockquote>
                  {/if}
                </div>
              {:else if message.content || message.debug}
                <div class="talk-message assistant">
                  {#if message.action === 'rewrite' && message.selection}
                    <div class="talk-diff">
                      {#each wordDiff(message.selection, cleanSuggestion(message.content)) as part, partIndex (partIndex)}
                        <span
                          class:talk-add={part.kind === 'add'}
                          class:talk-del={part.kind === 'del'}
                        >{part.text}</span>
                      {/each}
                    </div>
                    <div class="talk-actions">
                      {#if message.applied}
                        <span class="talk-applied">Applied</span>
                      {:else if !readOnly && !talkStreaming && talkRangeValid(message)}
                        <button class="talk-insert" onclick={() => replaceTalkSuggestion(index)}>
                          Replace selection
                        </button>
                        <button class="talk-insert" onclick={() => insertTalkSuggestion(index)}>
                          Insert below
                        </button>
                      {/if}
                      <button class="talk-insert" onclick={() => copyTalkSuggestion(index)}>Copy</button>
                    </div>
                  {:else if message.content}
                    <div class="talk-markdown">{@html renderMarkdown(message.content)}</div>
                    {#each extractFencedBlocks(message.content) as block, blockIndex (blockIndex)}
                      <button class="talk-insert" onclick={() => insertTalkBlock(block)}>
                        Insert {block.lang || 'code'} at cursor
                      </button>
                    {/each}
                  {/if}
                  {#if message.debug && (message.debug.stderr || message.debug.error || (message.debug.exitCode !== undefined && message.debug.exitCode !== 0) || message.debug.command)}
                    <details class="talk-debug" open={!!message.debug.error || (message.debug.exitCode !== undefined && message.debug.exitCode !== 0)}>
                      <summary>
                        Debug{message.debug.exitCode !== undefined ? ` · exit ${message.debug.exitCode}` : ''}{message.debug.durationMs !== undefined ? ` · ${message.debug.durationMs}ms` : ''}
                      </summary>
                      <pre class="talk-diag-out">{`${message.debug.command ? `${message.debug.command} ${(message.debug.args ?? []).join(' ')}` : ''}${message.debug.stderr ? `\nstderr:\n${message.debug.stderr}` : ''}${message.debug.error && !message.debug.stderr ? `\nerror: ${message.debug.error}` : ''}`.trim()}</pre>
                    </details>
                  {/if}
                </div>
              {/if}
            {/each}
            {#if talkStreaming}<span class="talk-typing">Working…</span>{/if}
          </div>

          {#if talkError}<p class="talk-error">{talkError}</p>{/if}

          {#if activeTalkSelection}
            <div class="talk-selection-bar">
              <div class="talk-selection-head">
                <span class="talk-selection-badge">Selection · {selectionWords(activeTalkSelection.text)}w</span>
                <span class="talk-selection-preview" title={activeTalkSelection.text}>{excerpt(activeTalkSelection.text, 64)}</span>
                <button
                  class="talk-selection-clear"
                  title="Clear selection context"
                  aria-label="Clear selection context"
                  onmousedown={(event) => event.preventDefault()}
                  onclick={clearTalkSelection}
                >×</button>
              </div>
              <div class="talk-selection-actions">
                {#each TALK_SELECTION_ACTIONS as item (item.id)}
                  <button
                    type="button"
                    class="talk-selection-btn"
                    title={item.hint}
                    disabled={talkStreaming || !talkAgent}
                    onmousedown={(event) => event.preventDefault()}
                    onclick={() => runTalkSelectionAction(item.id)}
                  >
                    {item.label}
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <div class="talk-compose">
            <textarea
              bind:value={talkInput}
              placeholder="Ask about this note… (Enter sends, Shift+Enter adds a line)"
              onkeydown={talkKeydown}
            ></textarea>
            <button
              class="primary"
              disabled={talkStreaming || !talkInput.trim() || !talkAgent}
              onclick={() => void sendTalk()}
            >Send</button>
          </div>
        {/if}
        <button
          type="button"
          class="talk-resizer"
          aria-label="Resize Talk panel"
          title="Drag to resize — double-click to reset"
          onpointerdown={startTalkResize}
          onkeydown={handleTalkResizerKeydown}
          ondblclick={() => setTalkWidth(TALK_DEFAULT)}
        ></button>
      </aside>
    {:else if commentsOpen}
      <aside class="talk-panel comments-panel" aria-label="Comments">
        <CommentsPanel
          comments={docComments}
          activeId={activeCommentId}
          defaultAuthor={effectiveCommentAuthor}
          canAdd={!!currentPath && !isCurrentHtml}
          draft={commentDraft}
          onnew={openCommentDraft}
          oncreatedraft={submitNewComment}
          oncanceldraft={cancelCommentDraft}
          onselect={handleSelectCommentFromPanel}
          onreply={handleAddReply}
          onedit={handleEditComment}
          ondeletereply={handleDeleteReply}
          ondelete={handleDeleteComment}
          onclose={closeCommentsPanel}
        />
        <button
          type="button"
          class="talk-resizer"
          aria-label="Resize Comments panel"
          title="Drag to resize — double-click to reset"
          onpointerdown={startTalkResize}
          onkeydown={handleTalkResizerKeydown}
          ondblclick={() => setTalkWidth(TALK_DEFAULT)}
        ></button>
      </aside>
    {/if}
  </main>

  <footer class="statusbar">
    <div class="status-left">
      <span class="status-item status-file crumb-file" title={absolutePath || root}>
        {absolutePath || root || '—'}
      </span>
      {#if modifiedLabel}
        <span class="status-item status-modified">modified {modifiedLabel}</span>
      {/if}
    </div>
    {#if saveError}<span class="status-item error">{saveError}</span>{/if}
    <div class="status-right">
      {#if releaseInfo?.updateAvailable && releaseInfo.url}
        <a
          class="status-item status-update"
          href={releaseInfo.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Burley ${releaseInfo.latest} is available — view release notes`}
        >↑ {releaseInfo.latest}</a>
      {/if}
      <span class="status-item">{words} words</span>
      <span class="status-item">Ln {cursor.line}, Col {cursor.column}</span>
      {#if readOnly}<span class="status-item lock">Read-only</span>{/if}
    </div>
  </footer>

  {#if zenMode}
    <div class="zen-stats" role="status" aria-label="Reading stats">
      <span>{words} words</span>
      <span class="zen-dot" aria-hidden="true">·</span>
      <span>{readMinutes} min read</span>
      <button class="zen-exit" onclick={toggleZenMode}>Esc to exit</button>
    </div>
  {/if}
</div>

{#if searchOpen}
  <SearchModal
    initialQuery={searchInitial}
    anchorLeft={paletteAnchor.left}
    anchorTop={paletteAnchor.top}
    anchorWidth={paletteAnchor.width}
    files={visiblePaletteFiles}
    root={root}
    favorites={favorites}
    recent={recent}
    headings={outline}
    commands={paletteCommands}
    onclose={closeSearch}
    onopen={(path, line) => {
      closeSearch()
      void openFile(path, line)
    }}
    onheading={(line) => {
      closeSearch()
      editor?.scrollToLine(line)
    }}
  />
{/if}

{#if figureOpen && figureItems.length}
  <FigureLightbox
    figures={figureItems}
    bind:index={figureIndex}
    onclose={() => {
      figureOpen = false
      editor?.focus()
    }}
  />
{/if}

{#if conflictOpen && conflictData}
  <ConflictModal
    path={currentPath}
    mine={content}
    theirs={conflictData}
    theirsText={decodeForEditor(conflictData.content).text}
    onkeep={() => void keepMine()}
    ontheirs={takeTheirs}
    onclose={() => (conflictOpen = false)}
  />
{/if}

{#if presentOpen && currentPath && !isCurrentHtml}
  <PresentationModal
    title={stripMdExt(baseName(currentPath))}
    markdown={content}
    filePath={currentPath}
    onclose={() => (presentOpen = false)}
  />
{/if}

{#if hoveredDocComment && hoveredComment}
  {@const above = hoveredComment.top > 180}
  <button
    type="button"
    class="comment-hover-card"
    class:is-discussion={hoveredDocComment.kind === 'discussion'}
    class:is-edit={hoveredDocComment.kind === 'edit'}
    style={`left: ${hoveredComment.left}px; ${above ? `bottom: ${window.innerHeight - hoveredComment.top + 8}px` : `top: ${hoveredComment.bottom + 8}px`};`}
    onmouseenter={() => {
      if (hoverCloseTimer) {
        clearTimeout(hoverCloseTimer)
        hoverCloseTimer = null
      }
    }}
    onmouseleave={() => {
      hoverCloseTimer = setTimeout(() => {
        hoverCloseTimer = null
        hoveredComment = null
      }, 120)
    }}
    onclick={() => {
      activeCommentId = hoveredDocComment.id
      rightPanel = 'comments'
      hoveredComment = null
    }}
  >
    <div class="chc-head">
      <span class="chc-pill" class:is-discussion={hoveredDocComment.kind === 'discussion'} class:is-edit={hoveredDocComment.kind === 'edit'}>
        {hoveredDocComment.kind === 'discussion' ? 'Discussion' : 'Edit'}
      </span>
      {#if hoveredDocComment.messages[0]}
        <span class="chc-author">@{hoveredDocComment.messages[0].author}</span>
        <span class="chc-date">{hoveredDocComment.messages[0].date}</span>
      {/if}
    </div>
    {#if hoveredDocComment.messages[0]}
      <p class="chc-body">{hoveredDocComment.messages[0].body}</p>
    {/if}
    {#if hoveredDocComment.kind === 'discussion' && hoveredDocComment.messages.length > 1}
      <div class="chc-replies">
        {#each hoveredDocComment.messages.slice(1) as reply}
          <div class="chc-reply">
            <span class="chc-author">@{reply.author}:</span> {reply.body}
          </div>
        {/each}
      </div>
    {/if}
  </button>
{/if}

{#if toast}
  <div class="toast" class:error={toastError} role="status">{toast}</div>
{/if}

{#if contextMenu}
  <div
    class="context-menu"
    style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}
    role="menu"
    aria-label="File actions"
  >
    {#if contextMenu.isDir}
      {#if scopePath === contextMenu.path}
        <button class="context-menu-item" role="menuitem" onclick={unscopeFolder}>
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4 10h12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
          <span>Unscope</span>
        </button>
      {:else}
        <button class="context-menu-item" role="menuitem" onclick={scopeToFolder}>
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4 5.2h4.2l1.4 1.5h6.4v8.1H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /><circle cx="10" cy="10.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
          <span>Scope to here</span>
        </button>
        {#if scopePath}
          <button class="context-menu-item" role="menuitem" onclick={unscopeFolder}>
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4 10h12M12 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
            <span>Unscope file browser</span>
          </button>
        {/if}
      {/if}
      <button class="context-menu-item" role="menuitem" onclick={() => void requestAddDocument()}>
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        <span>Add document</span>
      </button>
    {:else}
      <button
        class="context-menu-item"
        role="menuitem"
        onclick={() => {
          const p = contextMenu?.path
          contextMenu = null
          if (p) void openInSplit(p)
        }}
      >
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10 4v12" stroke="currentColor" stroke-width="1.4" /></svg>
        <span>Open in split</span>
      </button>
      <button class="context-menu-item" role="menuitem" onclick={() => downloadNote(contextMenu!.path, false)}>
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 3.2v8.8M6.8 9l3.2 3.2L13.2 9M4 13.8v2.5h12v-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>Download</span>
      </button>
      {#if contextMenuHasAssets}
        <button class="context-menu-item" role="menuitem" onclick={() => downloadNote(contextMenu!.path, true)}>
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M10 3.2v8.8M6.8 9l3.2 3.2L13.2 9M4 13.8v2.5h12v-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <span>Download with Assets</span>
        </button>
      {/if}
    {/if}
    <button class="context-menu-item" role="menuitem" onclick={() => void requestRename()}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M13.8 3.8l2.4 2.4-8.8 8.8H5v-2.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></svg>
      <span>Rename</span>
    </button>
    <button class="context-menu-item" role="menuitem" onclick={() => void copyContextPath()}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M5 13H4.5A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5V5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
      <span>Copy path</span>
    </button>
    <button class="context-menu-item" role="menuitem" onclick={requestProperties}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><circle cx="10" cy="10" r="6.8" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10 9v4.2M10 6.5v.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      <span>Properties</span>
    </button>
    <button class="context-menu-item danger" role="menuitem" onclick={() => void requestDelete()}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4.5 6h11M8 6V4.2h4V6M6 6l.7 10h6.6L14 6M8.5 9v4.5M11.5 9v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
      <span>Delete</span>
    </button>
  </div>
{/if}

<dialog
  bind:this={deleteDialogEl}
  class="delete-dialog"
  aria-labelledby="delete-title"
  oncancel={(event) => {
    event.preventDefault()
    closeDeleteDialog()
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) closeDeleteDialog()
  }}
>
  <div class="delete-head">
    <span class="delete-icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20"><path d="M4.5 6h11M8 6V4.2h4V6M6 6l.7 10h6.6L14 6M8.5 9v4.5M11.5 9v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </span>
    <div>
      <h2 id="delete-title">{pendingDelete?.isDir ? 'Delete folder?' : 'Delete note?'}</h2>
      <p>
        {#if pendingDelete?.isDir}
          <code>{pendingDelete.path}</code> and everything inside it will be permanently deleted from this vault. This cannot be undone.
        {:else}
          <code>{pendingDelete?.path}</code> will be permanently deleted from this vault. This cannot be undone.
        {/if}
      </p>
    </div>
  </div>
  <div class="delete-actions">
    <button class="secondary" onclick={closeDeleteDialog}>Cancel</button>
    <button class="danger" onclick={() => void confirmDelete()}>Delete</button>
  </div>
</dialog>

<dialog
  bind:this={propertiesDialogEl}
  class="delete-dialog"
  aria-labelledby="properties-title"
  oncancel={(event) => {
    event.preventDefault()
    closePropertiesDialog()
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) closePropertiesDialog()
  }}
>
  <div class="delete-head">
    <span class="delete-icon properties-icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="6.8" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10 9v4.2M10 6.5v.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
    </span>
    <div>
      <h2 id="properties-title">Properties</h2>
      {#if pendingProperties}
        <p><code>{pendingProperties.path}</code></p>
        <dl class="properties-list">
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(pendingProperties.sizeBytes)}</dd>
          </div>
        </dl>
      {/if}
    </div>
  </div>
  <div class="delete-actions">
    <button class="secondary" onclick={closePropertiesDialog}>Close</button>
  </div>
</dialog>

<dialog
  bind:this={renameDialogEl}
  class="delete-dialog newdoc-dialog"
  aria-labelledby="rename-title"
  oncancel={(event) => {
    event.preventDefault()
    closeRenameDialog()
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) closeRenameDialog()
  }}
>
  <div class="delete-head">
    <span class="delete-icon newdoc-icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20"><path d="M13.8 3.8l2.4 2.4-8.8 8.8H5v-2.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
    </span>
    <div>
      <h2 id="rename-title">{pendingRename?.isDir ? 'Rename folder' : 'Rename note'}</h2>
      <p>Enter a new name for <code>{pendingRename?.path}</code>.</p>
    </div>
  </div>
  <div class="newdoc-body">
    <input
      bind:this={renameInput}
      bind:value={renameValue}
      placeholder={pendingRename?.isDir ? 'folder-name' : 'note-name'}
      spellcheck="false"
      autocomplete="off"
      onkeydown={(event) => {
        if (event.key === 'Enter') void confirmRename()
      }}
    />
  </div>
  {#if renameError}<p class="newdoc-error">{renameError}</p>{/if}
  <div class="delete-actions">
    <button class="secondary" onclick={closeRenameDialog}>Cancel</button>
    <button class="primary" disabled={renameBusy} onclick={() => void confirmRename()}>
      {renameBusy ? 'Renaming…' : 'Rename'}
    </button>
  </div>
</dialog>

<dialog
  bind:this={newDocDialogEl}
  class="delete-dialog newdoc-dialog"
  aria-labelledby="newdoc-title"
  oncancel={(event) => {
    event.preventDefault()
    closeNewDocDialog()
  }}
  onclick={(event) => {
    if (event.target === event.currentTarget) closeNewDocDialog()
  }}
>
  <div class="delete-head">
    <span class="delete-icon newdoc-icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="20" height="20"><path d="M10 4.5v11M4.5 10h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
    </span>
    <div>
      <h2 id="newdoc-title">New document</h2>
      <p>Create a Markdown note in <code>{newDocFolder || 'the vault root'}</code>.</p>
    </div>
  </div>
  <div class="newdoc-body">
    <input
      bind:this={newDocInput}
      bind:value={newDocName}
      placeholder="note-name"
      spellcheck="false"
      autocomplete="off"
      onkeydown={(event) => {
        if (event.key === 'Enter') void confirmAddDocument()
      }}
    />
  </div>
  {#if newDocError}<p class="newdoc-error">{newDocError}</p>{/if}
  <div class="delete-actions">
    <button class="secondary" onclick={closeNewDocDialog}>Cancel</button>
    <button class="primary" disabled={newDocBusy} onclick={() => void confirmAddDocument()}>
      {newDocBusy ? 'Creating…' : 'Create'}
    </button>
  </div>
</dialog>

{#if shortcutsOpen}
  <ShortcutsModal onclose={() => (shortcutsOpen = false)} />
{/if}

{#if settingsOpen}
  <SettingsModal
    settings={{ theme: themeMode, lightTheme, darkTheme, wideMode, markdownStyle, autoSave, ctrlClickLink, spellCheck, fileTypes, backgroundScan, commentHoverPreview, commentAuthor: commentAuthorSetting, demoSeen, agentModels: agentPins, disabledAgents }}
    onrundemo={() => void openVirtualDemo()}
    agents={sortedAllAgents}
    agentTests={agentTests}
    agentTesting={agentTesting}
    ontest={(id) => void runAgentTest(id)}
    onredetect={() => void loadAgents(true)}
    version={appVersion}
    repo={repoUrl}
    release={releaseInfo}
    checkingRelease={checkingRelease}
    oncheck={() => void loadReleaseInfo(true)}
    onchange={updateSetting}
    onclose={() => (settingsOpen = false)}
  />
{/if}

{#if quitOpen}
  <div class="modal-backdrop" role="presentation">
    <div class="modal quit-modal" role="dialog" aria-modal="true" aria-labelledby="quit-title">
      <div class="quit-body">
        <span class="quit-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" width="22" height="22"><path d="M10 2.6v6.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /><path d="M6.1 5.1a6.1 6.1 0 1 0 7.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
        </span>
        <div>
          <h2 id="quit-title">Quit Burley?</h2>
          <p>This stops the local server and closes this tab's connection. Unsaved changes are saved first.</p>
        </div>
      </div>
      <div class="quit-actions">
        <button class="secondary" onclick={cancelQuit}>Cancel</button>
        <button class="danger" onclick={() => void confirmQuit()}>Quit</button>
      </div>
    </div>
  </div>
{/if}

{#if shuttingDown}
  <div class="shutdown-screen" role="status">
    <span class="shutdown-mark" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="50" height="50" fill="none">
        <defs>
          <clipPath id="burley-shutdown-clip">
            <rect width="32" height="32" rx="7" />
          </clipPath>
        </defs>
        <rect width="32" height="32" rx="7" fill="#c2410c" />
        <g clip-path="url(#burley-shutdown-clip)">
          <path d="M0 9.5 C6 4.5 12 13.5 18 9.5 C24 5.5 28 11.5 32 8.5 L32 23.5 C27 27.5 22 20.5 16 24.5 C10 28.5 5 21.5 0 25 Z" fill="#fff7ed" opacity="0.22" />
          <path d="M1.5 17.5 C7.5 13.5 13.5 21.5 19.5 17.5 C24.5 14 28.5 18.5 30.5 16.5" stroke="#fff7ed" stroke-width="1.3" stroke-linecap="round" opacity="0.26" />
          <rect x="4.5" y="18.2" width="8.2" height="4.4" rx="2.2" fill="#fff7ed" />
          <rect x="12.2" y="13.8" width="7.2" height="4" rx="2" fill="#fff7ed" opacity="0.95" />
          <rect x="19.6" y="10.2" width="6" height="3.4" rx="1.7" fill="#fff7ed" opacity="0.9" />
        </g>
      </svg>
    </span>
    <h1>Burley has stopped</h1>
    <p>The local server shut down. You can close this tab.</p>
  </div>
{/if}

<style>
  .app-shell {
    height: 100vh;
    height: 100dvh;
    display: grid;
    grid-template-rows: 52px minmax(0, 1fr) 26px;
    background: var(--bg-app);
  }

  .app-shell.zen {
    grid-template-rows: 0 minmax(0, 1fr) 26px;
  }

  .app-shell.zen .topbar {
    height: 0;
    min-height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-bottom: 0;
    overflow: hidden;
    visibility: hidden;
  }

  .zen-progress {
    position: fixed;
    top: 0;
    left: 0;
    height: 2px;
    z-index: 80;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
    box-shadow: 0 0 8px -1px var(--accent);
    transition: width 90ms linear;
    pointer-events: none;
  }

  .zen-stats {
    position: fixed;
    right: 20px;
    bottom: 44px;
    z-index: 35;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 6px 5px 12px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-chrome) 92%, transparent);
    color: var(--text-muted);
    font-size: 11px;
    letter-spacing: 0.01em;
    box-shadow: 0 10px 30px -16px rgb(0 0 0 / 0.35);
    backdrop-filter: blur(6px);
  }

  .zen-dot {
    opacity: 0.6;
  }

  .zen-exit {
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 10px;
    padding: 2px 8px;
    cursor: pointer;
  }

  .zen-exit:hover {
    background: var(--hover);
    color: var(--text-primary);
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    min-width: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    text-decoration: none;
    color: inherit;
    border-radius: 6px;
  }
  .brand:hover .brand-name {
    color: var(--accent);
  }
  .brand:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .brand-mark {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    flex: 0 0 auto;
  }
  .brand-mark svg {
    display: block;
    border-radius: 6px;
  }
  .brand-name {
    font-weight: 650;
    letter-spacing: -0.01em;
    font-size: 14.5px;
  }
  .grow {
    flex: 1;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border-soft);
    background: var(--panel);
    color: var(--text-muted);
    white-space: nowrap;
  }
  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .pill.saved {
    color: var(--ok-fg);
    border-color: var(--ok-border);
    background: var(--ok-bg);
  }
  .pill.unsaved {
    color: var(--warn-fg);
    border-color: var(--warn-border);
    background: var(--warn-bg);
  }
  .pill.saving {
    color: var(--info-fg);
    border-color: var(--info-border);
    background: var(--info-bg);
  }
  .pill.saving .pill-dot {
    animation: pulse 1s ease-in-out infinite;
  }
  .pill.conflict {
    color: var(--danger-fg);
    border-color: var(--danger-border);
    background: var(--danger-bg);
  }
  .pill.error {
    color: var(--danger-fg);
    border-color: var(--danger-border);
    background: var(--danger-bg);
  }
  .pill.inactive {
    opacity: 0.7;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
  }
  .export-wrap {
    position: relative;
    display: inline-flex;
  }
  .export-menu {
    position: absolute;
    right: 0;
    top: 34px;
    z-index: 170;
    min-width: 168px;
    padding: 4px;
    background: var(--bg-app);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 14px 34px -12px rgb(0 0 0 / 0.35);
  }
  .export-item {
    display: block;
    width: 100%;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    padding: 7px 9px;
    cursor: pointer;
  }
  .export-item:hover {
    background: var(--hover);
  }
  .search-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 200px;
    max-width: 560px;
    min-width: 34px;
    margin: 0 auto;
    height: 32px;
    padding: 0 11px;
    border-radius: 8px;
    border: 1px solid var(--border-soft);
    background: var(--bg-app);
    color: var(--text-muted);
    font: inherit;
    font-size: 12.5px;
    font-weight: 500;
    cursor: text;
    white-space: nowrap;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .search-trigger:hover {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }
  .search-trigger:focus-visible {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--active);
  }
  .search-trigger-label {
    flex: 1;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 1100px) {
    .search-trigger-label {
      display: none;
    }
    .toggle-btn span {
      display: none;
    }
    .toggle-btn {
      width: 30px;
      padding: 0;
      justify-content: center;
    }
  }
  @media (max-width: 820px) {
    .topbar {
      gap: 8px;
      padding: 0 8px;
    }
    .brand-name,
    .pill {
      display: none;
    }
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 7px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .icon-btn:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .icon-btn.on {
    color: var(--accent);
    background: var(--active);
  }
  .comments-btn {
    position: relative;
  }
  .comments-badge {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 9.5px;
    font-weight: 700;
    line-height: 14px;
    text-align: center;
    pointer-events: none;
  }
  .comment-hover-card {
    position: fixed;
    z-index: 95;
    width: 320px;
    max-width: calc(100vw - 24px);
    padding: 10px 12px;
    border-radius: 9px;
    border: 1px solid var(--border-strong);
    border-left-width: 3px;
    background: var(--bg-app);
    box-shadow: 0 10px 26px rgb(0 0 0 / 0.16);
    cursor: pointer;
    text-align: left;
    font: inherit;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .comment-hover-card.is-discussion {
    border-left-color: var(--warn-fg);
  }
  .comment-hover-card.is-edit {
    border-left-color: var(--info-fg);
  }
  .chc-head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .chc-pill {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .chc-pill.is-discussion {
    background: var(--warn-bg);
    color: var(--warn-fg);
    border-color: var(--warn-border);
  }
  .chc-pill.is-edit {
    background: var(--info-bg);
    color: var(--info-fg);
    border-color: var(--info-border);
  }
  .chc-author {
    font-weight: 600;
    color: var(--text-primary);
  }
  .chc-body {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 140px;
    overflow-y: auto;
  }
  .chc-replies {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 5px;
    border-top: 1px solid var(--border-soft);
    font-size: 12px;
    color: var(--text-primary);
    max-height: 110px;
    overflow-y: auto;
  }
  .chc-reply {
    line-height: 1.38;
  }
  .raw-glyph {
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: -0.04em;
  }
  .shortcut-glyph {
    font-size: 15px;
    font-weight: 700;
    line-height: 1;
  }
  .icon-btn.small {
    width: 24px;
    height: 24px;
  }
  .toolbar-sep {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--border-soft);
  }
  .quit-btn:hover {
    color: var(--danger-fg);
    background: var(--danger-bg);
  }
  .toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    white-space: nowrap;
    flex-shrink: 0;
    cursor: pointer;
  }
  .toggle-btn:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .toggle-btn.on {
    color: var(--accent);
    border-color: hsl(22 70% 82%);
    background: var(--active);
  }

  .workspace {
    position: relative;
    display: grid;
    grid-template-columns: var(--sidebar-width, 302px) minmax(0, 1fr);
    min-height: 0;
    overflow: hidden;
  }
  .workspace.collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .workspace.talk-open {
    grid-template-columns: var(--sidebar-width, 302px) minmax(0, 1fr) var(--talk-width, 350px);
  }
  .workspace.collapsed.talk-open {
    grid-template-columns: minmax(0, 1fr) var(--talk-width, 350px);
  }

  .talk-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border-left: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
  }
  .talk-resizer {
    position: absolute;
    top: 0;
    left: -4px;
    bottom: 0;
    width: 9px;
    z-index: 30;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .talk-resizer::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 2px;
    background: transparent;
    transition: background 0.12s ease;
  }
  .talk-resizer:hover::after,
  .talk-resizer:focus-visible::after,
  :global(body.resizing-talk) .talk-resizer::after {
    background: var(--accent);
  }
  :global(body.resizing-talk) {
    user-select: none;
    cursor: col-resize;
  }
  .talk-head {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 9px 10px;
    border-bottom: 1px solid var(--border-soft);
  }
  .talk-title {
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }
  .talk-agent-select {
    font: inherit;
    font-size: 11px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: var(--bg-app);
    color: var(--text-primary);
    padding: 3px 5px;
    max-width: 130px;
  }
  .talk-agent-name {
    font-size: 11px;
    color: var(--text-muted);
  }
  .talk-model {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: var(--bg-app);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.01em;
  }
  .talk-icon {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 15px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 5px;
    cursor: pointer;
  }
  .talk-icon:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .talk-modes {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 7px 10px 4px;
  }
  .talk-mode {
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    cursor: pointer;
  }
  .talk-mode.active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--active);
  }
  .talk-mode-hint {
    margin-left: auto;
    font-size: 9.5px;
    color: var(--text-muted);
  }
  .talk-context {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--active);
    color: var(--accent);
    font: inherit;
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    padding: 2px 8px;
    cursor: pointer;
  }
  .talk-context:hover {
    background: var(--hover);
  }
  .talk-quote {
    margin: 5px 0 0;
    padding: 4px 8px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--bg-app) 70%, transparent);
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1.45;
  }
  .talk-diff {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12.5px;
    line-height: 1.55;
  }
  .talk-add {
    background: var(--ok-bg);
    color: var(--ok-fg);
    border-radius: 3px;
  }
  .talk-del {
    background: var(--danger-bg);
    color: var(--danger-fg);
    text-decoration: line-through;
    border-radius: 3px;
  }
  .talk-actions {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .talk-applied {
    color: var(--ok-fg);
    font-size: 10.5px;
    font-weight: 600;
  }
  .talk-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .talk-hint,
  .talk-empty {
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.5;
    margin: 6px 2px;
  }
  .talk-empty {
    padding: 12px 14px;
  }
  .talk-empty code {
    font-family: var(--font-mono);
    font-size: 0.94em;
  }
  .talk-icon.on {
    color: var(--accent);
    background: var(--active);
  }
  .talk-diag {
    border-bottom: 1px solid var(--border-soft);
    padding: 9px 10px;
    background: var(--bg-app);
    font-size: 11.5px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .talk-diag-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .talk-diag-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .talk-diag-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .talk-diag-row.not-found {
    opacity: 0.6;
  }
  .talk-diag-row.disabled {
    opacity: 0.8;
  }
  .talk-diag-main {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .talk-diag-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--danger-fg, #dc2626);
    flex-shrink: 0;
  }
  .talk-diag-dot.ok {
    background: #16a34a;
  }
  .talk-diag-dot.testing {
    background: var(--accent);
  }
  .talk-diag-dot.missing {
    background: var(--border-strong);
  }
  .talk-diag-badge {
    font-size: 10px;
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .talk-diag-name {
    font-weight: 600;
    flex-shrink: 0;
  }
  .talk-diag-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .talk-diag-out {
    margin: 2px 0 0;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 150px;
    overflow: auto;
  }
  .talk-diag-path-env summary,
  .talk-debug summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: 11px;
    user-select: none;
  }
  .talk-debug {
    margin-top: 6px;
  }
  .talk-message {
    font-size: 12.5px;
    line-height: 1.55;
  }
  .talk-message.user {
    align-self: flex-end;
    max-width: 92%;
    padding: 6px 10px;
    border-radius: 10px 10px 3px 10px;
    background: var(--active);
    color: var(--text-primary);
  }
  .talk-message.user p {
    margin: 0;
    white-space: pre-wrap;
  }
  .talk-message.assistant {
    padding: 7px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 10px 10px 10px 3px;
    background: var(--bg-app);
  }
  .talk-markdown > :first-child {
    margin-top: 0;
  }
  .talk-markdown > :last-child {
    margin-bottom: 0;
  }
  .talk-markdown :global(p) {
    margin: 0 0 0.55em;
  }
  .talk-markdown :global(pre) {
    overflow-x: auto;
    margin: 0.5em 0;
    padding: 8px;
    border-radius: 6px;
    background: var(--panel);
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .talk-markdown :global(code) {
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  .talk-markdown :global(table) {
    border-collapse: collapse;
    font-size: 0.92em;
    margin: 0.5em 0;
  }
  .talk-markdown :global(th),
  .talk-markdown :global(td) {
    border: 1px solid var(--border-soft);
    padding: 3px 6px;
  }
  .talk-insert {
    display: inline-block;
    margin-top: 4px;
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    background: var(--panel);
    color: var(--accent);
    font: inherit;
    font-size: 10.5px;
    padding: 3px 7px;
    cursor: pointer;
  }
  .talk-insert:hover {
    border-color: var(--accent);
  }
  .talk-typing {
    color: var(--text-muted);
    font-size: 11px;
    font-style: italic;
  }
  .talk-error {
    margin: 0;
    padding: 4px 10px;
    color: var(--danger-fg);
    font-size: 11px;
  }
  .talk-selection-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 7px 10px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-app);
  }
  .talk-selection-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 10.5px;
    color: var(--text-muted);
  }
  .talk-selection-badge {
    flex: 0 0 auto;
    padding: 1px 6px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-weight: 600;
  }
  .talk-selection-preview {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .talk-selection-clear {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    padding: 1px 4px;
    border-radius: 4px;
    cursor: pointer;
  }
  .talk-selection-clear:hover {
    background: var(--hover);
    color: var(--text-primary);
  }
  .talk-selection-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .talk-selection-btn {
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: var(--panel);
    color: var(--text-primary);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 9px;
    cursor: pointer;
  }
  .talk-selection-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--active);
  }
  .talk-selection-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .talk-compose {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--border-soft);
  }
  .talk-compose textarea {
    flex: 1;
    min-width: 0;
    min-height: 58px;
    max-height: 160px;
    resize: vertical;
    border: 1px solid var(--border-soft);
    border-radius: 7px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    line-height: 1.45;
    padding: 6px 8px;
    outline: none;
  }
  .talk-compose textarea:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--active);
  }
  .talk-compose .primary {
    padding: 7px 12px;
  }
  .talk-compose .primary:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .editor-stage {
    display: grid;
    grid-template-columns: 1fr;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .editor-stage.has-split {
    grid-template-columns: 1fr 1fr;
  }
  .split-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    border-left: 1px solid var(--border-soft);
    background: var(--bg-app);
  }
  .split-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
    font-size: 12px;
  }
  .split-path {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .split-body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .split-doc {
    max-width: 780px;
    margin: 0 auto;
    padding: 32px 34px 96px;
    line-height: 1.7;
    font-size: 15.5px;
  }
  .split-doc :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0;
    font-size: 0.94em;
  }
  .split-doc :global(th),
  .split-doc :global(td) {
    border: 1px solid var(--border-soft);
    padding: 6px 10px;
    text-align: left;
  }
  .split-doc :global(th) {
    background: var(--panel);
  }
  .split-doc :global(pre) {
    padding: 12px 14px;
    border-radius: 8px;
    background: var(--panel);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.9em;
  }
  .editor-pane {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
  .editor-host {
    position: absolute;
    inset: 0;
  }
  .editor-host.wide {
    background: var(--bg-app);
  }
  .html-frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }
  .loading-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    overflow: hidden;
    background: var(--active);
  }
  .loading-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 40%;
    background: var(--accent);
    animation: slide 0.9s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(320%);
    }
  }

  .empty-state {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--bg-app);
  }
  .empty-card {
    max-width: 430px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .empty-mark {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 13px;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 24px;
    box-shadow: 0 6px 18px -8px var(--accent);
  }
  .empty-card h1 {
    margin: 0;
    font-size: 22px;
    letter-spacing: -0.02em;
  }
  .empty-card p {
    margin: 0;
    color: var(--text-muted);
    font-size: 13.5px;
    line-height: 1.6;
  }
  .empty-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  kbd {
    font-family: var(--font-mono);
    font-size: 11px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border-soft);
    background: var(--panel);
  }
  code.root-path {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--panel);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    padding: 4px 8px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sidebar {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    border-right: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
  }
  .sidebar.closed {
    display: none;
  }
  .sidebar-resizer {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 9px;
    z-index: 30;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .sidebar-resizer::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 4px;
    width: 2px;
    background: transparent;
    transition: background 0.12s ease;
  }
  .sidebar-resizer:hover::after,
  .sidebar-resizer:focus-visible::after,
  :global(body.resizing-sidebar) .sidebar-resizer::after {
    background: var(--accent);
  }
  :global(body.resizing-sidebar) {
    user-select: none;
    cursor: col-resize;
  }
  .sidebar-tabs {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 0 6px;
    border-bottom: 1px solid var(--border-soft);
    flex: 0 0 auto;
  }
  .sidebar-tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 11px 6px 9px;
    cursor: pointer;
  }
  .sidebar-tab:hover {
    color: var(--text-primary);
    background: var(--hover);
  }
  .sidebar-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .tab-count {
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    background: var(--panel);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    padding: 0 5px;
    line-height: 15px;
  }
  .sidebar-tab.active .tab-count {
    color: var(--accent);
    border-color: var(--accent);
    background: transparent;
  }

  .favorite-star {
    color: var(--text-muted);
  }
  .favorite-star.on {
    color: var(--accent);
    background: var(--active);
  }

  .favorites {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--border-soft);
    padding-bottom: 6px;
    margin-bottom: 2px;
  }
  .favorites-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 7px 12px 5px;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    cursor: pointer;
  }
  .favorites-head:hover {
    color: var(--text-primary);
  }
  .favorites-star-icon {
    color: var(--accent);
  }
  .favorites-head .chevron {
    display: inline-flex;
    transition: transform 0.14s ease;
  }
  .favorites-head .chevron.open {
    transform: rotate(90deg);
  }
  .favorites-empty {
    margin: 2px 14px 6px;
    color: var(--text-muted);
    font-size: 11.5px;
    line-height: 1.45;
  }
  .favorites-list {
    list-style: none;
    margin: 0 6px;
    padding: 0;
    max-height: 220px;
    overflow-y: auto;
  }
  .favorite-item {
    display: flex;
    align-items: center;
    position: relative;
    border-radius: 6px;
  }
  .favorite-item:hover {
    background: var(--hover);
  }
  .favorite-item.dragging {
    opacity: 0.45;
  }
  .favorite-row {
    display: flex;
    align-items: baseline;
    gap: 5px;
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    padding: 4px 24px 4px 7px;
    border-radius: 6px;
    cursor: pointer;
    overflow: hidden;
  }
  .favorite-pin {
    flex: 0 0 auto;
    color: var(--accent);
    font-size: 10px;
  }
  .favorite-name {
    color: var(--text-primary);
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .favorite-dir {
    color: var(--text-muted);
    font-size: 10.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .favorite-missing {
    margin-left: auto;
    color: var(--danger-fg);
    font-size: 9.5px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .favorite-item.missing .favorite-name {
    color: var(--text-muted);
    text-decoration: line-through;
  }
  .favorite-remove {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
  }
  .favorite-item:hover .favorite-remove,
  .favorite-item.missing .favorite-remove {
    opacity: 1;
  }
  .favorite-remove:hover {
    color: var(--danger-fg);
    background: var(--danger-bg);
  }
  .filter-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 4px;
  }
  .scope-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 8px 0;
    padding: 5px 8px;
    border: 1px solid var(--ok-border);
    border-radius: 7px;
    background: var(--ok-bg);
    color: var(--ok-fg);
    font-size: 10.5px;
  }
  .scope-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scope-label strong {
    font-family: var(--font-mono);
    font-size: 0.95em;
  }
  .scope-clear {
    border: 1px solid var(--ok-border);
    border-radius: 5px;
    background: transparent;
    color: var(--ok-fg);
    font: inherit;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    cursor: pointer;
  }
  .scope-clear:hover {
    background: var(--ok-border);
  }
  .filter-input-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .tree-filter {
    width: 100%;
    box-sizing: border-box;
    font: inherit;
    font-size: 12.5px;
    padding: 6px 26px 6px 9px;
    border-radius: 7px;
    border: 1px solid var(--border-soft);
    background: var(--bg-app);
    color: var(--text-primary);
    outline: none;
  }
  .tree-filter:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--active);
  }
  .clear-filter {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 4px;
  }
  .tree-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .outline-scroll {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 8px 6px 16px;
  }
  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .outline-item {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 12.8px;
    line-height: 1.45;
    text-align: left;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .outline-item:hover {
    background: var(--hover);
  }
  .outline-item.active {
    background: var(--active);
    color: var(--accent);
    font-weight: 600;
  }
  .outline-item.level-1 {
    font-weight: 620;
  }
  .outline-item.level-2 {
    font-weight: 560;
  }
  .outline-item.level-3,
  .outline-item.level-4,
  .outline-item.level-5,
  .outline-item.level-6 {
    color: var(--text-muted);
  }
  .outline-item.active.level-3,
  .outline-item.active.level-4,
  .outline-item.active.level-5,
  .outline-item.active.level-6 {
    color: var(--accent);
  }
  .tree-status {
    margin: 16px 14px;
    font-size: 12.5px;
    color: var(--text-muted);
  }
  .tree-status.error {
    color: var(--danger-fg);
  }
  .tree-scanning {
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.03em;
  }
  .sidebar-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-top: 1px solid var(--border-soft);
    font-size: 10.5px;    color: var(--text-muted);
  }

  .statusbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-chrome);
    font-size: 11px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .status-item {
    white-space: nowrap;
  }
  .status-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .status-file {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-primary);
  }
  .status-modified {
    flex: 0 0 auto;
    font-size: 10.5px;
  }
  .status-right {
    display: flex;
    align-items: center;
    gap: 14px;
    flex: 0 0 auto;
  }
  .status-item.error {
    color: var(--danger-fg);
  }
  .status-item.lock {
    color: var(--accent);
    font-weight: 600;
  }
  .status-update {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 7px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-weight: 600;
    text-decoration: none;
    line-height: 1.8;
  }
  .status-update:hover {
    background: var(--active);
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 44px;
    transform: translateX(-50%);
    background: var(--toast-bg);
    color: var(--toast-fg);
    font-size: 12.5px;
    padding: 9px 16px;
    border-radius: 999px;
    box-shadow: 0 10px 30px -12px rgb(0 0 0 / 0.5);
    z-index: 200;
    animation: toast-in 0.18s ease-out;
  }
  .toast.error {
    background: hsl(0 60% 38%);
    color: #fff;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
  }

  .context-menu {
    position: fixed;
    z-index: 180;
    min-width: 168px;
    padding: 4px;
    background: var(--bg-app);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 14px 34px -12px rgb(0 0 0 / 0.35);
  }
  .context-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .context-menu-item:hover {
    background: var(--hover);
  }
  .context-menu-item.danger {
    color: var(--danger-fg);
  }
  .context-menu-item.danger:hover {
    background: var(--danger-bg);
  }

  .delete-dialog {
    width: min(440px, calc(100vw - 32px));
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 14px;
    background: var(--bg-app);
    color: var(--text-primary);
    box-shadow: 0 30px 80px -24px rgb(0 0 0 / 0.5);
  }
  .delete-dialog::backdrop {
    background: rgba(26, 19, 12, 0.4);
    backdrop-filter: blur(3px);
  }
  .delete-head {
    display: flex;
    gap: 12px;
    padding: 20px 20px 8px;
  }
  .delete-head > div {
    flex: 1;
    min-width: 0;
  }
  .delete-icon {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: var(--danger-bg);
    color: var(--danger-fg);
  }
  .properties-icon {
    background: var(--panel);
    color: var(--text-primary);
    border: 1px solid var(--border-soft);
  }
  .properties-list {
    margin: 12px 0 0;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--panel);
    border: 1px solid var(--border-soft);
    display: grid;
    gap: 6px;
  }
  .properties-list > div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }
  .properties-list dt {
    color: var(--text-muted);
    font-weight: 500;
  }
  .properties-list dd {
    margin: 0;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .delete-dialog h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 650;
  }
  .delete-dialog p {
    margin: 0;
    color: var(--text-muted);
    font-size: 12.5px;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .delete-dialog code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    background: var(--panel);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text-primary);
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .delete-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 16px;
  }
  .newdoc-body {
    padding: 8px 20px 4px;
  }
  .newdoc-body input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    background: var(--bg-app);
    color: var(--text-primary);
    font: inherit;
    font-size: 14px;
    padding: 9px 11px;
    outline: none;
  }
  .newdoc-body input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--active);
  }
  .newdoc-error {
    margin: 4px 20px 0;
    color: var(--danger-fg);
    font-size: 11.5px;
  }
  .newdoc-icon {
    background: var(--ok-bg);
    color: var(--ok-fg);
  }

  .quit-modal {
    width: min(430px, calc(100vw - 40px));
    overflow: hidden;
  }
  .quit-body {
    display: flex;
    gap: 13px;
    padding: 20px 20px 8px;
  }
  .quit-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    flex: 0 0 auto;
    border-radius: 10px;
    background: var(--danger-bg);
    color: var(--danger-fg);
  }
  .quit-modal h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 650;
  }
  .quit-modal p {
    margin: 0;
    color: var(--text-muted);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .quit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 14px 16px;
  }
  .shutdown-screen {
    position: fixed;
    inset: 0;
    z-index: 300;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    background: var(--bg-app);
    color: var(--text-primary);
  }
  .shutdown-mark {
    display: grid;
    place-items: center;
    width: 50px;
    height: 50px;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 8px 22px -10px var(--accent);
  }
  .shutdown-screen h1 {
    margin: 6px 0 0;
    font-size: 22px;
    letter-spacing: -0.02em;
  }
  .shutdown-screen p {
    margin: 0;
    color: var(--text-muted);
    font-size: 13.5px;
  }

  @media (max-width: 860px) {
    .workspace {
      grid-template-columns: minmax(0, 1fr);
    }
    .sidebar {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: min(320px, 85vw);
      z-index: 40;
      box-shadow: 14px 0 40px -20px rgb(0 0 0 / 0.35);
    }
    .sidebar-resizer,
    .talk-resizer {
      display: none;
    }
    .workspace.talk-open {
      grid-template-columns: minmax(0, 1fr);
    }
    .talk-panel {
      position: absolute;
      right: 0;
      top: 0;
      bottom: 0;
      width: min(360px, 92vw);
      z-index: 45;
      box-shadow: -14px 0 40px -20px rgb(0 0 0 / 0.35);
    }
    .path-crumb {
      display: none;
    }
  }
</style>
