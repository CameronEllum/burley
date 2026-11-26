/**
 * Typed wrappers around Burley's HTTP API.
 */

export interface Entry {
  name: string
  path: string
  isDir: boolean
  modTime: number
  size: number
  children?: Entry[]
}

export interface FlatFile {
  path: string
  name: string
  modTime: number
  size: number
}

export interface FavoriteGroup {
  name: string
  items: string[]
}

export interface TreeCacheStats {
  entries: number
  bytes: number
  updatedAt: number
}

export interface TreeResponse {
  tree: Entry[]
  files: FlatFile[]
  root: string
  home?: string
  /** True once the background scan has visited the whole vault. */
  done: boolean
  scanning?: boolean
  warmed?: boolean
  cache?: TreeCacheStats
  scanned?: number
  version?: number
  unchanged?: boolean
  delta?: boolean
  added?: FlatFile[]
  updated?: FlatFile[]
  removed?: string[]
  error?: string
  favorites?: string[]
  groups?: FavoriteGroup[]
}

export interface FileData {
  path: string
  content: string
  modTime: number
  hash: string
}

export interface SearchMatch {
  path: string
  line: number
  column: number
  text: string
  snippet: string
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  lightTheme: 'parchment' | 'white'
  darkTheme: 'ember' | 'black' | 'tron'
  wideMode: boolean
  markdownStyle: 'default' | 'github' | 'academic' | 'compact'
  autoSave: boolean
  ctrlClickLink: 'toggle' | 'open'
  spellCheck: boolean
  /** Pinned CLI model per agent ID; missing means the agent's own default. */
  agentModels: Record<string, string>
  /** Agent IDs explicitly disabled by the user. */
  disabledAgents: string[]
  /** Enabled viewable/searchable file type IDs ("markdown", "html"). */
  fileTypes: string[]
  backgroundScan: boolean
  commentHoverPreview: boolean
  commentAuthor: string
  demoSeen: boolean
}

export interface AppMeta {
  status: string
  root: string
  ripgrep: boolean
  version: string
  repo: string
  user?: string
  demoMode?: boolean
}

export interface ReleaseInfo {
  current: string
  latest?: string
  name?: string
  url?: string
  publishedAt?: string
  updateAvailable: boolean
  checkedAt?: string
  error?: string
  repo: string
}

export interface AgentInfo {  id: string
  name: string
  path: string
  available: boolean
}

