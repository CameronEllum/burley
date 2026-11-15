/** Self-contained HTML / PDF export for the current note. */
import { api } from './api'
import { isExternalRef, resolveRelative } from './paths'
import { renderMarkdown } from './markdown'
import { renderMermaidSvg } from './plugins/mermaid'

export interface ExportOptions {
  markdown: string
  path: string
  markdownStyle: string
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function urlToDataUrl(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return blobToDataUrl(await response.blob())
}

async function inlineStyles(): Promise<string> {
  const parts: string[] = []
  for (const style of Array.from(document.querySelectorAll('style'))) {
    parts.push(style.textContent ?? '')
  }
  for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))) {
    try {
      parts.push(await fetch(link.href).then((response) => response.text()))
    } catch {
      /* skip inaccessible stylesheet */
    }
  }
  let css = parts.join('\n')
  const urls = new Set<string>()
  for (const match of css.matchAll(/url\((['"]?)([^)'"]+)\1\)/g)) {
    const value = match[2]
    if (value && !value.startsWith('data:') && !value.startsWith('#')) urls.add(value)
  }
  await Promise.all(
    Array.from(urls).map(async (url) => {
      try {
        const absolute = new URL(url, window.location.href).href
        const data = await urlToDataUrl(absolute)
        css = css.split(url).join(data)
      } catch {
        /* leave unresolvable URL */
      }
    }),
  )
  return css
}

async function inlineImages(root: HTMLElement, notePath: string): Promise<void> {
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'))) {
    const src = image.getAttribute('src') ?? ''
    if (!src || src.startsWith('data:')) continue
    if (isExternalRef(src)) continue
    const resolved = resolveRelative(notePath, src)
    if (!resolved) continue
    try {
      image.src = await urlToDataUrl(api.assetUrl(resolved))
    } catch {
      /* keep the original reference */
    }
  }
}

async function parsePlotlySpec(body: string, notePath: string, assetUrl: (ref: string) => string | null): Promise<any> {
  const trimmed = body.trim()
  if (!trimmed) throw new Error('empty plotly block')
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  const srcMatch = /^(?:src|file)\s*:\s*(.+)$/im.exec(trimmed)
  if (srcMatch && !looksJson) {
    const ref = srcMatch[1].trim().replace(/^['"]|['"]$/g, '')
    const url = assetUrl(ref)
    if (!url) throw new Error(`cannot resolve ${ref}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`failed to load ${ref}`)
    return response.json()
  }
  try {
    return JSON.parse(trimmed)
  } catch (err) {
    throw new Error(`invalid plotly JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function resolveNoteAsset(notePath: string, ref: string): string | null {
  if (isExternalRef(ref)) return ref
  const resolved = resolveRelative(notePath, ref)
  return resolved ? api.assetUrl(resolved) : null
}

async function renderPlotlyBlocks(root: HTMLElement, blocks: string[], notePath: string): Promise<void> {
  if (blocks.length === 0) return
  const Plotly = await import('plotly.js-dist-min').then((module: any) => module.default ?? module)
  for (let index = 0; index < blocks.length; index++) {
    const placeholder = root.querySelector<HTMLElement>(`[data-burley-export-plot="${index}"]`)
    if (!placeholder) continue
    const holder = document.createElement('div')
    holder.style.position = 'fixed'
    holder.style.left = '-10000px'
    holder.style.top = '0'
    holder.style.width = '900px'
    holder.style.height = '480px'
    document.body.appendChild(holder)
    try {
      const spec = await parsePlotlySpec(blocks[index], notePath, (ref) => resolveNoteAsset(notePath, ref))
      const data = Array.isArray(spec) ? spec : (spec.data ?? [])
      const layoutIn = Array.isArray(spec) ? {} : (spec.layout ?? {})
      await Plotly.newPlot(
        holder,
        data,
        {
          autosize: false,
          width: 900,
          height: 480,
          margin: { l: 64, r: 24, t: 40, b: 48 },
          paper_bgcolor: '#ffffff',
          plot_bgcolor: '#ffffff',
          font: { color: '#27272a', size: 13 },
          ...layoutIn,
        },
        { staticPlot: true, displayModeBar: false },
      )
      const imageUrl = await Plotly.toImage(holder, { format: 'svg', width: 900, height: 480 })
      const image = document.createElement('img')
      image.src = imageUrl
      image.alt = 'Plotly chart'
      image.style.maxWidth = '100%'
      placeholder.replaceWith(image)
    } catch (err) {
      const error = document.createElement('pre')
      error.className = 'export-error'
      error.textContent = `Plotly export failed: ${err instanceof Error ? err.message : String(err)}`
      placeholder.replaceWith(error)
    } finally {
      try {
        Plotly.purge(holder)
      } catch {
        /* ignore */
      }
      holder.remove()
    }
  }
}

async function renderMermaidBlocks(root: HTMLElement, blocks: string[]): Promise<void> {
  for (let index = 0; index < blocks.length; index++) {
    const placeholder = root.querySelector<HTMLElement>(`[data-burley-export-mermaid="${index}"]`)
    if (!placeholder) continue
    try {
      const svg = await renderMermaidSvg(blocks[index], 'default')
      const holder = document.createElement('div')
      holder.className = 'export-mermaid'
      holder.innerHTML = svg
      placeholder.replaceWith(holder)
    } catch (err) {
      const error = document.createElement('pre')
      error.className = 'export-error'
      error.textContent = `Mermaid export failed: ${err instanceof Error ? err.message : String(err)}`
      placeholder.replaceWith(error)
    }
  }
}

const EXPORT_CSS = `
@page { margin: 18mm; }
body { margin: 0; background: #ffffff; color: #26221e; }
.burley-export {
  box-sizing: border-box;
  max-width: 820px;
  margin: 0 auto;
  padding: 28px 32px 64px;
  font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 16px;
  line-height: 1.7;
}
.burley-export img { max-width: 100%; height: auto; }
.burley-export .export-mermaid { margin: 1em 0; text-align: center; }
.burley-export .export-mermaid svg { max-width: 100%; height: auto; }
.burley-export pre {
  overflow-x: auto;
  padding: 12px 14px;
  border-radius: 8px;
  background: #f4f1ea;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
}
.burley-export code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.burley-export table { border-collapse: collapse; width: 100%; font-size: 0.94em; }
.burley-export th, .burley-export td { border: 1px solid #e5ded3; padding: 6px 9px; text-align: left; }
.burley-export th { background: #f4f1ea; }
.burley-export blockquote { margin: 1em 0; padding-left: 14px; border-left: 3px solid #d6cdbf; color: #6f6558; }
.burley-export .export-error { color: #b91c1c; }
.burley-export[data-md-style='github'] h1 { border-bottom: 2px solid #d6d3d1; padding-bottom: 6px; }
.burley-export[data-md-style='github'] h2 { border-bottom: 1px solid #e7e5e4; padding-bottom: 4px; }
.burley-export[data-md-style='academic'] { font-family: Georgia, 'Times New Roman', serif; font-size: 17px; line-height: 1.85; }
.burley-export[data-md-style='academic'] h1,
.burley-export[data-md-style='academic'] h2,
.burley-export[data-md-style='academic'] h3 { font-family: Georgia, 'Times New Roman', serif; }
.burley-export[data-md-style='compact'] { font-size: 14px; line-height: 1.5; }
.burley-export[data-md-style='compact'] h1 { font-size: 1.6em; }
.burley-export[data-md-style='compact'] h2 { font-size: 1.3em; }
@media print { .burley-export { max-width: none; padding: 0; } }
`

export async function buildExportHtml(options: ExportOptions): Promise<string> {
  const blocks: string[] = []
  const mermaidBlocks: string[] = []
  const prepared = options.markdown
    .replace(/```plotly[^\n]*\n([\s\S]*?)```/g, (_match, body) => {
      const index = blocks.push(body) - 1
      return `\n\n<div data-burley-export-plot="${index}"></div>\n\n`
    })
    .replace(/```mermaid[^\n]*\n([\s\S]*?)```/g, (_match, body) => {
      const index = mermaidBlocks.push(body) - 1
      return `\n\n<div data-burley-export-mermaid="${index}"></div>\n\n`
    })

  const rendered = renderMarkdown(prepared)
  const root = document.createElement('div')
  root.className = 'burley-export'
  root.dataset.mdStyle = options.markdownStyle
  root.innerHTML = rendered

  await inlineImages(root, options.path)
  const css = await inlineStyles()
  await renderPlotlyBlocks(root, blocks, options.path)
  await renderMermaidBlocks(root, mermaidBlocks)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.path ? options.path.split('/').pop()?.replace(/\.(md|markdown)$/i, '') : 'Burley export'}</title>
<style>${css}\n${EXPORT_CSS}</style>
</head>
<body>${root.outerHTML}</body>
</html>`
}

export function exportFileName(path: string): string {
  const base = path.split('/').pop() ?? 'burley-export'
  return `${base.replace(/\.(md|markdown|mdown|mkd)$/i, '') || 'burley-export'}.html`
}

export function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function printPdf(html: string): void {
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '1px'
  frame.style.height = '1px'
  frame.style.opacity = '0'
  frame.srcdoc = html
  frame.onload = () => {
    setTimeout(() => {
      try {
        frame.contentWindow?.focus()
        frame.contentWindow?.print()
      } catch {
        /* ignore print errors */
      }
    }, 350)
  }
  frame.addEventListener('afterprint', () => frame.remove())
  setTimeout(() => frame.remove(), 120000)
  document.body.appendChild(frame)
}
