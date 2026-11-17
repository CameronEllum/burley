# CodeMirror Live Preview Text Selection & HeightMap Drift Investigation

**Date:** 2026-11-16  
**Symptom:**
1. Drag-selecting text on line 80 of `demo-vault/notes/feature-tour.md` (`"Inline math works mid-sentence: the identity $e^{i\pi} + 1 = 0$ holds..."`, directly below `## Math`) failed to select any text.
2. Drag-selecting inside revealed `$$ ... $$` block equations failed or highlighted lines offset below the cursor.

---

## 1. Root Causes Identified

### 1.1 Vertical CSS margins on `.cm-content` children drifted CodeMirror's `HeightMap`
In `web/node_modules/@codemirror/view/dist/index.js`:
- `measureVisibleLineHeights` (line 3346) builds CodeMirror's `HeightMap` from `child.dom.getBoundingClientRect().height` for each direct child of `.cm-content`.
- `getBoundingClientRect().height` measures the CSS border-box only and **excludes `margin-top` and `margin-bottom`**.
- During mouse selection (`basicMouseSelection` -> `view.posAndSideAtCoords` -> `posAtCoords` -> `view.elementAtHeight(yOffset)`) and selection rendering (`rectanglesForRange`), CodeMirror maps pointer `y` coordinates against the `HeightMap` rather than calling `getBoundingClientRect()` on arbitrary lines.
- Any vertical CSS margin on a direct child of `.cm-content` creates unmeasured vertical space between DOM siblings, causing cumulative downward coordinate drift for every line below those margins.
- Similarly, CSS `transition` on `.cm-formatting-inline` / `.cm-formatting-block` (which had already been disabled in `web/src/app.css`) can otherwise skew synchronous layout measurements.

Before the fix, direct measurements of consecutive `.cm-content` children in `demo-vault/notes/feature-tour.md` above line 80 (`## Math` / `Inline math works mid-sentence...`) showed:

| Element | CSS Margin | Unmeasured DOM Gap (`gapFromPrev`) |
| --- | --- | --- |
| `.cm-burley-table-widget` (lines 45–51) | `margin: 10px 0 16px` | `10px` above, `16px` below (26px) |
| `.cm-burley-block` (`go`, lines 57–64) | `margin: 12px 0` | `12px` above, `12px` below (24px) |
| `.cm-burley-block` (`ts`, lines 66–76) | `margin: 12px 0` | `12px` above, `12px` below (24px) |
| **Cumulative offset at line 80** | — | **74px** (~2.5–3 lines) |

Additional unmeasured margins existed on:
- `.cm-burley-frontmatter` (`margin: 10px 0 18px`)
- `.cm-burley-lua-output` (`margin: 2px 0 14px`)
- `.cm-burley-details-wrap` (`margin: 0.45rem 0`)
- `.cm-table-widget` (`margin: 8px 0`)
- `.cm-burley-math-block` / `.cm-burley-math-block-inner` inner `.katex-display` margins
- `.editor-host[data-md-style='github']` heading rules (`.cm-line:has(.cm-header-1)` `margin-bottom: 8px`, `.cm-line:has(.cm-header-2)` `margin-bottom: 5px`)

#### Empirical Reproduction (Headless Chrome via Playwright)
- **Before fix (`notes/feature-tour.md#math`):**
  - Line 80 bounding box: `{ x: 381, y: 508.40625, width: 820, height: 30 }`
  - Dragging horizontally across line 80 resolved to `Ln 83, Col 1` (below the blank line and into the `$$` block) with `window.getSelection().toString() === ''`.
- **With CSS margins zeroed and moved to padding:**
  - Line 80 bounding box shifted up by `74px` to `{ x: 381.5, y: 434.40625, width: 820, height: 30 }`.
  - Dragging horizontally across line 80 immediately selected `'Inline math works mid-sentence: '` at `Ln 80, Col 33`.

### 1.2 Stale `mouseSelectingField`, click vs. drag on math widgets, and boundary drags in `selectionTouches`
Three state-management issues compounded selection problems around inline and block math:
1. **Clicking block math when text was selected elsewhere failed:** `MathWidget.ignoreEvent()` returns `true` for block math (`this.display`), so CodeMirror did not handle `mousedown` to collapse the existing selection. `MathWidget`'s `click` handler previously aborted if `!view.state.selection.main.empty`, so clicking an equation while text was selected elsewhere did nothing.
2. **Dragging inside a revealed block/math range:** `onMouseUp` in `web/src/lib/editor.ts` kept `mouseSelectingField` set to `true` whenever `!view.state.selection.main.empty`. While `mouseSelectingField` remained `true`, `selectionTouches()` returned `false` on any subsequent state update, collapsing widgets if a rebuild fired.
3. **Boundary-crossing drags on expanded elements:** `selectionTouches(state, from, to)` only checked `r.from >= from && r.to <= to`, missing drags that started inside an already-expanded block and crossed `[from, to]`.

### 1.3 Async widget height changes were invisible to CodeMirror's `DOMObserver`
In `web/node_modules/@codemirror/view/dist/index.js`, `DOMObserver.readMutation` (line 7536) returns `null` when `tile.isWidget()`. Therefore, when async widgets resize after initial mount (Plotly chart render, Mermaid SVG render, image load/error, or toggling `<details>`), CodeMirror does not automatically re-measure line heights unless `view.requestMeasure()` is called.

