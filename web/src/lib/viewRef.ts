import type { EditorView } from '@codemirror/view'

/**
 * A module-level reference to the active editor view. Widgets need it to move
 * the cursor back into source ranges without threading a view through every
 * decoration.
 */
let active: EditorView | null = null

export function setActiveView(view: EditorView | null): void {
  active = view
}

export function getActiveView(): EditorView | null {
  return active
}
