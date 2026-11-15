<script lang="ts">
  import type { FigureItem } from '../lib/figures'
  import { loadPlotly, parsePlotlySource } from '../lib/plugins/plotly'
  import { renderMermaidSvg } from '../lib/plugins/mermaid'

  interface Props {
    figures: FigureItem[]
    index?: number
    onclose: () => void
  }

  let { figures, index = $bindable(0), onclose }: Props = $props()

  let scale = $state(1)
  let offsetX = $state(0)
  let offsetY = $state(0)
  let dragging = $state(false)
  let dragStart = { x: 0, y: 0, ox: 0, oy: 0 }
  let plotlyHost = $state<HTMLDivElement>()
  let plotlyError = $state('')
  let plotly: any = null
  let mermaidHost = $state<HTMLDivElement>()
  let mermaidError = $state('')

  const figure = $derived(figures[index])
  const caption = $derived(
    figure
      ? figure.caption ||
        (figure.kind === 'plotly' ? 'Plotly chart' : figure.kind === 'mermaid' ? 'Mermaid diagram' : 'Figure')
      : '',
  )

  function resetZoom() {
    scale = 1
    offsetX = 0
    offsetY = 0
  }

  function step(delta: number) {
    if (figures.length === 0) return
    index = (index + delta + figures.length) % figures.length
  }

  function onWheel(event: WheelEvent) {
    if (!figure || figure.kind !== 'image') return
    event.preventDefault()
    const next = scale * (event.deltaY < 0 ? 1.1 : 0.9)
    scale = Math.min(4, Math.max(0.5, Math.round(next * 100) / 100))
  }

  function startDrag(event: PointerEvent) {
    if (!figure || figure.kind !== 'image' || event.button !== 0) return
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY, ox: offsetX, oy: offsetY }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function dragMove(event: PointerEvent) {
    if (!dragging) return
    offsetX = dragStart.ox + (event.clientX - dragStart.x)
    offsetY = dragStart.oy + (event.clientY - dragStart.y)
  }

  function endDrag(event: PointerEvent) {
    if (!dragging) return
    dragging = false
    try {
      ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
    } catch {
      /* pointer already gone */
    }
  }

  function handleKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onclose()
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      step(-1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      event.stopPropagation()
      step(1)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      event.stopPropagation()
      resetZoom()
    }
  }

  $effect(() => {
    const listener = (event: KeyboardEvent) => handleKey(event)
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  })

  $effect(() => {
    // Reset the viewport whenever the active figure changes.
    index
    resetZoom()
    plotlyError = ''
    mermaidError = ''
  })

  $effect(() => {
    const item = figure
    const host = mermaidHost
    if (!item || item.kind !== 'mermaid' || !host) return

    let disposed = false
    host.innerHTML = ''
    void (async () => {
      try {
        const svg = await renderMermaidSvg(item.code)
        if (disposed) return
        host.innerHTML = svg
        const element = host.querySelector('svg')
        if (element) {
          element.style.maxWidth = '100%'
          element.style.height = 'auto'
          element.removeAttribute('height')
        }
      } catch (err) {
        if (!disposed) mermaidError = err instanceof Error ? err.message : String(err)
      }
    })()

    return () => {
      disposed = true
      host.innerHTML = ''
    }
  })

  $effect(() => {
    const item = figure
    const host = plotlyHost
    if (!item || item.kind !== 'plotly' || !host) return

    let disposed = false
    host.innerHTML = ''
    void (async () => {
      try {
        const spec = await parsePlotlySource(item.code, item.filePath)
        const Plotly = await loadPlotly()
        if (disposed) return
        const data = Array.isArray(spec) ? spec : (spec.data ?? [])
        const layout = Array.isArray(spec)
          ? {}
          : (spec.layout ?? {})
        const config = Array.isArray(spec) ? {} : (spec.config ?? {})
        const styles = getComputedStyle(document.documentElement)
        const text = styles.getPropertyValue('--text-primary').trim() || '#27272a'
        const grid = styles.getPropertyValue('--border').trim() || '#e4e4e7'
        await Plotly.react(
          host,
          data,
          {
            autosize: true,
            margin: { l: 64, r: 28, t: 44, b: 52 },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { family: 'inherit', size: 14, color: text },
            xaxis: { gridcolor: grid, zerolinecolor: grid },
            yaxis: { gridcolor: grid, zerolinecolor: grid },
            ...layout,
          },
          { responsive: true, displaylogo: false, ...config },
        )
        plotly = Plotly
      } catch (err) {
        if (!disposed) plotlyError = err instanceof Error ? err.message : String(err)
      }
    })()

    return () => {
      disposed = true
      if (plotly && host) {
        try {
          plotly.purge(host)
        } catch {
          /* ignore */
        }
      }
      plotly = null
    }
  })
</script>

<svelte:window />