---

## 2. Fixes Applied

### 2.1 Eliminated vertical margins on `.cm-content` direct children (`padding` instead of `margin`)
- **`web/src/app.css`**:
  - Added `.cm-content > * { margin-top: 0 !important; margin-bottom: 0 !important; }` as a structural guard.
  - Added outer wrapper padding rules (`.cm-burley-block-wrap { padding: 12px 0; }`, `.cm-burley-frontmatter-wrap { padding: 10px 0 18px; }`, `.cm-burley-lua-output-wrap { padding: 2px 0 14px; }`) and zeroed inner `margin`.
  - Converted `.cm-table-widget`, `.cm-burley-table-widget`, and `.cm-burley-details-wrap` vertical spacing from `margin` to `padding` (updating `.cm-burley-table-edge-row` `bottom` from `-11px` to `5px` to keep the row-add button aligned with the table bottom border).
  - Zeroed KaTeX display margins inside math blocks (`.cm-burley-math-block .katex-display, .cm-burley-math-block-inner .katex-display { margin: 0; }`) and used `padding: 10px 0;` on `.cm-burley-math-block`.
  - Removed `margin-bottom` from `.editor-host[data-md-style='github']` heading rules (keeping `padding-bottom`).
- **`web/src/lib/blockPlugins.ts`**, **`web/src/lib/frontmatter.ts`**, **`web/src/lib/luaCells.ts`**:
  - Wrapped `BlockWidget`, `FrontmatterWidget`, and `OutputWidget` DOM roots in `.cm-burley-block-wrap`, `.cm-burley-frontmatter-wrap`, and `.cm-burley-lua-output-wrap` respectively so padding is included in CodeMirror's `getBoundingClientRect().height` measurement while inner border radii/backgrounds remain unchanged.

### 2.2 Fixed `selectionTouches`, `mouseSelectingField`, and `MathWidget` click/drag behavior
- **`web/src/lib/cm.ts`**: Updated `selectionTouches(state, from, to)` so that once `mouseSelectingField` is false, it returns `true` when any selection range is inside `[from, to]` **or** has either endpoint strictly inside `(from, to)`.
- **`web/src/lib/editor.ts`**: Simplified `onMouseUp` so that when `!pointerDown && view.contentDOM.isConnected && view.state.field(mouseSelectingField, false)`, it dispatches `setMouseSelecting.of(false)` on the next animation frame regardless of whether the final selection is empty or a range.
- **`web/src/lib/math.ts`**: Recorded pointer `(downX, downY)` on `mousedown` and replaced the `selection.main.empty` check in `click` with `Math.hypot(event.clientX - downX, event.clientY - downY) > 4`, dispatching `{ selection: { anchor: pos }, effects: setMouseSelecting.of(false), scrollIntoView: true }` so clicks open math source even when text is selected elsewhere, while drags across math select without triggering edit mode.

### 2.3 Requested re-measurement after async widget layout changes
Added `getActiveView()?.requestMeasure()` (or `view.requestMeasure()`) when widget heights settle:
- `web/src/lib/plugins/plotly.ts`: after `status.remove()` on success and error.
- `web/src/lib/plugins/mermaid.ts`: after inserting rendered SVG and on error.
- `web/src/lib/images.ts`: on `img` `load` and `error` events.
- `web/src/lib/details.ts`: on `<details>` `toggle` event.

---

## 3. Verification Results
- `cd web; npm run check` -> 0 errors, 0 warnings.
- `cd web; npm run build` -> built and synced `cmd/server/dist`.
- `go vet ./...` and `go test -count=1 ./...` -> all 4 Go packages (`burley/cmd/server`, `burley/internal/agent`, `burley/internal/api`, `burley/internal/vault`) passed.
- Headless Chrome checks against `welcome.md` and `notes/feature-tour.md`:
  - `[]` (zero) DOM vertical gaps > 0.5px between consecutive `.cm-content` children across `default`, `github`, `academic`, and `compact` markdown styles.
  - Dragging on line 80 after clicking `## Math` selected `"Inline math works mid-sentence..."` cleanly in all four markdown styles.
  - Dragging across inline math (`$e^{i\pi} + 1 = 0$`) and strictly over `$\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$` selected accurately.
  - Clicking an inline or block math equation while text was selected elsewhere opened the raw LaTeX source (`sourceLines: 9`, tooltip rendered).
  - Dragging inside an opened `$$ ... $$` matrix block selected `'a & b \\\\\nc & d'` with all `.cm-selectionBackground` rectangles bounded strictly inside `.cm-burley-math-source-line` (`allInside: true`).

---

## 4. Lesson / Rule for Future CodeMirror 6 Widgets
Never apply CSS vertical `margin` directly to top-level children of `.cm-content` (block widgets or `.cm-line` elements). Always use `padding` on the outer element returned by `WidgetType.toDOM()` (or on `.cm-line`), and call `view.requestMeasure()` whenever a widget mutates its own height asynchronously inside an `ignoreEvent() === true` container.
