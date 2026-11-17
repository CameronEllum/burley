/**
 * Mermaid renderer for ```mermaid blocks.
 *
 * Mermaid is loaded lazily (it is a large dependency) and re-rendered when the
 * UI theme changes so diagram colours match the active palette.
 */
import { errorBox, registerBlockRenderer, type BlockRenderer } from '../blockPlugins'
import { openFigureAt } from '../figures'
import { getActiveView } from '../viewRef'

type MermaidApi = typeof import('mermaid').default

let mermaidPromise: Promise<MermaidApi> | null = null
let renderSeq = 0

export type MermaidTheme = 'default' | 'dark'

export function mermaidTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
}

function config(theme: MermaidTheme) {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme,
    fontFamily: 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif',
    flowchart: { useMaxWidth: true, htmlLabels: true },
    sequence: { useMaxWidth: true },
  }
}

export function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => {
      const api = (module.default ?? module) as MermaidApi
      api.initialize(config(mermaidTheme()))
      return api
    })
  }
  return mermaidPromise
}

/** Render Mermaid source to an SVG string (used by the preview and exports). */
export async function renderMermaidSvg(code: string, theme: MermaidTheme = mermaidTheme()): Promise<string> {
  const api = await loadMermaid()
  api.initialize(config(theme))
  const id = `burley-mermaid-${++renderSeq}`
  const { svg } = await api.render(id, code)
  return svg
}

const mermaidRenderer: BlockRenderer = {
  render(ctx) {
    const root = document.createElement('div')
    root.className = 'burley-mermaid'
    let disposed = false
    let run = 0

    const draw = async () => {
      const current = ++run
      const status = document.createElement('div')
      status.className = 'burley-mermaid-status'
      status.textContent = 'Rendering diagram…'
      root.replaceChildren(status)
      try {
        const svg = await renderMermaidSvg(ctx.code)
        if (disposed || current !== run) return
        root.innerHTML = svg
        const element = root.querySelector('svg')
        if (element) {
          element.style.maxWidth = '100%'
          element.style.height = 'auto'
          element.removeAttribute('height')
        }
        getActiveView()?.requestMeasure()
      } catch (err) {
        if (disposed || current !== run) return
        root.replaceChildren(errorBox(err))
        getActiveView()?.requestMeasure()
      }
    }
    void draw()

    const onThemeChange = () => {
      if (!disposed) void draw()
    }
    window.addEventListener('burley:themechange', onThemeChange)
    ;(root as any).__dispose = () => {
      disposed = true
      window.removeEventListener('burley:themechange', onThemeChange)
    }
    return root
  },

  destroy(root) {
    ;(root as any).__dispose?.()
  },

  expand(ctx) {
    openFigureAt(ctx.from)
  },
}

registerBlockRenderer('mermaid', mermaidRenderer)