export interface AgentChatRequest {
  agent: string
  prompt: string
  path: string
  mode: 'ask' | 'edit'
  selection?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

/** Result of probing a CLI for its model catalog. */
export interface AgentModelsResponse {
  agent: string
  models: string[]
  pinned: string
  unsupported: boolean
  error?: string
  favorites?: string[]
  groups?: FavoriteGroup[]
}

export interface AgentTestResult {
  agent: string
  available: boolean
  confirmed?: boolean
  executable?: string
  model?: string
  prompt?: string
  reply?: string
  exitCode: number
  stdout?: string
  stderr?: string
  durationMs?: number
  error?: string
  pathEnv?: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Thrown when a save is rejected because the file changed on disk. */
export class ConflictError extends Error {
  current: FileData
  constructor(current: FileData) {
    super('File changed on disk')
    this.name = 'ConflictError'
    this.current = current
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') message = body.error
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export const api = {
  async tree(signal?: AbortSignal, refresh = false, since?: number): Promise<TreeResponse> {
    const params = new URLSearchParams()
    if (refresh) params.set('refresh', '1')
    if (since !== undefined && since > 0) params.set('since', String(since))
    const qs = params.toString()
    return request<TreeResponse>(`/api/tree${qs ? `?${qs}` : ''}`, { signal })
  },

  async demoTree(signal?: AbortSignal): Promise<TreeResponse> {
    return request<TreeResponse>('/api/demo/tree', { signal })
  },

  async rescanFolder(path: string, signal?: AbortSignal): Promise<TreeResponse> {
    return request<TreeResponse>(`/api/tree/rescan?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      signal,
    })
  },

  async watchTreeDirs(dirs: string[]): Promise<{ watched: number; capped: boolean }> {
    return request<{ watched: number; capped: boolean }>('/api/tree/watch', {
      method: 'POST',
      body: JSON.stringify({ dirs }),
    })
  },

  async file(path: string, signal?: AbortSignal): Promise<FileData> {
    return request<FileData>(`/api/file?path=${encodeURIComponent(path)}`, { signal })
  },

  async save(path: string, content: string, expectedHash: string, signal?: AbortSignal): Promise<FileData> {    const res = await fetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ path, content, expectedHash }),
      signal,
    })
    if (res.status === 409) {
      const current = (await res.json()) as FileData
      throw new ConflictError(current)
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`
      try {
        const body = await res.json()
        if (body && typeof body.error === 'string') message = body.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, message)
    }
    return (await res.json()) as FileData
  },

  async rename(from: string, to: string): Promise<{ from: string; to: string }> {
    return request<{ from: string; to: string }>('/api/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    })
  },

  async deleteFile(path: string): Promise<{ deleted: string }> {
    return request<{ deleted: string }>(`/api/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    })
  },

  async search(query: string, signal?: AbortSignal): Promise<SearchMatch[]> {
    return request<SearchMatch[]>(`/api/search?q=${encodeURIComponent(query)}`, { signal })
  },

  async favorites(signal?: AbortSignal): Promise<{ favorites: string[]; groups?: FavoriteGroup[] }> {
    return request<{ favorites: string[]; groups?: FavoriteGroup[] }>('/api/favorites', { signal })
  },

  async saveFavorites(favorites: string[], groups?: FavoriteGroup[]): Promise<{ favorites: string[]; groups?: FavoriteGroup[] }> {
    return request<{ favorites: string[]; groups?: FavoriteGroup[] }>('/api/favorites', {
      method: 'PUT',
      body: JSON.stringify(groups !== undefined ? { favorites, groups } : { favorites }),
    })
  },

  async settings(signal?: AbortSignal): Promise<{ settings: AppSettings; exists: boolean }> {
    return request('/api/settings', { signal })
  },

  async saveSettings(settings: AppSettings): Promise<{ settings: AppSettings; exists: boolean }> {
    return request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    })
  },

  async agents(): Promise<{ agents: AgentInfo[]; pathEnv?: string }> {
    return request<{ agents: AgentInfo[]; pathEnv?: string }>('/api/agents')
  },

  async testAgent(agent: string, model?: string): Promise<AgentTestResult> {
    const query = `agent=${encodeURIComponent(agent)}${model ? `&model=${encodeURIComponent(model)}` : ''}`
    return request<AgentTestResult>(`/api/agent/test?${query}`, {
      method: 'POST',
    })
  },

  async agentModels(agent: string, signal?: AbortSignal): Promise<AgentModelsResponse> {
    return request<AgentModelsResponse>(`/api/agent/models?agent=${encodeURIComponent(agent)}`, {
      signal,
    })
  },

  async uploadAsset(notePath: string, file: File): Promise<{ path: string; ref: string; url: string; size: number }> {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await fetch(`/api/asset?path=${encodeURIComponent(notePath)}`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`
      try {
        const body = await res.json()
        if (body && typeof body.error === 'string') message = body.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, message)
    }
    return res.json()
  },

  async recent(signal?: AbortSignal): Promise<{ recent: string[] }> {
    return request<{ recent: string[] }>('/api/recent', { signal })
  },

  async saveRecent(recent: string[]): Promise<{ recent: string[] }> {
    return request<{ recent: string[] }>('/api/recent', {
      method: 'PUT',
      body: JSON.stringify({ recent }),
    })
  },

  async quit(): Promise<{ status: string }> {
    return request<{ status: string }>('/api/quit', { method: 'POST' })
  },

  async health(): Promise<AppMeta> {
    return request('/api/health')
  },

  async release(refresh = false): Promise<ReleaseInfo> {
    return request(`/api/release${refresh ? '?refresh=1' : ''}`)
  },

  assetUrl(path: string, version?: number): string {
    return `/api/asset?path=${encodeURIComponent(path)}${version ? `&v=${version}` : ''}`
  },

  async fileAssets(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; assets: string[]; hasAssets: boolean; stamp?: string }> {
    return request<{ path: string; assets: string[]; hasAssets: boolean; stamp?: string }>(
      `/api/file/assets?path=${encodeURIComponent(path)}`,
      { signal },
    )
  },

  downloadUrl(path: string, withAssets = false): string {
    return `/api/download?path=${encodeURIComponent(path)}${withAssets ? '&assets=1' : ''}`
  },
}

/** CLI agents often emit ANSI colour codes in stderr; strip them for the UI. */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/** Stream the agent SSE response, invoking onEvent for each event block. */
export async function streamAgentChat(
  req: AgentChatRequest,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body && typeof body.error === 'string') message = body.error
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message)
  }
  if (!res.body) throw new ApiError(500, 'Agent stream is unavailable')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).replace(/\r/g, '')
      buffer = buffer.slice(boundary + 2)
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (data) {
        try {
          const payload = JSON.parse(data)
          if (payload && typeof payload === 'object') {
            if (typeof payload.text === 'string') payload.text = stripAnsi(payload.text)
            if (typeof payload.message === 'string') payload.message = stripAnsi(payload.message)
          }
          onEvent(event, payload)
        } catch {
          /* ignore malformed event */
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}
