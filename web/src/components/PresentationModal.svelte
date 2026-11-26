<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { api } from '../lib/api'
  import { isExternalRef, resolveRelative } from '../lib/paths'
  import { renderMarkdown } from '../lib/markdown'
  import { splitSlides } from '../lib/slides'
  import { loadMermaid, mermaidTheme } from '../lib/plugins/mermaid'
  import { loadPlotly, parsePlotlySource } from '../lib/plugins/plotly'

  let {
    title,
    markdown,
    filePath,
    onclose,
  }: {
    title: string
    markdown: string
    filePath: string
    onclose: () => void
  } = $props()

  const slides = $derived(splitSlides(markdown))
  let index = $state(0)
  let gridOpen = $state(false)
  let stageEl = $state<HTMLElement | null>(null)

  const currentSlide = $derived(slides[Math.min(index, slides.length - 1)] ?? '')
  const renderedHtml = $derived(renderMarkdown(currentSlide))

  function prev() {
    if (index > 0) index -= 1
  }

  function next() {
    if (index < slides.length - 1) index += 1
  }

  async function hydrateSlideMedia() {
    await tick()
    if (!stageEl) return

    for (const img of stageEl.querySelectorAll<HTMLImageElement>('img')) {
      const raw = img.getAttribute('src') ?? ''
      if (!raw || isExternalRef(raw) || raw.startsWith('/api/asset')) continue
      const resolved = resolveRelative(filePath, raw)
      if (resolved) img.src = api.assetUrl(resolved)
    }

    const mermaidBlocks = Array.from(stageEl.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))
    if (mermaidBlocks.length > 0) {
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({
          startOnLoad: false,
          theme: mermaidTheme(),
          securityLevel: 'strict',
        })
        for (let i = 0; i < mermaidBlocks.length; i++) {
          const codeEl = mermaidBlocks[i]
          const pre = codeEl.parentElement
          if (!pre) continue
          const src = codeEl.textContent ?? ''
          try {
            const { svg } = await mermaid.render(`burley-slide-mermaid-${Date.now()}-${i}`, src)
            const host = document.createElement('div')
            host.className = 'slide-mermaid'
            host.innerHTML = svg
            pre.replaceWith(host)
          } catch {
            /* keep code fallback on invalid diagram */
          }
        }
      } catch {
        /* ignore mermaid load failure */
      }
    }

    const plotlyBlocks = Array.from(stageEl.querySelectorAll<HTMLElement>('pre > code.language-plotly'))
    if (plotlyBlocks.length > 0) {
      try {
        const Plotly = await loadPlotly()
        for (const codeEl of plotlyBlocks) {
          const pre = codeEl.parentElement
          if (!pre) continue
          try {
            const spec = await parsePlotlySource(codeEl.textContent ?? '', filePath)
            const host = document.createElement('div')
            host.className = 'slide-plotly'
            pre.replaceWith(host)
            const styles = getComputedStyle(document.documentElement)
            const fg = styles.getPropertyValue('--text-primary').trim() || '#27272a'
            const layout = {
              paper_bgcolor: 'transparent',
              plot_bgcolor: 'transparent',
              font: { color: fg },
              height: 460,
              margin: { t: 36, r: 20, b: 44, l: 52 },
              ...(spec.layout ?? {}),
            }
            await Plotly.newPlot(host, spec.data ?? [], layout, { responsive: true, displayModeBar: 'hover' })
          } catch {
            /* keep code fallback */
          }
        }
      } catch {
        /* ignore plotly load failure */
      }
    }
  }

  $effect(() => {
    renderedHtml
    gridOpen
    if (!gridOpen) void hydrateSlideMedia()
  })

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (gridOpen) gridOpen = false
        else onclose()
        return
      }
      if (event.key === 'g' || event.key === 'G') {
        event.preventDefault()
        gridOpen = !gridOpen
        return
      }
      if (gridOpen || event.repeat) return
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        next()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault()
        prev()
      } else if (event.key === 'Home') {
        event.preventDefault()
        index = 0
      } else if (event.key === 'End') {
        event.preventDefault()
        index = slides.length - 1
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div class="present-backdrop" role="dialog" aria-modal="true" aria-label={`Presentation: ${title}`}>
  <header class="present-bar">
    <span class="present-title">{title}</span>
    <span class="present-counter">{index + 1} / {slides.length}</span>
    <div class="present-actions">
      <button type="button" class="present-btn" class:active={gridOpen} onclick={() => (gridOpen = !gridOpen)}>
        {gridOpen ? 'Slide view' : 'Grid (G)'}
      </button>
      <button type="button" class="present-btn" onclick={onclose}>Exit (Esc)</button>
    </div>
  </header>

  {#if gridOpen}
    <div class="present-grid">
      {#each slides as slideMd, i}
        <button
          type="button"
          class="present-thumb"
          class:active={i === index}
          onclick={() => {
            index = i
            gridOpen = false
          }}
        >
          <span class="thumb-num">{i + 1}</span>
          <div class="thumb-preview">{@html renderMarkdown(slideMd)}</div>
        </button>
      {/each}
    </div>
  {:else}
    <main class="present-stage">
      {#key index}
        <article class="present-slide" bind:this={stageEl}>
          {@html renderedHtml}
        </article>
      {/key}
    </main>

    <footer class="present-foot">
      <button type="button" class="present-nav" disabled={index === 0} onclick={prev}>← Prev</button>
      <div class="present-progress" aria-hidden="true">
        <div
          class="present-progress-fill"
          style={`width: ${((index + 1) / Math.max(1, slides.length)) * 100}%`}
        ></div>
      </div>
      <button type="button" class="present-nav" disabled={index >= slides.length - 1} onclick={next}>
        Next →
      </button>
    </footer>
  {/if}
</div>

<style>
  .present-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    flex-direction: column;
    background: var(--bg-app);
    color: var(--text-primary);
  }
  .present-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-chrome);
  }
  .present-title {
    font-weight: 650;
    font-size: 13.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .present-counter {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }
  .present-actions {
    display: inline-flex;
    gap: 6px;
  }
  .present-btn,
  .present-nav {
    padding: 5px 11px;
    border: 1px solid var(--border-strong);
    border-radius: 7px;
    background: var(--panel);
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .present-btn:hover,
  .present-nav:hover:not(:disabled),
  .present-btn.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .present-nav:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .present-stage {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: grid;
    place-items: center;
    padding: 20px 28px;
  }
  .present-slide {
    width: min(1320px, 94vw);
    padding: 40px 52px;
    border: 1px solid var(--border-soft);
    border-radius: 16px;
    background: var(--bg-app);
    box-shadow: 0 20px 60px -24px rgb(0 0 0 / 0.2);
    font-size: clamp(1.1rem, 1.3vw, 1.4rem);
    line-height: 1.68;
  }
  .present-slide :global(h1) {
    font-size: 2.1em;
    margin-top: 0;
    line-height: 1.2;
  }
  .present-slide :global(h2) {
    font-size: 1.55em;
    margin-top: 0;
  }
  .present-slide :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 14px 0;
  }
  .present-slide :global(th),
  .present-slide :global(td) {
    border: 1px solid var(--border-soft);
    padding: 8px 12px;
    text-align: left;
  }
  .present-slide :global(th) {
    background: var(--panel);
  }
  .present-slide :global(pre) {
    padding: 14px 16px;
    border-radius: 8px;
    background: var(--panel);
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 0.85em;
  }
  .present-slide :global(img) {
    max-width: 100%;
    max-height: 460px;
    height: auto;
    border-radius: 8px;
  }
  .present-slide :global(.slide-mermaid) {
    display: flex;
    justify-content: center;
    margin: 12px 0;
  }
  .present-grid {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 24px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
    align-content: start;
  }
  .present-thumb {
    position: relative;
    height: 170px;
    padding: 14px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--panel);
    color: var(--text-primary);
    text-align: left;
    overflow: hidden;
    cursor: pointer;
  }
  .present-thumb.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--active);
  }
  .thumb-num {
    position: absolute;
    top: 8px;
    right: 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .thumb-preview {
    font-size: 11px;
    line-height: 1.4;
    pointer-events: none;
  }
  .present-foot {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 18px;
    border-top: 1px solid var(--border-soft);
    background: var(--bg-chrome);
  }
  .present-progress {
    flex: 1;
    height: 4px;
    border-radius: 999px;
    background: var(--border-soft);
    overflow: hidden;
  }
  .present-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.16s ease;
  }
</style>
