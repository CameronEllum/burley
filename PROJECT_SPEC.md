# Burley — Architecture & Build Guide

A fast, lightweight, Obsidian-style Markdown viewer and live-preview editor for remote `.md` folders hosted on an EC2 instance.

---

## 1. Goals & Design Philosophy

- **Folder-first, zero lock-in:** Operates directly on plain `.md` files in existing EC2 directories. No proprietary database, no hidden `.obsidian`/`.space` metadata folders required.
- **Not raw Markdown at rest:** Uses **CodeMirror 6 Live Preview** (`codemirror-live-markdown`)—headings, bold/italics, links, tables, math, and plots render inline, revealing raw Markdown syntax *only* when the cursor enters that element.
- **Lossless edits:** Because CodeMirror 6 edits the underlying plain-text buffer directly (unlike true WYSIWYG DOM editors such as Vditor/TipTap), saving a file never reformats untouched lines, list markers, or whitespace.
- **Single-binary deployment:** A small Go backend embeds the compiled frontend (`//go:embed`), compiling to a single executable with zero runtime dependencies.

---

## 2. Requirements

### Functional Requirements
1. **Remote EC2 File Access:** Read, browse, and edit `.md` files stored in folders on an EC2 server (via a lightweight Go server on EC2 accessed over an SSH tunnel, or via SFTP from a local client).
2. **Left-Pane File Tree & Outline:** Collapsible directory tree of `.md` files (and optional assets) docked in the **left** sidebar, with a Typora-style **Files | Outline** tab bar at the top so each panel gets full height. The Outline tab lists the current note's headings and jumps to them. The sidebar divider is draggable (220–560 px, persisted; arrow keys adjust, double-click resets).
3. **Quick-Open Palette (`Ctrl+P` / `F1`):**
   - Single palette for files, headings, commands, and content. Empty query shows favorites first, a divider, then recent files (last 8) or the first 10 notes. Typing fuzzy-matches full paths and highlights matched characters; the no-match row offers "Search inside file contents".
   - Prefix modes: `@` current-note headings, `>` commands (read-only, sidebar, favorite, refresh, width, theme), `?` full-text search (120 ms debounce + `AbortController`). `Ctrl+Shift+O` opens `@`, `Ctrl+Shift+F` opens `?`.
   - Keyboard: `↑`/`↓` or `Ctrl+N`/`Ctrl+J`/`Ctrl+K`, `Enter` to open, `Ctrl+Enter` to open a file in a new tab, `Esc`/backdrop to close and restore editor focus. Recent files are stored in `.burley/recent.yaml` (max 10) via `GET`/`PUT /api/recent`; stale paths are filtered against `/api/tree`.
4. **Live-Preview Markdown Rendering & Editing:**
   - Headings, emphasis, lists, task checkboxes, links, blockquotes, tables, and code blocks rendered inline.
   - Fenced code blocks are syntax-highlighted with highlight.js when displayed and switch to a monospace source font while editing.
   - Tables are editable in place: contenteditable cells, Tab/Shift+Tab and arrow navigation, add/remove rows and columns, and per-column alignment; serialization rewrites only the table range.
   - Bullets and ordered-list numbers stay visible while unfocused (nested bullets use •/◦/▪).
   - Rendered links open on click; **Ctrl/Cmd-click** places the caret inside the link source so it can be edited.
   - Optional one-click **Read-Only / Lock** mode (`EditorView.editable.of(false)`) to browse without revealing syntax on click.
