/**
 * Live KaTeX preview while editing `$...$` / `$$...$$`.
 *
 * The inline preview normally collapses math into a widget. Once the caret is
 * inside, the raw LaTeX is revealed and this tooltip floats a rendered copy
 * above it, updating on every keystroke.
 */
import { StateField, type EditorState, type Extension } from '@codemirror/state'
import { showTooltip, type Tooltip } from '@codemirror/view'
import katex from 'katex'
import { mathAt } from './math'
import { readOnlyFacet } from './cm'

interface MathTooltip extends Tooltip {
  tex: string
  display: boolean
}

function buildTooltips(state: EditorState): readonly Tooltip[] {
  if (state.facet(readOnlyFacet)) return []
  const math = mathAt(state, state.selection.main.head)
  if (!math || !math.tex.trim()) return []

  const tooltip: MathTooltip = {
    pos: math.from,
    end: math.to,
    above: true,
    arrow: false,
    tex: math.tex,
    display: math.display,
    create() {
      const dom = document.createElement('div')
      dom.className = 'cm-burley-math-tooltip'
      dom.setAttribute('role', 'img')
      dom.setAttribute('aria-label', `Math preview: ${math.tex}`)
      try {
        dom.innerHTML = katex.renderToString(math.tex, {
          displayMode: math.display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
        })
      } catch {
        dom.classList.add('cm-burley-math-error')
        dom.textContent = math.tex
      }
      return { dom }
    },
  }
  return [tooltip]
}

const tooltipField = StateField.define<Tooltip | null>({
  create: (state) => buildTooltips(state)[0] ?? null,
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.reconfigured) return buildTooltips(tr.state)[0] ?? null
    return value
  },
  provide: (field) => showTooltip.from(field),
})

/** Floating rendered preview for the math expression under the caret. */
export function mathTooltipField(): Extension {
  return tooltipField
}