<div class="lightbox-backdrop" role="dialog" aria-modal="true" aria-label="Figure viewer">
  <button class="lightbox-dismiss" aria-label="Close figure viewer" onclick={onclose}></button>
  <div class="lightbox">
    <header class="lightbox-head">
      <span class="lightbox-count">{index + 1} / {figures.length}</span>
      <span class="lightbox-caption">{caption}</span>
      <span class="lightbox-spacer"></span>
      {#if figure?.kind === 'image'}
        <button class="lightbox-tool" onclick={() => (scale = Math.min(4, scale + 0.25))} aria-label="Zoom in">+</button>
        <button class="lightbox-tool" onclick={() => (scale = Math.max(0.5, scale - 0.25))} aria-label="Zoom out">−</button>
        <button class="lightbox-tool" onclick={resetZoom} aria-label="Reset zoom">1:1</button>
      {/if}
      <button class="lightbox-close" onclick={onclose} aria-label="Close figure viewer">×</button>
    </header>

    <div
      class="lightbox-stage"
      class:dragging
      role="application"
      aria-label="Figure canvas"
      onwheel={onWheel}
      onpointerdown={startDrag}
      onpointermove={dragMove}
      onpointerup={endDrag}
      onpointercancel={endDrag}
      ondblclick={resetZoom}
    >
      {#if figure?.kind === 'image'}
        <img
          class="lightbox-image"
          src={figure.src}
          alt={figure.caption}
          style={`transform: translate(${offsetX}px, ${offsetY}px) scale(${scale})`}
          draggable="false"
        />
      {:else if figure?.kind === 'plotly'}
        <div class="lightbox-plotly" bind:this={plotlyHost}></div>
        {#if plotlyError}<p class="lightbox-error">{plotlyError}</p>{/if}
      {:else if figure?.kind === 'mermaid'}
        <div class="lightbox-mermaid" bind:this={mermaidHost}></div>
        {#if mermaidError}<p class="lightbox-error">{mermaidError}</p>{/if}
      {/if}
    </div>

    {#if figures.length > 1}
      <button class="lightbox-nav prev" onclick={() => step(-1)} aria-label="Previous figure">‹</button>
      <button class="lightbox-nav next" onclick={() => step(1)} aria-label="Next figure">›</button>
    {/if}

    <footer class="lightbox-foot">
      <span>← → navigate</span>
      <span>scroll to zoom</span>
      <span>drag to pan</span>
      <span>0 reset</span>
      <span>Esc close</span>
    </footer>
  </div>
</div>

<style>
  .lightbox-backdrop {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 22px;
    background: rgb(16 12 8 / 0.72);
    backdrop-filter: blur(3px);
  }

  .lightbox {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: min(1200px, 96vw);
    height: min(880px, 94vh);
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: var(--bg-app);
    box-shadow: 0 40px 120px -40px rgb(0 0 0 / 0.8);
    overflow: hidden;
  }

  .lightbox-dismiss {
    position: absolute;
    inset: 0;
    border: 0;
    padding: 0;
    background: transparent;
    cursor: default;
  }

  .lightbox-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px 8px 14px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
    color: var(--text-muted);
    font-size: 11px;
  }

  .lightbox-count {
    font-family: var(--font-mono);
    font-weight: 700;
    color: var(--text-primary);
  }

  .lightbox-caption {
    max-width: 46ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
  }

  .lightbox-spacer {
    flex: 1;
  }

  .lightbox-tool,
  .lightbox-close {
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 11px;
    padding: 2px 7px;
    cursor: pointer;
  }

  .lightbox-tool:hover,
  .lightbox-close:hover {
    background: var(--hover);
    color: var(--text-primary);
  }

  .lightbox-close {
    font-size: 16px;
    line-height: 1.1;
    padding: 0 7px;
  }

  .lightbox-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    background: var(--bg-app);
    cursor: grab;
  }

  .lightbox-stage.dragging {
    cursor: grabbing;
  }

  .lightbox-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    transform-origin: center center;
    transition: transform 90ms ease-out;
    user-select: none;
  }

  .lightbox-stage.dragging .lightbox-image {
    transition: none;
  }

  .lightbox-plotly {
    width: 100%;
    height: 100%;
  }

  .lightbox-mermaid {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 18px;
    overflow: auto;
  }

  .lightbox-mermaid :global(svg) {
    max-width: 100%;
    max-height: 100%;
  }

  .lightbox-error {
    margin: 0;
    padding: 12px;
    color: var(--danger-fg);
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: center;
  }

  .lightbox-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 2;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    width: 38px;
    height: 38px;
    background: var(--bg-chrome);
    color: var(--text-primary);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 10px 24px -14px rgb(0 0 0 / 0.6);
  }

  .lightbox-nav:hover {
    background: var(--panel);
  }

  .lightbox-nav.prev {
    left: 12px;
  }

  .lightbox-nav.next {
    right: 12px;
  }

  .lightbox-foot {
    display: flex;
    gap: 16px;
    justify-content: center;
    padding: 6px 12px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-chrome);
    color: var(--text-muted);
    font-size: 10.5px;
  }
</style>
