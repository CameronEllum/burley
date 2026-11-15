/**
 * Sandboxed Lua runtime for `lua-run` cells.
 *
 * Runs inside a dedicated Web Worker: no DOM, no localStorage and no direct
 * network access. The only bridge is a read-only `vault` table backed by the
 * same `/api/*` endpoints the UI uses. The host terminates this worker after a
 * timeout, so runaway loops cannot freeze the page.
 */
import { LuaFactory, type LuaEngine } from 'wasmoon'
import wasmUrl from 'wasmoon/dist/glue.wasm?url'

interface TreeFile {
  path: string
  name: string
  size: number
  modTime: number
}

interface SearchMatch {
  path: string
  line: number
  column: number
  text: string
  snippet: string
}

export type LuaValueKind = 'text' | 'markdown' | 'json' | 'html' | 'table'

export interface LuaCellValue {
  kind: LuaValueKind
  text?: string
  headers?: string[]
  rows?: string[][]
}

export interface LuaCellResult {
  stdout: string
  value: LuaCellValue | null
  durationMs: number
  error?: string
}

type Incoming = { type: 'run'; id: number; code: string } | { type: 'ping' }

type Outgoing =
  | { type: 'done'; id: number; result: LuaCellResult }
  | { type: 'notify'; text: string }
  | { type: 'ready' }

function post(message: Outgoing): void {
  ;(self as unknown as { postMessage: (value: Outgoing) => void }).postMessage(message)
}

/** Synchronous JSON request; sync XHR is allowed inside workers. */
function request<T>(url: string): T {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.send(null)
  if (xhr.status < 200 || xhr.status >= 300) {
    let message = `HTTP ${xhr.status}`
    try {
      const body = JSON.parse(xhr.responseText) as { error?: string }
      if (body.error) message = body.error
    } catch {
      /* non-JSON error page */
    }
    throw new Error(message)
  }
  return JSON.parse(xhr.responseText) as T
}

const MAX_STDOUT = 32_000

let enginePromise: Promise<LuaEngine> | null = null
let stdout: string[] = []
let stdoutSize = 0

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function installBridge(lua: LuaEngine): void {
  lua.global.set('print', (...args: unknown[]) => {
    const line = args.map(formatArg).join('\t')
    if (stdoutSize >= MAX_STDOUT) return
    stdout.push(line)
    stdoutSize += line.length + 1
  })

  const vault = {
    list: (prefix?: unknown) => {
      const files = request<{ files: TreeFile[] }>('/api/tree').files
      const match = prefix === undefined || prefix === null ? '' : String(prefix)
      return files
        .filter((file) => !match || file.path.startsWith(match))
        .map((file) => ({ path: file.path, name: file.name, size: file.size, modTime: file.modTime }))
    },
    read: (path: unknown) => {
      if (typeof path !== 'string' || !path) throw new Error('vault.read(path): path must be a string')
      return request<{ content: string }>(`/api/file?path=${encodeURIComponent(path)}`).content
    },
    search: (query: unknown) => {
      const text = typeof query === 'string' ? query : String(query ?? '')
      return request<SearchMatch[]>(`/api/search?q=${encodeURIComponent(text)}`).map((hit) => ({
        path: hit.path,
        line: hit.line,
        column: hit.column,
        text: hit.text,
        snippet: hit.snippet,
      }))
    },
  }
  lua.global.set('vault', vault)

  lua.global.set('burley', {
    notify: (message: unknown) => {
      post({ type: 'notify', text: String(message ?? '') })
    },
  })

  // No filesystem, process spawning or bytecode loading in the sandbox.
  lua.global.set('os', {})
  lua.global.set('io', {})
  lua.global.set('package', {})
}

async function getEngine(): Promise<LuaEngine> {
  if (!enginePromise) {
    enginePromise = new LuaFactory(wasmUrl).createEngine().then((lua) => {
      installBridge(lua)
      return lua
    })
  }
  return enginePromise
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => formatArg(item))
}

function toStringMatrix(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map((row) => toStringArray(row))
}

function normalize(value: unknown): LuaCellValue | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'text', text: String(value) }
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.markdown === 'string') return { kind: 'markdown', text: record.markdown }
    if (typeof record.html === 'string') return { kind: 'html', text: record.html }
    if (record.json !== undefined) {
      return { kind: 'json', text: JSON.stringify(record.json, null, 2) }
    }
    if (record.table && typeof record.table === 'object') {
      const table = record.table as Record<string, unknown>
      return {
        kind: 'table',
        headers: toStringArray(table.headers),
        rows: toStringMatrix(table.rows),
      }
    }
    return { kind: 'json', text: JSON.stringify(value, null, 2) }
  }
  return { kind: 'text', text: String(value) }
}

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // Strip wasmoon's chunk prefix (`[string "…"]:1:`) for a friendlier panel.
  return message.replace(/^\[string "[^"]*"\]:\d+:\s*/, '')
}

async function runCell(id: number, code: string): Promise<void> {
  stdout = []
  stdoutSize = 0
  const started = performance.now()
  let result: LuaCellResult
  try {
    const lua = await getEngine()
    const value = await lua.doString(code)
    result = {
      stdout: stdout.join('\n'),
      value: normalize(value),
      durationMs: Math.round(performance.now() - started),
    }
  } catch (err) {
    result = {
      stdout: stdout.join('\n'),
      value: null,
      durationMs: Math.round(performance.now() - started),
      error: cleanError(err),
    }
  }
  post({ type: 'done', id, result })
}

self.addEventListener('message', (event: MessageEvent<Incoming>) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'ping') {
    post({ type: 'ready' })
    return
  }
  if (message.type === 'run') {
    void runCell(message.id, message.code)
  }
})

post({ type: 'ready' })
