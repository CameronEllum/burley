/**
 * Host side of the Lua sandbox: owns the worker, queues cells so they share one
 * VM, enforces the timeout by terminating, and pushes results into editor state.
 */
import { getActiveView } from '../viewRef'
import { luaCellState, luaKey, setLuaCellState, type LuaCellOutput } from '../luaCells'
import type { LuaCellResult } from './worker'

const TIMEOUT_MS = 5000

interface Pending {
  key: string
  timer: ReturnType<typeof setTimeout>
  resolve: () => void
}

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let queue: Promise<void> = Promise.resolve()
let notifyHandler: ((message: string) => void) | null = null
let currentDocument = ''

/** One VM per open note: switching notes drops globals from the old note. */
export function setLuaDocument(path: string): void {
  if (path === currentDocument) return
  currentDocument = path
  if (worker) {
    worker.terminate()
    worker = null
  }
  for (const entry of pending.values()) {
    clearTimeout(entry.timer)
    entry.resolve()
  }
  pending.clear()
}

/** Registered by the app so `burley.notify()` can raise a toast. */
export function setLuaNotifyHandler(handler: ((message: string) => void) | null): void {
  notifyHandler = handler
}

function dispatchState(key: string, state: { running: boolean; output?: LuaCellOutput } | null): void {
  const view = getActiveView()
  if (!view) return
  view.dispatch({ effects: setLuaCellState.of({ key, state }) })
}

function createWorker(): Worker {
  const instance = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'burley-lua' })
  instance.addEventListener('message', (event: MessageEvent<unknown>) => {
    const message = event.data as
      | { type: 'done'; id: number; result: LuaCellResult }
      | { type: 'notify'; text: string }
      | { type: 'ready' }
    if (!message || typeof message !== 'object') return
    if (message.type === 'notify') {
      notifyHandler?.(message.text)
      return
    }
    if (message.type !== 'done') return

    const entry = pending.get(message.id)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(message.id)
    dispatchState(entry.key, {
      running: false,
      output: {
        stdout: message.result.stdout,
        value: message.result.value,
        error: message.result.error,
        durationMs: message.result.durationMs,
      },
    })
    entry.resolve()
  })
  instance.addEventListener('error', (event) => {
    const text = event.message || 'Lua worker crashed'
    failAll(`Lua sandbox error: ${text}`)
  })
  return instance
}

function ensureWorker(): Worker {
  if (!worker) worker = createWorker()
  return worker
}

function failAll(message: string): void {
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) {
    clearTimeout(entry.timer)
    dispatchState(entry.key, {
      running: false,
      output: { stdout: '', value: null, error: message, durationMs: TIMEOUT_MS },
    })
    entry.resolve()
  }
}

/** Stops the worker; the next run starts with a fresh VM. */
export function restartLuaVM(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
  failAll('Lua VM restarted')
}

function execute(code: string): Promise<void> {
  const key = luaKey(code)
  return new Promise<void>((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      // A runaway loop cannot be interrupted inside the VM, so drop it.
      if (worker) {
        worker.terminate()
        worker = null
      }
      dispatchState(key, {
        running: false,
        output: {
          stdout: '',
          value: null,
          error: `Lua cell timed out after ${TIMEOUT_MS / 1000}s. The VM was restarted.`,
          durationMs: TIMEOUT_MS,
        },
      })
      resolve()
    }, TIMEOUT_MS)

    pending.set(id, { key, timer, resolve })
    try {
      ensureWorker().postMessage({ type: 'run', id, code })
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      dispatchState(key, {
        running: false,
        output: {
          stdout: '',
          value: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        },
      })
      resolve()
    }
  })
}

/** Queue a cell; cells run in order and share the VM's globals. */
export function runLuaCell(code: string): void {
  const view = getActiveView()
  const key = luaKey(code)
  const previous = view ? luaCellState(view, key)?.output : undefined
  dispatchState(key, { running: true, output: previous })
  queue = queue
    .then(() => execute(code))
    .catch((err) => {
      dispatchState(key, {
        running: false,
        output: {
          stdout: '',
          value: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        },
      })
    })
}