5. **Math / Equations:** Inline (`$...$`) and block (`$$...$$`) LaTeX math rendered with **KaTeX**.
6. **Specialized Content Blocks (Plugins):** Extensible fenced code-block renderer starting with **`plotly`** (```` ```plotly ````), supporting inline JSON specs and relative data files (e.g., `src: ./data/results.json`).
7. **Safe Saves:**
   - Atomic writes (write to temporary file, then rename).
   - Conflict detection via modification time (`mtime`) + content hash before overwriting.
   - Debounced autosave with clear status indicator (`Saved`, `Saving...`, `Unsaved`, `Conflict`).
   - Preserve original line endings (`LF` vs `CRLF`) and trailing newlines.
8. **Relative Assets:** Render relative images (`![](img/plot.png)`) and load relative data files securely from the EC2 folder.
9. **Local Lifecycle Controls:**
   - A **Quit** button (`POST /api/quit`) that gracefully stops the server and shows a "Burley has stopped" overlay.
   - **Automatic port increment:** if the preferred port is busy, try the next 20 ports, then an OS-assigned port; log the URL actually used.
10. **Theme:** Follows the OS light/dark preference by default, with a top-bar **system → light → dark** toggle that overrides it.
11. **Reading Width:** A top-bar narrow/wide toggle expands the editor measure from `820px` to `1200px` and tightens the gutters; the choice is persisted in `.burley/settings.yaml`.
12. **Favorites:** Star notes from the top bar or by hovering tree rows. Favorites appear in a collapsible section above the file tree, are filtered by the single **Filter notes…** box (which also filters the tree), and come first in an empty `Ctrl+P` query. They live in `.burley/favorites.yaml` in the vault root — YAML, vault-relative, display order preserved — and are exposed through `GET`/`PUT /api/favorites`. Missing files are shown dimmed with a remove button. A thin divider separates the pinned section from the folder tree.
13. **Cross-device settings:** Theme (`system`/`light`/`dark`) and reading width (`wideMode`) are stored in `.burley/settings.yaml` and exposed via `GET`/`PUT /api/settings`. `localStorage` is still used for an instant first paint, then reconciled with the server.
14. **Recents:** The last 10 opened files are stored most-recent-first in `.burley/recent.yaml` via `GET`/`PUT /api/recent`, powering the palette's recent group across devices.
15. **Delete with confirmation:** Right-click a file in the left tree for a context menu with **Delete**. Deletion asks for confirmation in a native HTML `<dialog>`, permanently removes the note through `DELETE /api/file`, refreshes the tree, clears the editor if the open note was deleted, and removes it from favorites.
16. **URL deep links & history:** The open file and active heading are mirrored in the URL (`?file=notes/run1.md#loss-curve`). Opening a file pushes a history entry, the heading hash updates as the cursor moves, and Back/Forward restore both the file and heading. Deep links are bookmarkable and survive reloads.
17. **Settings page:** A gear button opens a two-tab dialog. **Behaviour:** auto-save on/off and Ctrl/Cmd-click on links (toggle Markdown vs open). **Appearance:** theme (system/light/dark), reading width (narrow/wide) and Markdown style (`Default`, `GitHub`, `Academic`, `Compact`). Everything is stored in `.burley/settings.yaml`.
18. **Raw Markdown mode:** A `</>` top-bar toggle (and palette command) disables the live-preview extensions inside a CodeMirror compartment, keeping the same document, cursor, scroll and undo history. Raw mode uses a monospace source font.
19. **Escape exits elements:** Pressing `Escape` with the caret inside math, a link, inline code, a fenced block, table or heading moves the caret out so the rendered element returns.
20. **Talk panel (CLI agents):** `GET /api/agents` auto-detects `claude`, `codex`, `gemini`, and `opencode` via `exec.LookPath`. A hidden right-side Talk panel (Alt+T or the chat button) streams answers over SSE in Ask or Edit mode, sends the current file/selection plus recent turns, renders Markdown + KaTeX, offers insert-at-cursor for code fences, and applies Edit-mode file changes as one CodeMirror transaction.
21. **Shortcut sheet:** `Ctrl+?` works globally; plain `?` opens it when focus is not in CodeMirror/an input/contenteditable; a `?` top-bar button offers mouse discovery.
22. **HTML/PDF export:** The export menu renders the current note with Markdown/KaTeX, inlines relative images as data URIs, rasterizes Plotly blocks to self-contained SVG images, inlines CSS and KaTeX fonts, and downloads a standalone `.html`. PDF uses the same document in a hidden iframe with `@page` print CSS and the browser's Save-as-PDF dialog.
23. **YAML properties card:** A leading `---` frontmatter block is replaced by an Obsidian-style **Properties** card while the cursor is outside it. Rows show `key: value`; sequences (`tags`, `aliases`, reviewers) render as chips, tag keys as `#tag` pills, nested maps as indented sub-rows, and URLs as links. Clicking a row or **Edit** moves the caret to that YAML line and reveals the raw block in a monospace source style; leaving the block folds it back. Unparsable lines are shown verbatim.
24. **Folder scoping:** Right-clicking a folder offers **Scope to here**, which restricts the Files tab (and its filter footer) to that subtree and shows a banner naming the scope. **Unscope** (banner button or folder menu) restores the whole vault. The scope is stored in `localStorage` and dropped automatically if the folder disappears.
25. **Add document:** Right-clicking a folder (or the tree background) opens an **Add document** dialog. The name is validated and `.md` is appended when absent, the note is created through `PUT /api/file` (never overwriting an existing file), the tree refreshes, and the new note opens.
26. **Image paste & drop:** Pasting a clipboard image or dropping an image file into the editor uploads it with `POST /api/asset?path=<note>`, which stores it in a sibling `<noteBase>_assets/` folder (sanitized, de-duplicated names, MIME whitelist, 32 MB cap). The response's note-relative `ref` is inserted as `![alt](<note>_assets/name.png)` at the caret or drop position.
27. **Spellcheck:** The Behaviour tab toggles native browser spellchecking. When enabled, the editor sets `spellcheck="true"` and decorations mark code fences, inline code, math, HTML and link URLs with `spellcheck="false"` so they are not flagged.
28. **Lua live cells (`lua-run`):** A fenced ```` ```lua-run ```` block keeps its source visible and adds a compact **▶ Run** button on the opening fence plus a block output panel after the closing fence. Lua 5.4 runs in a dedicated Web Worker via bundled `wasmoon` WASM: no DOM, `localStorage`, `os`, `io` or `package` access, and the host enforces a 5 s timeout by terminating and recreating the worker. One VM is kept per open note so later cells reuse helpers and globals; outputs are ephemeral (never written to the `.md`). A read-only `vault` table exposes `list(prefix?)`, `read(path)` and `search(query)` over the existing `/api/*` endpoints, and `burley.notify()` raises a toast. Return values marshal as text, `{markdown=…}` through the KaTeX pipeline, `{table={headers,rows}}`, `{json=…}`, or sanitized `{html=…}`; the `>` palette offers **Restart Lua VM**.

### Non-Functional Requirements
- **Cross-platform client:** Runs in any modern browser (macOS, Windows, Linux) over `ssh -L` (or Tailscale/HTTPS), with an optional **Wails** wrapper later if a native desktop window is desired.
- **Offline-bundled frontend assets:** Bundle KaTeX fonts/CSS and `plotly.js-dist-min` inside the app—never depend on public CDNs.
- **Security:**
  - Strict path-traversal protection on all file/asset endpoints (all paths canonicalized and verified to stay inside the configured root folder).
  - Bind to `127.0.0.1` by default so access is gated by SSH.
  - Optional sandboxed `<iframe>` isolation for third-party/untrusted code-block plugins.

---

## 3. Recommended Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| **Backend** | **Go** (`net/http`, `embed`) | Single static binary, trivial cross-compilation, fast filesystem & subprocess (`rg`) handling, mature `x/crypto/ssh` + `pkg/sftp` if SFTP mode is added later. |
| **Frontend Shell** | **Svelte + Vite + TypeScript** | Minimal boilerplate, compiles to tiny static assets, clean state management for the left-pane tree, search modal, conflict dialog, theme switch, and status bar. |
| **Editor & Live Preview** | **CodeMirror 6** + **`codemirror-live-markdown`** | Lossless plain-text buffer, Obsidian-style syntax hiding, built-in KaTeX math support, modular extensions. |
| **Custom Blocks** | CM6 `StateField` + `WidgetType` + **`plotly.js-dist-min`** | Multi-line block replacement when cursor is outside the fence; lazy-loaded Plotly bundle. |
| **Fuzzy Search** | **`fuzzysort`** (client) + **`ripgrep` (`rg`)** (backend) | Zero-latency filename filtering in browser + fast server-side content search. |

---

## 4. Architecture

### 4.1 Deployment Topology

**Primary (Recommended): Go Server on EC2 + SSH Tunnel**
```text
[Laptop Browser]  <── http://localhost:8080 ──>  [SSH Tunnel: ssh -L 8080:localhost:8080 ec2]
                                                            │
                                                            ▼
                                              [EC2: burley server (127.0.0.1:8080)]
                                                ├── //go:embed static Svelte/CM6 bundle
                                                ├── LocalVault (os/filepath) ──> /path/to/md/folders
                                                └── ripgrep (rg --json) for content search
```
*Why this is best:* Disk reads, tree walks, and `ripgrep` run directly on the EC2 filesystem with zero SFTP round-trip overhead.

**Alternative (Zero-Install on EC2): Local Go Server + SFTP**
By putting filesystem operations behind a Go `Vault` interface, you can later add an `SshVault` (`golang.org/x/crypto/ssh` + `github.com/pkg/sftp`) that runs the exact same HTTP API on your laptop and talks to EC2 over SSH/SFTP.

### 4.2 Repository Layout

```text
2026-11-13_-_Burley_Markdown_Viewer/
├── cmd/
│   └── server/
│       └── main.go              # CLI flags (--root, --addr), HTTP server, //go:embed dist
├── internal/
│   ├── vault/
│   │   ├── vault.go             # Vault interface, Entry, FileContent, ConflictError
│   │   ├── local.go             # LocalVault implementation (atomic writes, path safety)
│   │   ├── assets.go            # Image uploads into <note>_assets/
│   │   ├── favorites.go         # YAML favorites at .burley/favorites.yaml
│   │   ├── settings.go          # YAML settings at .burley/settings.yaml
│   │   └── recent.go            # YAML recents at .burley/recent.yaml
│   └── api/
│       └── handlers.go          # REST handlers (/api/tree, /api/file, /api/search, /api/asset)
├── web/                         # Vite + Svelte + TypeScript frontend
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── App.svelte           # 2-pane layout (tree left, editor right) + status bar
│       ├── lib/
│       │   ├── api.ts           # Typed fetch wrappers + AbortController support
│       │   ├── editor.ts        # CodeMirror 6 setup + codemirror-live-markdown
│       │   ├── blockPlugins.ts  # Generic StateField/WidgetType plugin registry
│       │   ├── frontmatter.ts   # YAML properties card (fold/unfold in place)
│       │   ├── luaCells.ts      # lua-run Run buttons + output widgets
│       │   ├── lua/
│       │   │   ├── worker.ts    # wasmoon VM in a Web Worker (sandbox + vault bridge)
│       │   │   └── runner.ts    # Worker host: queue, 5 s timeout, state effects
│       │   ├── spellcheck.ts    # Exclude code/math from native spellcheck
│       │   ├── outline.ts       # Heading extraction for the Outline tab
│       │   ├── theme.ts         # system/light/dark theme handling
│       │   └── plugins/
│       │       └── plotly.ts    # Plotly renderer (lazy-loaded + relative data fetch)
│       └── components/
│           ├── FileTree.svelte  # Collapsible left-pane directory tree
│           ├── SearchModal.svelte # Ctrl+P fuzzy filename + content search
│           └── ConflictModal.svelte # Keep Mine / Take Theirs / Reload diff prompt
├── Makefile                     # Build frontend -> copy to embed -> build Go binary
└── go.mod
```

---

## 5. Backend Design (Go)

### 5.1 The `Vault` Interface

Keep all storage behind a clean interface so `LocalVault` (on EC2) and a future `SshVault` (over SFTP) are interchangeable:

```go
type Entry struct {
    Name     string `json:"name"`
    Path     string `json:"path"`     // Always forward-slash relative path from root
    IsDir    bool   `json:"isDir"`
    ModTime  int64  `json:"modTime"`  // Unix milliseconds
    Size     int64  `json:"size"`
    Children []Entry `json:"children,omitempty"`
}

type FileData struct {
    Path    string `json:"path"`
    Content string `json:"content"`
    ModTime int64  `json:"modTime"`
    Hash    string `json:"hash"` // SHA-256 hex of raw bytes
}

type Vault interface {
    Tree(ctx context.Context) ([]Entry, error)
    Read(ctx context.Context, relPath string) (FileData, error)
    Write(ctx context.Context, relPath string, content []byte, expectedHash string) (FileData, error)
    ReadAsset(ctx context.Context, relPath string) ([]byte, string, error) // bytes, mimeType
    SearchContent(ctx context.Context, query string) ([]SearchMatch, error)
}
```

### 5.2 HTTP API Contract

| Method & Path | Purpose | Request / Query | Response |
|---|---|---|---|
| `GET /api/tree` | Directory tree of `.md` files | `?refresh=1` (optional) | `200` JSON `[]Entry` (nested tree) + flat file list |
| `GET /api/file` | Read a Markdown file | `?path=notes/todo.md` | `200` JSON `FileData` (`content`, `modTime`, `hash`) |
| `PUT /api/file` | Save file with conflict check | JSON `{ path, content, expectedHash }` | `200` updated `FileData`, or `409 Conflict` with current server `FileData` |
| `DELETE /api/file` | Permanently delete a Markdown note | `?path=notes/todo.md` | `200` JSON `{"deleted": path}` |
| `GET /api/asset` | Serve images / JSON / CSV | `?path=notes/img/fig1.png` | `200` raw bytes with `Content-Type` |
| `POST /api/asset` | Upload an image for a note | multipart `file` + `?path=notes/a.md` | `201` JSON `{path, ref, url, size}`; stored under `notes/a_assets/` |
| `GET /api/search` | Content search via `rg` | `?q=eigenvalue` | `200` JSON `[]SearchMatch` (`path`, `line`, `snippet`) |
| `GET /api/favorites` | Read the YAML favorite list | none | `200` JSON `{"favorites":["a.md"]}` |
| `PUT /api/favorites` | Replace the favorite list | JSON `{favorites:[...]}` | `200` canonical list (deduped, validated) |
| `GET /api/settings` | Read theme/wide-mode settings | none | `200` JSON `{settings, exists}` |
| `PUT /api/settings` | Save theme/wide-mode settings | JSON `{theme,wideMode}` | `200` JSON `{settings, exists}` |
| `GET /api/recent` | Read the recent-files YAML | none | `200` JSON `{recent:[...]}` |
| `PUT /api/recent` | Replace recents (max 10) | JSON `{recent:[...]}` | `200` canonical list |
| `GET /api/agents` | Detect local CLI agents | none | `200` JSON `{agents:[{id,name,path,available}]}` |
| `POST /api/agent/chat` | Run an agent and stream SSE | JSON `{agent,prompt,path,mode,history,selection}` | `text/event-stream` (`meta`, `delta`, `done`, `error`) |
| `POST /api/quit` | Gracefully stop the local server (loopback clients only) | none | `200` JSON `{"status":"shutting_down"}` |

### 5.3 Safety Rules in `LocalVault`
- **Path traversal guard:** Convert incoming `relPath` with `filepath.FromSlash`, join with `rootDir`, run `filepath.EvalSymlinks` (or `filepath.Abs` + `filepath.Clean`), and verify `strings.HasPrefix(absPath, rootAbs + string(filepath.Separator))`. Reject anything outside `rootDir` with `400`/`403`.
- **Atomic writes:** Write to a hidden temp file in the **same directory** (`os.CreateTemp(filepath.Dir(target), ".burley-tmp-*")`), preserve original file permissions (`os.Stat`), `Sync()`, `Close()`, and `os.Rename(tmp, target)`. On Windows the rename retries briefly (8 attempts, increasing backoff) because a scanner or concurrent reader can hold the destination and fail with `Access is denied` / sharing violation.
- **Conflict detection:** Before writing, read the current file's SHA-256 hash. If `expectedHash != ""` and `currentHash != expectedHash`, abort and return `409 Conflict` with the server's current content so the UI can prompt the user.
- **Ripgrep fallback:** Run `rg --json --max-count 50 --smart-case <query> <rootDir>` (using `exec.CommandContext` with a 3-second timeout—never pass raw shell strings; pass args directly to `exec.Command`). Fall back to Go `filepath.WalkDir` + substring scan if `rg` is not installed.

### 5.4 Process Lifecycle
- **Port selection:** `createListener` first binds the configured `--addr`; if that fails it tries the next 20 ports (e.g. `8081`, `8082`, …), then falls back to an OS-assigned port. The actual URL is logged (and used for the SSH tunnel hint) so the browser always has the right address.
- **Quit endpoint:** `POST /api/quit` is accepted only from loopback clients, answers `{"status":"shutting_down"}` before closing the listener, and cancels the same context used by `SIGINT`/`SIGTERM`. Shutdown is graceful, so an in-flight atomic save finishes before the process exits.

---

## 6. Frontend Design (Svelte + CodeMirror 6)

### 6.1 UI Layout
- **Top Bar (compact):** Brand, save pill and favorite star on the left; a **wide, centered quick-open box** (`Search files… Ctrl P`) in the middle, with the palette appearing directly beneath it; theme, wide/narrow, read-only, sidebar and quit controls on the right. The file path and modification time are **not** shown here.
- **Status Bar (bottom):** Full absolute file path + modification time on the left; line/column, word count, line-ending indicator (`LF`/`CRLF`), save errors, and a read-only indicator on the right.
- **Left Sidebar (~20–25% width, collapsible and resizable):**
  - **Tabs at the top: `Files` | `Outline`** (Typora style); each tab gets the full sidebar height.
  - **Resize handle** on the divider: drag to 220–560 px, arrow keys for keyboard resizing, double-click to reset; the chosen width is stored in `localStorage`.
  - **Favorites section** above the tree: collapsible, drag-to-reorder, missing paths dimmed with a remove button. The single **Filter notes…** box filters favorites and the tree together; the section header hides when no favorite matches. A thin divider separates it from the folder tree. File rows show a hover star; the empty `Ctrl+P` list puts favorites first.
  - **Files tab:** quick filter input, reload button, recursive `FileTree.svelte` showing folders and `.md` files, and a footer with note count / autosave indicator. Clicking a file loads it into CodeMirror (autosaving first if dirty). Right-clicking a file opens a context menu with **Delete**, confirmed through a native `<dialog>`; right-clicking a folder offers **Scope to here** / **Unscope** and **Add document**. A scoped tree shows a banner naming the folder with an **Unscope** button.
  - **Outline tab:** the open note's headings (H1–H6, indented by level, code fences excluded). Clicking an entry scrolls to that heading; the heading containing the cursor is highlighted.
- **Main Pane (~75–80% width):** Full-height CodeMirror 6 editor with comfortable max-width reading measure (e.g. `820px` centered) and clean typography.
- **Status Bar (bottom):** Vault path, line/column, word count, line-ending indicator (`LF`/`CRLF`), save errors, and a read-only indicator.

### 6.2 Editor & Live Preview (`editor.ts`)
Assemble the CodeMirror 6 `EditorState` with:
- `@codemirror/lang-markdown` (GFM + code languages)
- `codemirror-live-markdown` extensions (headings, emphasis, links, images, GFM tables, KaTeX math)
- Custom `blockPluginField` (`StateField`) for specialized fenced blocks (`plotly`, etc.)
- Custom `frontmatterField` (`StateField`) that folds a leading YAML block into a properties card; clicking a row dispatches a selection into the block so the raw YAML is revealed, and `selectionTouches` folds it again
- `EditorView.updateListener` to track dirty state and trigger debounced autosave (e.g. 1.5 s after typing stops)
- Relative image URL resolution: rewrite relative image paths in Markdown widgets to `/api/asset?path=<resolved-relative-to-current-file>`
- `paste`/`drop` listeners on `contentDOM` that collect image files and hand them to the app for upload; `spellcheck` content attributes plus exclusion decorations from `spellcheck.ts`

### 6.3 Specialized Content Block Plugins (`blockPlugins.ts`)
CodeMirror 6 requires a **`StateField`** (not a `ViewPlugin`) to emit multi-line `block: true` replacements:

1. **Registry:** `Map<string, BlockRenderer>` mapping fenced language tags (e.g. `"plotly"`) to renderer functions.
2. **Tree Walk:** On doc or selection change, iterate `syntaxTree(state)` for `FencedCode` nodes. Read `CodeInfo` (language tag).
3. **Cursor Check:** If `selection.main` overlaps `[node.from, node.to]`, skip decoration so the user sees and edits the raw block source. Otherwise, emit `Decoration.replace({ widget, block: true })`.
4. **Widget Caching (`eq`):** Implement `WidgetType.eq(other)` comparing `lang` and `code` so typing elsewhere in the document never redraws existing Plotly charts.
5. **Plotly Renderer (`plugins/plotly.ts`):**
   - Lazy-load `plotly.js-dist-min` via dynamic `import("plotly.js-dist-min")` only when a `plotly` block is encountered.
   - Parse block body as JSON (or simple `src: ./relative/path.json` directive that fetches `/api/asset?path=...`).
   - Render into a container `<div>` with a subtle hover `"Edit"` button that moves the CM6 cursor to `node.from` to reveal source.
   - *(If opening untrusted `.md` files later, render inside `<iframe sandbox="allow-scripts">` communicating via `postMessage` + `ResizeObserver` height sync.)*

### 6.4 Quick-Open Palette (`SearchModal.svelte`)

- **Triggers:** `Ctrl+P`/`Cmd+P` and `F1` open an empty palette with `preventDefault()` captured on `window` (so Print/Help never open, even with CodeMirror focused). The **wide, centered top-bar Search files… box** opens it too and anchors the palette directly beneath itself; `Ctrl+Shift+O` opens `@`, `Ctrl+Shift+F` opens `?`.
- **Files (no prefix):** empty query → favorites (in order) + thin divider + recent files (max 8, deduped, else first 10); typing → `fuzzysort` over full relative paths, matched characters highlighted, favorites first, others capped at 50. No matches → fallback row that switches to `?query`.
- **`@` headings:** fuzzy-filters headings from the active document; Enter moves the cursor there.
- **`>` commands:** fuzzy-filters registered actions (read-only, sidebar, star current file, refresh tree, wide/narrow, theme).
- **`?` content:** debounced `120 ms` calls to `GET /api/search?q=...` with an `AbortController`; rows show file, line, and snippet.
- **Interaction:** flat `selectedIndex` (divider excluded), wrapping arrows and `Ctrl+N/J/K`, `Enter`, `Ctrl+Enter` new tab, hover/click, `scrollIntoView`, reset-to-top on filter changes; `Esc`/backdrop close and restore CodeMirror focus. Recents live in `.burley/recent.yaml` and are loaded/saved through `/api/recent`.

### 6.5 Lua Runtime (`luaCells.ts`, `lua/`)

- **Widgets:** `luaCellsField` walks `FencedCode` nodes tagged `lua-run` (skipped by `blockPlugins` so the source stays visible). An inline widget after `CodeInfo` renders **▶ Run** + a `Lua` badge; a `block: true` widget at `node.to` renders the output panel. Widgets `eq` on the cell source hash, and the output lives in a `StateField` keyed by that hash, so editing elsewhere never clears it.
- **Worker:** `lua/runner.ts` lazily creates `lua/worker.ts` (`new Worker(new URL('./worker.ts', import.meta.url), {type:'module'})`), queues runs FIFO, and dispatches results with `setLuaCellState` effects. `setLuaDocument` drops the VM when the open note changes; **Restart Lua VM** in the `>` palette does the same on demand.
- **Timeout:** a 5 s timer terminates the worker and reports the timeout in the output panel; the next run recreates it.
- **Sandbox:** `wasmoon` is bundled (`wasmoon/dist/glue.wasm` imported with `?url`) and loaded only on first run. `print` is captured; `os`, `io` and `package` are replaced with empty tables. The read-only `vault` bridge performs synchronous `XMLHttpRequest` calls to `/api/tree`, `/api/file` and `/api/search` (sync XHR is legal inside a worker), so Lua authors get plain tables without an async RPC layer.
- **Output:** the worker normalizes return values to `{kind, text, headers, rows}`; the widget renders text/JSON in `<pre>`, Markdown through `renderMarkdown` (KaTeX), tables as real `<table>` elements, and HTML through DOMPurify.

---

## 7. Step-by-Step Build Plan

### Milestone 0: Project Initialization
1. Initialize Go module (`go mod init burley`) in the project root.
2. Scaffold `web/` using Vite + Svelte + TypeScript (`npm create vite@latest web -- --template svelte-ts`).
3. Install frontend dependencies in `web/`:
   - `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/lang-markdown`, `@codemirror/commands`
   - `codemirror-live-markdown`, `katex`
   - `fuzzysort`
   - `plotly.js-dist-min` (and `@types/plotly.js-dist-min` if needed)
4. Verify `npm run build` in `web/` outputs static files to `web/dist/`.

### Milestone 1: Go Backend & Embedded Serving
1. Implement `internal/vault/local.go` with `Tree`, `Read`, `Write` (atomic temp-file + rename + SHA-256 conflict check), and `ReadAsset`, all guarded by strict path-traversal validation.
2. Implement `internal/api/handlers.go` for `/api/tree`, `/api/file`, and `/api/asset`.
3. Implement `cmd/server/main.go` with `--root` and `--addr` (default `127.0.0.1:8080`) flags and `//go:embed` serving `web/dist`.
4. **Verify:** Run the Go server against a test folder of `.md` files and confirm `/api/tree` and `/api/file` responses with `curl`.

### Milestone 2: Left-Sidebar Tree & Live-Preview Editor
1. Build `App.svelte` with the 2-pane layout (tree left, collapsible `FileTree.svelte` on the left, editor on the right).
2. Add the Typora-style **Files | Outline** sidebar tabs; extract headings (`outline.ts`) and make Outline entries jump to their line.
3. Wire `editor.ts` with CodeMirror 6 + `codemirror-live-markdown` + KaTeX CSS/fonts bundled locally.
4. Implement file loading, dirty-state tracking, debounced autosave (`PUT /api/file`), `Ctrl+S` manual save, and `ConflictModal.svelte` on `409 Conflict`.
5. **Verify:** Open a `.md` file with headings, lists, tables, and `$math$`; confirm syntax hides when cursor moves away, edits save atomically, and external edits on disk trigger the conflict modal.

### Milestone 3: Fast Fuzzy Search
1. Flatten `/api/tree` paths in the frontend store and build `SearchModal.svelte` (`Ctrl+P`) using `fuzzysort`.
2. Add `SearchContent` (`rg --json` with Go fallback) to `LocalVault` and `GET /api/search`.
3. Add a content-search tab/prefix (e.g. `> query` or `Ctrl+Shift+F`) in `SearchModal.svelte` with `AbortController` cancellation.
4. **Verify:** Jump between nested `.md` files via fuzzy search and jump to specific lines from content search results.

### Milestone 4: Plotly & Extensible Block Plugins
1. Implement `blockPlugins.ts` (`StateField` + `WidgetType` registry).
2. Implement `plugins/plotly.ts` with lazy-loaded `plotly.js-dist-min`, error display for invalid JSON, and `src:` relative file loading via `/api/asset`.
3. **Verify:** Add a ```` ```plotly ```` block to a test `.md` file; confirm it renders interactively when unfocused, reveals raw JSON when clicked/edited, and doesn't flicker when typing elsewhere in the file.

### Milestone 5: EC2 Deployment & Polish
1. Add a **Read-Only** toggle in the top bar.
2. Resolve relative image URLs (`![](...)`) to `/api/asset`.
3. Add the **Quit** button + `POST /api/quit` graceful shutdown and the **port increment** fallback in `createListener`.
4. Add the **theme switch** (system → light → dark) with OS preference as the default, and the **narrow/wide reading-width** toggle; verify both palettes and widths. Persist both in `.burley/settings.yaml`.
5. Cross-compile for EC2 Linux (`GOOS=linux GOARCH=amd64 go build -o burley ./cmd/server`).
6. Copy binary to EC2, optionally configure a `systemd` user service running `burley --root /path/to/docs`, and connect via:
   ```bash
   ssh -N -L 8080:localhost:8080 user@your-ec2-host
   ```
7. *(Optional future step)*: Implement `internal/vault/ssh.go` (`SshVault`) using `golang.org/x/crypto/ssh` + `github.com/pkg/sftp` if you later want to run the binary locally without installing anything on EC2.

---

## 8. Verification Checklist Before Calling v1 "Done"

- [ ] Path traversal attempts (`../`, symlinks escaping root) are rejected with `400`/`403`.
- [ ] Editing a file externally on EC2 while it is open in the browser triggers a `409 Conflict` prompt instead of silently overwriting.
- [ ] `Ctrl+P` fuzzy-opens files in `< 50 ms`.
- [ ] Math (`$...$`, `$$...$$`) and ```` ```plotly ```` blocks render offline with zero external CDN requests.
- [ ] Saving a file preserves original line endings and leaves untouched Markdown formatting unchanged.
- [ ] Bullets and ordered-list numbers remain visible in live preview while the cursor is elsewhere.
- [ ] `Ctrl+P`/`F1` open the palette; `@`, `>`, and `?` modes work; empty query shows favorites then recents; no-match offers content search; `Ctrl+Enter` opens a new tab.
- [ ] The palette opens directly beneath the wide, centered quick-open box; the status bar shows the full path and modification time (not the top bar).
- [ ] Recents are stored in `.burley/recent.yaml`, survive a reload, and feed the palette's recent group.
- [ ] Ctrl/Cmd-click on a rendered link reveals its Markdown source; a plain click still opens it.
- [ ] Right-clicking a file offers Delete, the confirmation is an HTML `<dialog>`, and cancel keeps the file.
- [ ] Deep links (`?file=…#heading`) open the right file/heading; opening files pushes history and Back/Forward restore both.
- [ ] Code blocks are highlighted when displayed and monospace while editing.
- [ ] Table cells are editable in place; add/remove row and column controls work and only the table range changes.
- [ ] Settings persist theme, width, Markdown style, auto-save and link behavior in `.burley/settings.yaml`.
- [ ] Raw mode toggles preview off/on without losing cursor, scroll or undo history; Escape exits rendered elements.
- [ ] `GET /api/agents` detects installed CLIs and the Talk panel streams Ask/Edit responses (SSE), with Markdown/KaTeX rendering and insert-at-cursor.
- [ ] `Ctrl+?`/plain `?`/the `?` button open the shortcut sheet; it closes with Escape.
- [ ] HTML export is self-contained (inline images/fonts, Plotly SVG); PDF opens the print dialog with pagination CSS.
- [ ] The file tree is docked on the left and the editor fills the right pane.
- [ ] The left sidebar switches between full-height Files and Outline tabs; clicking an Outline heading scrolls to it.
- [ ] The left sidebar can be resized by dragging its divider, and the width survives a reload.
- [ ] Starting a second instance on a busy port automatically moves to the next free port and logs the actual URL.
- [ ] The Quit button stops the server (loopback-only `POST /api/quit`) and shows the shutdown overlay.
- [ ] Light/dark theme follows the OS by default and the top-bar toggle overrides it.
- [ ] The narrow/wide toggle expands the reading measure and the choice survives a reload.
- [ ] Favorites are stored as YAML in `.burley/favorites.yaml`, appear above the tree and at the top of an empty `Ctrl+P`, survive reloads, and flag missing files.
- [ ] The single Filter notes box filters favorites and the tree, hiding the Favorites header when nothing matches; a divider separates them.
- [ ] Theme and wide mode are stored in `.burley/settings.yaml`, survive a reload, and follow the user across browsers.
- [ ] A leading YAML frontmatter block folds into a Properties card (tag chips, nested maps, links); clicking a row reveals the raw YAML and moving out folds it back.
- [ ] Right-clicking a folder scopes the tree to it, the banner unscopes, and the scope survives a reload.
- [ ] **Add document** creates a new note in the chosen folder without overwriting an existing file and opens it.
- [ ] Pasting or dropping an image stores it in `<note>_assets/` and inserts a relative Markdown reference.
- [ ] Spellcheck can be toggled, and code/math are excluded from squiggles.
- [ ] `lua-run` cells show ▶ Run and render text, Markdown/KaTeX, tables, JSON and errors in an output panel without modifying the file.
- [ ] Lua cells can list and read notes through the read-only `vault` bridge, and the VM resets when switching notes or via **Restart Lua VM**.
