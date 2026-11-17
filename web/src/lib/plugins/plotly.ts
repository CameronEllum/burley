/**
 * Plotly renderer for ```` ```plotly ```` blocks.
 *
 * The body can either be an inline JSON spec:
 *
 *   ```plotly
 *   { "data": [{ "type": "scatter", "y": [1, 2, 3] }] }
 *   ```
 *
 * ...or a `src:` directive pointing at a JSON file relative to the note:
 *
 *   ```plotly
 *   src: ./data/results.json
 *   ```
 *
 * Plotly itself is loaded lazily so notes without charts never pay for the
 * bundle.
 */
import { errorBox, registerBlockRenderer, type BlockContext, type BlockRenderer } from '../blockPlugins'
import { assetUrlFor } from '../blockPlugins'
import { openFigureAt } from '../figures'
import { getActiveView } from '../viewRef'

let plotlyPromise: Promise<any> | null = null

export function loadPlotly(): Promise<any> {
  if (!plotlyPromise) {
    plotlyPromise = import('plotly.js-dist-min').then((mod: any) => mod.default ?? mod)
  }
  return plotlyPromise
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

async function parseSpec(ctx: BlockContext): Promise<any> {
  return parsePlotlySource(ctx.code, ctx.filePath)
}

/** Parse a Plotly block body (inline JSON or a relative `src:` file). */
export async function parsePlotlySource(code: string, filePath: string): Promise<any> {
  const body = code.trim()
  if (!body) throw new Error('empty plotly block')

  const looksLikeJson = body.startsWith('{') || body.startsWith('[')
  const srcMatch = /^(?:src|file)\s*:\s*(.+)$/im.exec(body)
  if (srcMatch && !looksLikeJson) {
    const ref = stripQuotes(srcMatch[1])
    const url = assetUrlFor(filePath, ref)
    if (!url) throw new Error(`cannot resolve data file "${ref}" relative to ${filePath || 'the vault root'}`)
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(`failed to load "${ref}" (HTTP ${res.status})`)
    }
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(`"${ref}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    return JSON.parse(body)
  } catch (err) {
    throw new Error(`invalid JSON spec: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function themeColors(): { text: string; grid: string } {
  const styles = getComputedStyle(document.documentElement)
  return {
    text: styles.getPropertyValue('--text-primary').trim() || '#27272a',
    grid: styles.getPropertyValue('--border').trim() || '#e4e4e7',
  }
}

const plotlyRenderer: BlockRenderer = {
  render(ctx) {
    const root = document.createElement('div')
    root.className = 'burley-plotly'

    const status = document.createElement('div')
    status.className = 'burley-plotly-status'
    status.textContent = 'Loading chart…'

    const chart = document.createElement('div')
    chart.className = 'burley-plotly-chart'

    root.appendChild(status)
    root.appendChild(chart)

    let disposed = false
    let observer: ResizeObserver | null = null
    let Plotly: any = null

    const onThemeChange = () => {
      if (disposed || !Plotly) return
      const { text, grid } = themeColors()
      try {
        Plotly.relayout(chart, {
          'font.color': text,
          'xaxis.gridcolor': grid,
          'yaxis.gridcolor': grid,
        })
      } catch {
        /* chart not ready */
      }
    }
    window.addEventListener('burley:themechange', onThemeChange)

    void (async () => {
      try {
        const spec = await parseSpec(ctx)
        if (disposed) return
        Plotly = await loadPlotly()
        if (disposed) return

        const data = Array.isArray(spec) ? spec : (spec.data ?? [])
        const layoutIn = Array.isArray(spec) ? {} : (spec.layout ?? {})
        const configIn = Array.isArray(spec) ? {} : (spec.config ?? {})
        const { text, grid } = themeColors()

        const layout = {
          autosize: true,
          margin: { l: 64, r: 24, t: 40, b: 48 },
          paper_bgcolor: 'rgba(0,0,0,0)',
          plot_bgcolor: 'rgba(0,0,0,0)',
          colorway: ['#c2410c', '#0f766e', '#7c3aed', '#b45309', '#0369a1', '#be123c'],
          font: { family: 'inherit', size: 13, color: text },
          xaxis: { gridcolor: grid, zerolinecolor: grid },
          yaxis: { gridcolor: grid, zerolinecolor: grid },
          ...layoutIn,
        }
        const config = { responsive: true, displaylogo: false, ...configIn }

        await Plotly.react(chart, data, layout, config)
        if (disposed) {
          try {
            Plotly.purge(chart)
          } catch {
            /* ignore */
          }
          return
        }
        status.remove()
        getActiveView()?.requestMeasure()

        observer = new ResizeObserver(() => {
          if (disposed || !Plotly) return
          try {
            Plotly.Plots.resize(chart)
          } catch {
            /* chart not ready */
          }
        })
        observer.observe(root)
      } catch (err) {
        if (disposed) return
        status.remove()
        root.appendChild(errorBox(err))
        getActiveView()?.requestMeasure()
      }
    })()

    ;(root as any).__dispose = () => {
      disposed = true
      window.removeEventListener('burley:themechange', onThemeChange)
      observer?.disconnect()
      observer = null
      if (Plotly) {
        try {
          Plotly.purge(chart)
        } catch {
          /* ignore */
        }
      }
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

registerBlockRenderer('plotly', plotlyRenderer)
