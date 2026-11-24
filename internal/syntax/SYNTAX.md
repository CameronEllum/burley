# Burley Markdown Flavour

Burley uses standard CommonMark + GFM with the extensions below.

## Inline Review Comments (Invisible in GitHub)
- **Edit (single actionable note, no threads):**
  - Range: `<!-- edit -->target text<!-- /edit @user (YYYY-MM-DD): instruction -->`
  - Point: `<!-- edit @user (YYYY-MM-DD): instruction -->`
  - Multi-line: put `@user (YYYY-MM-DD): line 1` on the next line, indent continuations with 2 spaces, close with `-->`.
- **Discussion (threaded conversation):**
  - Range: `<!-- discussion -->target text<!-- /discussion @user (YYYY-MM-DD): message -->`
  - Point: `<!-- discussion @user (YYYY-MM-DD): message -->`
  - Replies (multi-line): add `> @user (YYYY-MM-DD): reply` lines inside the comment before `-->`.
- **Rules:** Escape literal `--` inside comment text as `-&#45;`. Never leave blank lines inside `<!-- ... -->` (prefix blank continuation lines with 2 spaces). When asked to apply `edit` comments, update the prose and remove the `edit` tags; preserve `discussion` threads unless asked to delete them.

## Colours & Highlights
- Highlight: `==text==`
- Inline spans: `[text]{.green}`, `[text]{.bg-amber}`, `[text]{.red .bg-red}`, `[text]{color=#c2410c bg=#fff7ed}`
- Table cells: prefix cell text with `{.green} Healthy` or `{bg=#fef3c7 color=#92400e} Note`
- Named palette: `red`, `orange`, `amber`, `green`, `teal`, `blue`, `purple`, `pink`, `gray` (and `bg-*` / `text-*` variants).

## Math (KaTeX)
- Inline: `$E = mc^2$` or `\( E = mc^2 \)`
- Display: `$$ ... $$` or `\[ ... \]` (single-line or multi-line), or fenced ```` ```math ```` / ```` ```katex ````

## Interactive Fenced Blocks
- **Live Data Table:** ```` ```table ```` with `src: ./data.csv` (`.csv`, `.tsv`, `.json`) or inline CSV/TSV/JSON
- **Plotly Chart:** ```` ```plotly ```` with `src: ./chart.json` or inline JSON spec
- **Mermaid Diagram:** ```` ```mermaid ````
- **Lua Cell:** ```` ```lua-run ````

## Document Structure
- **Slides (Presentation Mode):** split slides on `---` horizontal rules (outside frontmatter and code fences).
- **Frontmatter & Collapsible:** YAML `---` frontmatter at top; `<details><summary>...</summary>...</details>`.
