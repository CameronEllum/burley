<script lang="ts">
  import { onMount, tick } from 'svelte'
  import fuzzysort from 'fuzzysort'
  import { api, ConflictError, streamAgentChat, type AgentInfo, type AppSettings, type Entry, type FileData, type FlatFile } from './lib/api'
  import { createEditor, type EditorController, type SelectionInfo } from './lib/editor'
  import { countWords, decodeForEditor, defaultFormat, encodeForSave, type TextFormat } from './lib/text'
  import { baseName, dirOf, stripMdExt } from './lib/paths'
  import type { PaletteCommand } from './lib/palette'
  import { setLinkClickBehavior } from './lib/links'
import { restartLuaVM, setLuaDocument, setLuaNotifyHandler } from './lib/lua/runner'
  import { renderMarkdown, extractFencedBlocks, type FencedBlock } from './lib/markdown'
  import { buildExportHtml, downloadHtml, exportFileName, printPdf } from './lib/export'
  import SettingsModal from './components/SettingsModal.svelte'
  import ShortcutsModal from './components/ShortcutsModal.svelte'
  import { buildOutline, type OutlineItem } from './lib/outline'
  import {
    applyTheme,
    nextThemeMode,
    storeThemeMode,
    storedThemeMode,
    watchSystemTheme,
    type ThemeMode,
  } from './lib/theme'
  import FileTree from './components/FileTree.svelte'
  import SearchModal from './components/SearchModal.svelte'
  import ConflictModal from './components/ConflictModal.svelte'

  type SaveState = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'error'

  const LAST_PATH_KEY = 'burley:last-path'
  const SIDEBAR_KEY = 'burley:sidebar'
  const SIDEBAR_TAB_KEY = 'burley:sidebar-tab'
  const SIDEBAR_WIDTH_KEY = 'burley:sidebar-width'
  const WIDE_MODE_KEY = 'burley:wide-mode'
  const FAVORITES_OPEN_KEY = 'burley:favorites-open'
  const RAW_MODE_KEY = 'burley:raw-mode'
  const SCOPE_KEY = 'burley:scope'
  const ZEN_KEY = 'burley:zen'
  const SIDEBAR_MIN = 220
  const SIDEBAR_MAX = 560

  let tree = $state<Entry[]>([])
  let files = $state<FlatFile[]>([])
  let root = $state('')
  let loading = $state(true)
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
  let rawMode = $state(false)
  let zenMode = $state(false)
  let scrollProgress = $state(0)
  let settingsOpen = $state(false)
  let shortcutsOpen = $state(false)
  let agents = $state<AgentInfo[]>([])
  let talkOpen = $state(false)
  let talkAgent = $state('')
  let talkMode = $state<'ask' | 'edit'>('ask')
  let talkMessages = $state<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  let talkInput = $state('')
  let talkStreaming = $state(false)
  let talkError = $state('')
  let talkMessagesEl = $state<HTMLDivElement | null>(null)
  let talkAbort: AbortController | null = null
  let exportMenuOpen = $state(false)
  let exporting = $state(false)
  let favorites = $state<string[]>([])
  let favoritesOpen = $state(true)
  let dragFavoritePath = $state<string | null>(null)
  let treeFilter = $state('')
  let themeMode = $state<ThemeMode>(storedThemeMode())
  let cursor = $state<SelectionInfo>({ line: 1, column: 1, selectedChars: 0 })

  let searchOpen = $state(false)
  let searchInitial = $state('')
  let searchTriggerEl = $state<HTMLButtonElement | null>(null)
  let paletteAnchor = $state({ left: 0, top: 0, width: 0 })
  let restoreEditorFocus = false
  let recent = $state<string[]>([])
  let recentSaveTimer: ReturnType<typeof setTimeout> | null = null

  let conflictData = $state<FileData | null>(null)
  let conflictOpen = $state(false)

  let quitOpen = $state(false)
  let shuttingDown = $state(false)
  let contextMenu = $state<{ x: number; y: number; path: string; isDir: boolean } | null>(null)
  let pendingDelete = $state<string | null>(null)
  let deleteDialogEl = $state<HTMLDialogElement | null>(null)
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
  const eolLabel = $derived(format.eol === '\r\n' ? 'CRLF' : 'LF')
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
      exists: fileByPath.has(path),
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
      run: () => void refreshTree(),
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
      id: 'toggle-zen',
      label: zenMode ? 'Exit Zen mode' : 'Enter Zen mode',
      keywords: 'focus distraction free writing reading',
      run: toggleZenMode,
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
    wideMode = localStorage.getItem(WIDE_MODE_KEY) === '1'
    rawMode = localStorage.getItem(RAW_MODE_KEY) === '1'
    zenMode = localStorage.getItem(ZEN_KEY) === '1'
    const storedFavoritesOpen = localStorage.getItem(FAVORITES_OPEN_KEY)
    if (storedFavoritesOpen !== null) favoritesOpen = storedFavoritesOpen === '1'

    applyTheme(themeMode)
    const unwatchTheme = watchSystemTheme(() => {
      if (themeMode === 'system') applyTheme('system')
    })

    editor = createEditor(editorHost, {
      onChange: handleEditorChange,
      onSelectionChange: (info) => {
        cursor = info
      },
      onOpenPath: (path) => {
        void openFile(path)
      },
      onFiles: (files, pos) => {
        void uploadImages(files, pos)
      },
    })
    editor.setRawMode(rawMode)
    editor.setSpellcheck(spellCheck)
    editor.setZenFocus(zenMode)
    setLuaNotifyHandler((message) => flash(message))

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
    void initialLoad()

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('keydown', paletteShortcut, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('popstate', onPopState)
      unwatchTheme()
      setLuaNotifyHandler(null)
      scroller.removeEventListener('scroll', onScroll)
      if (scrollFrame) cancelAnimationFrame(scrollFrame)
      if (toastTimer) clearTimeout(toastTimer)
      if (saveTimer) clearTimeout(saveTimer)
      if (recentSaveTimer) clearTimeout(recentSaveTimer)
      editor?.destroy()
      editor = null
    }
  })

  async function initialLoad() {
    await refreshTree()
    await Promise.all([loadFavorites(), loadSettings(), loadRecent(), loadAgents()])
    const storedScope = localStorage.getItem(SCOPE_KEY)
    if (storedScope && findFolder(tree, storedScope)) scopePath = storedScope
    const params = new URLSearchParams(window.location.search)
    const requested = params.get('file') ?? ''
    const initialHash = window.location.hash.replace(/^#/, '')
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

  async function refreshTree() {
    loading = true
    try {
      const response = await api.tree()
      tree = response.tree
      files = response.files
      root = response.root
      loadError = ''
      if (scopePath && !findFolder(tree, scopePath)) {
        scopePath = null
        localStorage.removeItem(SCOPE_KEY)
      }
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
      flash(loadError, true)
    } finally {
      loading = false
    }
  }

  function applyFile(data: FileData, line?: number, headingSlug?: string) {
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
    editor?.setDoc(data.path, decoded.text)
    setLuaDocument(data.path)
    editor?.setReadOnly(readOnly)
    cursor = { line: 1, column: 1, selectedChars: 0 }
    rememberRecent(data.path)
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
      localStorage.setItem(LAST_PATH_KEY, path)
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

  async function saveNow(): Promise<boolean> {
    if (!currentPath || readOnly) return false
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
      return true
    } catch (err) {
      if (err instanceof ConflictError) {
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

  function toggleWideMode() {
    wideMode = !wideMode
    localStorage.setItem(WIDE_MODE_KEY, wideMode ? '1' : '0')
    void persistSettings()
  }

  function cycleTheme() {
    themeMode = nextThemeMode(themeMode)
    storeThemeMode(themeMode)
    applyTheme(themeMode)
    void persistSettings()
  }

  async function persistSettings() {
    try {
      await api.saveSettings({
        theme: themeMode,
        wideMode,
        markdownStyle,
        autoSave,
        ctrlClickLink,
        spellCheck,
      })
    } catch (err) {
      flash(`Could not save settings: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  function updateSetting(patch: Partial<AppSettings>) {
    if (patch.theme) {
      themeMode = patch.theme
      storeThemeMode(themeMode)
      applyTheme(themeMode)
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
    void persistSettings()
  }

  function toggleRawMode() {
    rawMode = !rawMode
    localStorage.setItem(RAW_MODE_KEY, rawMode ? '1' : '0')
    editor?.setRawMode(rawMode)
  }

  function toggleZenMode() {
    zenMode = !zenMode
    localStorage.setItem(ZEN_KEY, zenMode ? '1' : '0')
    editor?.setZenFocus(zenMode)
    if (zenMode) {
      talkOpen = false
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
        wideMode = response.settings.wideMode
        markdownStyle = response.settings.markdownStyle
        autoSave = response.settings.autoSave
        ctrlClickLink = response.settings.ctrlClickLink
        spellCheck = response.settings.spellCheck
        applyTheme(themeMode)
        storeThemeMode(themeMode)
        localStorage.setItem(WIDE_MODE_KEY, wideMode ? '1' : '0')
        setLinkClickBehavior(ctrlClickLink)
        editor?.setSpellcheck(spellCheck)
      } else {
        // First run on this EC2 host: migrate local browser preferences.
        await api.saveSettings({
          theme: themeMode,
          wideMode,
          markdownStyle,
          autoSave,
          ctrlClickLink,
          spellCheck,
        })
      }
    } catch (err) {
      flash(`Could not load settings: ${err instanceof Error ? err.message : String(err)}`, true)
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
    if (uploaded > 0) flash(`Uploaded ${uploaded} image${uploaded === 1 ? '' : 's'}`)
  }

  async function loadAgents() {    try {
      const response = await api.agents()
      agents = response.agents.filter((agent) => agent.available)
      if (!talkAgent && agents.length > 0) talkAgent = agents[0].id
    } catch (err) {
      flash(`Could not detect CLI agents: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  function toggleTalk() {
    talkOpen = !talkOpen
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
    talkMessages = []
    talkError = ''
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

  async function sendTalk() {    const prompt = talkInput.trim()
    if (!prompt || talkStreaming || !talkAgent) return
    const history = talkMessages.slice(-8).map((message) => ({
      role: message.role,
      content: message.content,
    }))
    const selection = editor?.getSelection() ?? ''
    talkMessages = [...talkMessages, { role: 'user', content: prompt }]
    talkInput = ''
    talkMessages = [...talkMessages, { role: 'assistant', content: '' }]
    const assistantIndex = talkMessages.length - 1
    talkStreaming = true
    talkError = ''
    talkAbort = new AbortController()
    try {
      await streamAgentChat(
        {
          agent: talkAgent,
          prompt,
          path: currentPath,
          mode: talkMode,
          selection,
          history,
        },
        (event, data) => {
          if (event === 'delta' && typeof data.text === 'string') {
            const messages = [...talkMessages]
            messages[assistantIndex] = {
              role: 'assistant',
              content: messages[assistantIndex].content + data.text,
            }
            talkMessages = messages
          } else if (event === 'done' && data.file?.content) {
            editor?.replaceAll(data.file.content)
            flash('Agent updated the note')
          } else if (event === 'error') {
            talkError = data.message ?? 'Agent failed'
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
      talkAbort = null
    }
  }

  $effect(() => {
    talkMessages
    talkStreaming
    const element = talkMessagesEl
    if (element) element.scrollTop = element.scrollHeight
  })

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
    const width = 210
    const height = scopePath ? 100 : 48
    contextMenu = {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      path,
      isDir,
    }
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

  function handleWindowPointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement | null
    if (exportMenuOpen && !target?.closest('.export-wrap')) exportMenuOpen = false
    if (!contextMenu) return
    if (target?.closest('.context-menu')) return
    contextMenu = null
  }
  async function requestDelete() {
    const path = contextMenu?.path
    contextMenu = null
    if (!path) return
    pendingDelete = path
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
      await refreshTree()
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
    const path = pendingDelete
    if (!path) return
    try {
      await api.deleteFile(path)
      closeDeleteDialog()
      if (favorites.includes(path)) await persistFavorites(favorites.filter((entry) => entry !== path))
      await refreshTree()
      if (currentPath === path) clearCurrentFile()
      flash(`Deleted ${path}`)
    } catch (err) {
      flash(`Could not delete ${path}: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  function clearCurrentFile() {
    currentPath = ''
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
    if (event.altKey && event.key.toLowerCase() === 't') {
      event.preventDefault()
      talkOpen = !talkOpen
      return
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
      void refreshTree()
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
      <div class="brand" title="Burley">
        <span class="brand-mark" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="26" height="26" fill="none">
            <rect width="32" height="32" rx="7" fill="#c2410c" />
            <rect x="6" y="7" width="13" height="4.5" rx="2.25" fill="#fff7ed" />
            <rect x="12" y="13.75" width="14" height="4.5" rx="2.25" fill="#fff7ed" opacity="0.85" />
            <rect x="6" y="20.5" width="13" height="4.5" rx="2.25" fill="#fff7ed" />
          </svg>
        </span>
        <span class="brand-name">Burley</span>
      </div>

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
          </div>
        {/if}
      </div>
      <button class="icon-btn talk-btn" class:on={talkOpen} title="Talk to an AI agent (Alt+T)" aria-label="Toggle Talk panel" onclick={toggleTalk}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M3 4.2h14v9.1H8.4L4.9 16v-2.7H3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M6.4 8.7h7.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /></svg>
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
      <button class="icon-btn" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (Ctrl+?)" onclick={() => (shortcutsOpen = true)}>
        <span class="shortcut-glyph" aria-hidden="true">?</span>
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

  <main class="workspace" class:collapsed={!sidebarOpen || zenMode} class:talk-open={talkOpen} class:zen={zenMode} style={`--sidebar-width: ${sidebarWidth}px`}>
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
        {#if scopePath}
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
              title="Filter favorites and notes"
              spellcheck="false"
              bind:value={treeFilter}
            />
            {#if treeFilter}
              <button class="clear-filter" aria-label="Clear filter" onclick={() => (treeFilter = '')}>×</button>
            {/if}
          </div>
          <button
            class="icon-btn small"
            title="Reload folder (Ctrl+Shift+R)"
            aria-label="Reload folder"
            onclick={() => void refreshTree()}
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
                        onclick={() => favorite.exists && void openFile(favorite.path)}
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

        <div class="tree-scroll">
          {#if loading && files.length === 0}
            <p class="tree-status">Loading…</p>
          {:else if loadError}
            <p class="tree-status error">{loadError}</p>
          {:else}
            <FileTree
              entries={treeEntries}
              selectedPath={currentPath}
              filter={treeFilter}
              favorites={favorites}
              ontogglefavorite={(path) => toggleFavorite(path)}
              oncontext={showContextMenu}
              onselect={(path) => void openFile(path)}
            />
          {/if}
        </div>

        <div class="sidebar-foot">
          <span>{files.length} note{files.length === 1 ? '' : 's'}</span>
          <span class="grow"></span>
          <span title="Autosave after 1.5s of inactivity">autosave on</span>
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


    <section class="editor-pane">
      <div
        class="editor-host"
        class:wide={wideMode}
        class:raw={rawMode}
        data-md-style={markdownStyle}
        bind:this={editorHost}
        style={`--editor-measure: ${zenMode ? '760px' : wideMode ? '1200px' : '820px'}; --editor-gutter: ${zenMode ? '32px' : wideMode ? '28px' : '48px'}`}
      ></div>

      {#if !currentPath}
        <div class="empty-state">
          <div class="empty-card">
            <span class="empty-mark">B</span>
            <h1>Burley</h1>
            <p>
              {#if files.length}
                Pick a note from the sidebar, or press <kbd>Ctrl P</kbd> to jump to one.
              {:else}
                No Markdown files were found in this folder. Start the server with <code>--root</code> pointing at your
                notes.
              {/if}
            </p>
            <div class="empty-actions">
              <button class="primary" onclick={() => openSearch('')}>Open a note</button>
              <button class="secondary" onclick={() => void refreshTree()}>Reload folder</button>
            </div>
            {#if root}<code class="root-path">{root}</code>{/if}
          </div>
        </div>
      {/if}

      {#if loadingFile}
        <div class="loading-bar" role="status" aria-label="Loading note"></div>
      {/if}
    </section>

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
          <span class="grow"></span>
          <button class="talk-icon" title="New chat" aria-label="New chat" onclick={newTalkChat}>+</button>
          <button class="talk-icon" title="Close Talk" aria-label="Close Talk" onclick={() => (talkOpen = false)}>×</button>
        </header>

        {#if agents.length === 0}
          <p class="talk-empty">
            No supported CLI agents were found on this server. Install <code>claude</code>,
            <code>codex</code>, <code>gemini</code>, or <code>opencode</code> and reload.
          </p>
        {:else}
          <div class="talk-modes">
            <button class="talk-mode" class:active={talkMode === 'ask'} onclick={() => (talkMode = 'ask')}>Ask</button>
            <button class="talk-mode" class:active={talkMode === 'edit'} onclick={() => (talkMode = 'edit')}>Edit</button>
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
              <div class="talk-message {message.role}">
                {#if message.role === 'assistant'}
                  <div class="talk-markdown">{@html renderMarkdown(message.content)}</div>
                  {#each extractFencedBlocks(message.content) as block, blockIndex (blockIndex)}
                    <button class="talk-insert" onclick={() => insertTalkBlock(block)}>
                      Insert {block.lang || 'code'} at cursor
                    </button>
                  {/each}
                {:else}
                  <p>{message.content}</p>
                {/if}
              </div>
            {/each}
            {#if talkStreaming}<span class="talk-typing">Working…</span>{/if}
          </div>

          {#if talkError}<p class="talk-error">{talkError}</p>{/if}

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
      <span class="status-item" title="Line endings preserved on save">{eolLabel}</span>
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
    files={files}
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
      <button class="context-menu-item danger" role="menuitem" onclick={() => void requestDelete()}>
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path d="M4.5 6h11M8 6V4.2h4V6M6 6l.7 10h6.6L14 6M8.5 9v4.5M11.5 9v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
        <span>Delete</span>
      </button>
    {/if}
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
      <h2 id="delete-title">Delete note?</h2>
      <p>
        <code>{pendingDelete}</code> will be permanently deleted from this vault. This cannot be undone.
      </p>
    </div>
  </div>
  <div class="delete-actions">
    <button class="secondary" onclick={closeDeleteDialog}>Cancel</button>
    <button class="danger" onclick={() => void confirmDelete()}>Delete</button>
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
    settings={{ theme: themeMode, wideMode, markdownStyle, autoSave, ctrlClickLink, spellCheck }}
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
    <span class="shutdown-mark">B</span>
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 560px) minmax(0, 1fr);
    align-items: center;
    gap: 14px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
  }
  .topbar-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
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
    justify-self: end;
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
    display: flex;    align-items: center;
    gap: 8px;
    width: 100%;
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
    justify-self: center;
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
      grid-template-columns: auto minmax(0, 1fr) auto;
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
    grid-template-columns: var(--sidebar-width, 302px) minmax(0, 1fr) 350px;
  }
  .workspace.collapsed.talk-open {
    grid-template-columns: minmax(0, 1fr) 350px;
  }

  .talk-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border-soft);
    background: var(--bg-sidebar);
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
    z-index: 20;
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
  .sidebar-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-top: 1px solid var(--border-soft);
    font-size: 10.5px;
    color: var(--text-muted);
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
  }
  .delete-dialog code {
    font-family: var(--font-mono);
    font-size: 0.95em;
    background: var(--panel);
    padding: 1px 5px;
    border-radius: 4px;
    color: var(--text-primary);
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
    border-radius: 14px;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 25px;
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
    .sidebar-resizer {
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
