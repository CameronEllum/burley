/**
 * GFM task list checkboxes for the live preview.
 *
 * `- [ ]` / `- [x]` markers are replaced with real checkboxes; clicking one
 * rewrites the single character inside the brackets. In read-only mode the
 * checkbox is rendered but disabled.
 */
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { readOnlyFacet, selectionTouches } from './cm'
import { getActiveView } from './viewRef'

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly markerFrom: number,
    readonly readOnly: boolean,
  ) {
    super()
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.readOnly === this.readOnly
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-burley-task'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = this.checked
    input.disabled = this.readOnly
    input.title = this.readOnly ? 'Read-only mode' : 'Toggle task'
    input.setAttribute('aria-label', this.checked ? 'Completed task' : 'Incomplete task')
    input.addEventListener('change', () => {
      const view = getActiveView()
      if (!view) return
      const at = this.markerFrom + 1
      view.dispatch({
        changes: { from: at, to: at + 1, insert: input.checked ? 'x' : ' ' },
      })
      view.focus()
    })
    wrap.appendChild(input)
    return wrap
  }

  ignoreEvent(): boolean {
    return true
  }
}

function buildTaskDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const readOnly = state.facet(readOnlyFacet)
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'TaskMarker') return
      if (!readOnly && selectionTouches(state, node.from, node.to)) return
      const raw = state.doc.sliceString(node.from, node.to)
      decorations.push(
        Decoration.replace({
          widget: new CheckboxWidget(/[xX]/.test(raw), node.from, readOnly),
        }).range(node.from, node.to),
      )
    },
  })
  return Decoration.set(decorations, true)
}

export const taskCheckboxField: Extension = StateField.define<DecorationSet>({
  create: buildTaskDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured) return buildTaskDecorations(tr.state)
    if (tr.selection || tr.startState.facet(readOnlyFacet) !== tr.state.facet(readOnlyFacet)) {
      return buildTaskDecorations(tr.state)
    }
    return deco
  },
  provide: (field) => EditorView.decorations.from(field),
})
