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

export interface TreeResponse {
  tree: Entry[]
  files: FlatFile[]
  root: string
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
  async tree(signal?: AbortSignal): Promise<TreeResponse> {
    return request<TreeResponse>('/api/tree', { signal })
  },

  async file(path: string, signal?: AbortSignal): Promise<FileData> {
    return request<FileData>(`/api/file?path=${encodeURIComponent(path)}`, { signal })
  },

  async save(path: string, content: string, expectedHash: string, signal?: AbortSignal): Promise<FileData> {
    const res = await fetch('/api/file', {
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

  async search(query: string, signal?: AbortSignal): Promise<SearchMatch[]> {
    return request<SearchMatch[]>(`/api/search?q=${encodeURIComponent(query)}`, { signal })
  },

  async quit(): Promise<{ status: string }> {
    return request<{ status: string }>('/api/quit', { method: 'POST' })
  },

  async health(): Promise<{ status: string; root: string; ripgrep: boolean; version: string }> {
    return request('/api/health')
  },

  assetUrl(path: string): string {
    return `/api/asset?path=${encodeURIComponent(path)}`
  },
}
