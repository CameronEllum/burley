<script lang="ts">
  import { onMount } from 'svelte'
  import { api, ConflictError, type Entry, type FileData, type FlatFile } from './lib/api'
  import { createEditor, type EditorController, type SelectionInfo } from './lib/editor'
  import { countWords, decodeForEditor, defaultFormat, encodeForSave, type TextFormat } from './lib/text'
  import { baseName, dirOf } from './lib/paths'
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
  const SIDEBAR_MIN = 220
  const SIDEBAR_MAX = 560

  let tree = $state<Entry[]>([])
  let files = $state<FlatFile[]>([])
  let root = $state('')
  let loading = $state(true)
  let loadError = $state('')

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
  let treeFilter = $state('')
  let themeMode = $state<ThemeMode>(storedThemeMode())
  let cursor = $state<SelectionInfo>({ line: 1, column: 1, selectedChars: 0 })

  let searchOpen = $state(false)
  let searchMode = $state<'files' | 'content'>('files')

  let conflictData = $state<FileData | null>(null)
  let conflictOpen = $state(false)

  let quitOpen = $state(false)
  let shuttingDown = $state(false)

  let toast = $state('')
  let toastError = $state(false)

  let editorHost: HTMLDivElement
  let editor: EditorController | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let saving = false
  let saveQueued = false
  let toastTimer: ReturnType<typeof setTimeout> | null = null

  const words = $derived(countWords(content))
  const fileLabel = $derived(currentPath ? baseName(currentPath) : '')
  const dirLabel = $derived(currentPath ? dirOf(currentPath) : '')
  const eolLabel = $derived(format.eol === '\r\n' ? 'CRLF' : 'LF')
  const outline = $derived(buildOutline(content))
  const activeHeadingLine = $derived.by(() => {
    let line = 0
    for (const item of outline) {
      if (item.line <= cursor.line) line = item.line
      else break
    }
    return line
  })
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
  const themeLabel = $derived(
    themeMode === 'system' ? 'Theme: follow system' : themeMode === 'light' ? 'Theme: light' : 'Theme: dark',
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
    })

    window.addEventListener('beforeunload', handleBeforeUnload)
    void initialLoad()

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      unwatchTheme()
      if (toastTimer) clearTimeout(toastTimer)
      if (saveTimer) clearTimeout(saveTimer)
      editor?.destroy()
      editor = null
    }
  })

  async function initialLoad() {
    await refreshTree()
    const stored = localStorage.getItem(LAST_PATH_KEY)
    const target =
      files.find((file) => file.path === stored)?.path ??
      files.find((file) => !file.path.includes('/'))?.path ??
      files[0]?.path
    if (target) await openFile(target)
  }

  async function refreshTree() {
    loading = true
    try {
      const response = await api.tree()
      tree = response.tree
      files = response.files
      root = response.root
      loadError = ''
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err)
      flash(loadError, true)
    } finally {
      loading = false
    }
  }

  function applyFile(data: FileData, line?: number) {
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
    editor?.setReadOnly(readOnly)
    cursor = { line: 1, column: 1, selectedChars: 0 }
    if (line) {
      setTimeout(() => editor?.scrollToLine(line), 0)
    }
  }

  async function openFile(path: string, line?: number) {
    if (!path) return
    if (path === currentPath) {
      if (line) editor?.scrollToLine(line)
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
      applyFile(data, line)
      localStorage.setItem(LAST_PATH_KEY, path)
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
    if (saveState === 'conflict' || readOnly) return
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

  function jumpToOutline(item: OutlineItem) {
    editor?.scrollToLine(item.line)
  }

  function cycleTheme() {
    themeMode = nextThemeMode(themeMode)
    storeThemeMode(themeMode)
    applyTheme(themeMode)
  }

  function requestQuit() {
    quitOpen = true
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

  function openSearch(mode: 'files' | 'content') {
    searchMode = mode
    searchOpen = true
  }

  function closeSearch() {
    searchOpen = false
    editor?.focus()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && quitOpen) {
      event.preventDefault()
      quitOpen = false
      return
    }
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 'p' && !event.shiftKey) {
      event.preventDefault()
      openSearch('files')
    } else if (key === 'f' && event.shiftKey) {
      event.preventDefault()
      openSearch('content')
    } else if (key === 's') {
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

  function flash(message: string, error = false) {
    toast = message
    toastError = error
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast = ''
    }, 2800)
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="app-shell">
  <header class="topbar">
    <div class="brand" title="Burley">
      <span class="brand-mark">B</span>
      <span class="brand-name">Burley</span>
    </div>

    <div class="path-crumb">
      {#if currentPath}
        {#if dirLabel}<span class="crumb-dir">{dirLabel}/</span>{/if}
        <span class="crumb-file">{fileLabel}</span>
        {#if modTime}<span class="crumb-time">{new Date(modTime).toLocaleTimeString()}</span>{/if}
      {:else}
        <span class="crumb-file muted">No note open</span>
      {/if}
    </div>

    <span class="grow"></span>

    <span class="pill {saveState}" class:inactive={!currentPath} title={saveError || saveLabel}>
      <span class="pill-dot"></span>
      {currentPath ? saveLabel : 'Ready'}
    </span>

    <div class="toolbar">
      <button class="icon-btn" title="Quick open (Ctrl+P)" aria-label="Quick open" onclick={() => openSearch('files')}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.2" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M12.4 12.4L16.5 16.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button class="icon-btn" title="Search content (Ctrl+Shift+F)" aria-label="Search content" onclick={() => openSearch('content')}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M3 5h14M3 10h9M3 15h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
      </button>
      <button
        class="icon-btn"
        class:on={themeMode !== 'system'}
        title={`${themeLabel} — click to change`}
        aria-label={themeLabel}
        onclick={cycleTheme}
      >
        {#if themeMode === 'system'}
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><rect x="2.8" y="4" width="14.4" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M7.4 16.2h5.2M10 13.6v2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        {:else if themeMode === 'light'}
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><circle cx="10" cy="10" r="3.4" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M10 2.2v1.6M10 16.2v1.6M2.2 10h1.6M16.2 10h1.6M4.5 4.5l1.1 1.1M14.4 14.4l1.1 1.1M15.5 4.5l-1.1 1.1M5.6 14.4l-1.1 1.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
        {:else}
          <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M15.8 12.4A6.4 6.4 0 0 1 7.6 4.2a6.4 6.4 0 1 0 8.2 8.2z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
        {/if}
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
      <span class="toolbar-sep" aria-hidden="true"></span>
      <button class="icon-btn quit-btn" title="Quit Burley (stops the local server)" aria-label="Quit Burley" onclick={requestQuit}>
        <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true"><path d="M10 2.6v6.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /><path d="M6.1 5.1a6.1 6.1 0 1 0 7.8 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>
      </button>
    </div>
  </header>

  <main class="workspace" class:collapsed={!sidebarOpen} style={`--sidebar-width: ${sidebarWidth}px`}>
    <aside class="sidebar" class:closed={!sidebarOpen} aria-label="Sidebar">
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
        <div class="filter-wrap">
          <div class="filter-input-wrap">
            <input class="tree-filter" placeholder="Filter notes…" spellcheck="false" bind:value={treeFilter} />
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

        <div class="tree-scroll">
          {#if loading && files.length === 0}
            <p class="tree-status">Loading…</p>
          {:else if loadError}
            <p class="tree-status error">{loadError}</p>
          {:else}
            <FileTree
              entries={tree}
              selectedPath={currentPath}
              filter={treeFilter}
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
      <div class="editor-host" bind:this={editorHost}></div>

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
              <button class="primary" onclick={() => openSearch('files')}>Open a note</button>
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
  </main>

  <footer class="statusbar">
    <span class="status-item root" title={root}>{root || '—'}</span>
    <span class="grow"></span>
    {#if saveError}<span class="status-item error">{saveError}</span>{/if}
    <span class="status-item" title="Line endings preserved on save">{eolLabel}</span>
    <span class="status-item">{words} words</span>
    <span class="status-item">Ln {cursor.line}, Col {cursor.column}</span>
    {#if readOnly}<span class="status-item lock">Read-only</span>{/if}
  </footer>
</div>

{#if searchOpen}
  {#key searchMode}
    <SearchModal
      initialMode={searchMode}
      files={files}
      onclose={closeSearch}
      onopen={(path, line) => {
        searchOpen = false
        void openFile(path, line)
      }}
    />
  {/key}
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

  .topbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 14px 0 18px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
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
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--accent);
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.12);
  }
  .brand-name {
    font-weight: 650;
    letter-spacing: -0.01em;
    font-size: 14.5px;
  }
  .path-crumb {
    display: flex;
    align-items: baseline;
    gap: 2px;
    min-width: 0;
    font-size: 12.5px;
    padding-left: 10px;
    border-left: 1px solid var(--border-soft);
  }
  .crumb-dir {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .crumb-file {
    color: var(--text-primary);
    font-weight: 550;
    white-space: nowrap;
  }
  .crumb-file.muted {
    color: var(--text-muted);
    font-weight: 400;
  }
  .crumb-time {
    color: var(--text-muted);
    font-size: 11px;
    margin-left: 8px;
    font-variant-numeric: tabular-nums;
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
  .filter-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 4px;
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
  .status-item.root {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 46ch;
    font-family: var(--font-mono);
    font-size: 10.5px;
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
    .path-crumb {
      display: none;
    }
  }
</style>
