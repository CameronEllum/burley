# Burley Markdown Flavour (Agent Reference)

This document specifies the Markdown dialect rendered and edited by **Burley**. It is written for AI agents reading, authoring, or editing `.md` files in a Burley vault.

For a compact CLI printout of this dialect, run `burley -report-syntax`. To inject or update the syntax section in a vault's `AGENTS.md`, run `burley -init-agent-docs --root <vault>`.

---

## 1. Base Dialect

Burley uses **CommonMark + GitHub Flavored Markdown (GFM)**:

- Headings (`#`–`######`), emphasis (`*italic*`, `**bold**`, `~~strikethrough~~`), blockquotes (`>`), fenced code blocks (```` ```lang ````), inline code (`` `code` ``).
- GFM pipe tables (`| col | col |`) with column alignment (`:---`, `:---:`, `---:`). Use `<br>` inside table cells for multi-line cell content.
- Task lists (`- [ ] todo`, `- [x] done`).
- Links (`[label](target)`) and images (`![alt](./path/to/image.png)`). Pasted/dropped images in Burley are saved under `<note>_assets/` next to the note.

---

## 2. Inline Review Comments

Comments are stored directly inside standard HTML comments (`<!-- ... -->`) so they remain **invisible in GitHub and external Markdown renderers** while remaining readable and editable by humans and agents.

### Edit Comments (single actionable instruction, no threads)

- **Range edit** (wraps target text):
  ```markdown
  <!-- edit -->target text<!-- /edit @user (2026-11-23): rewrite for clarity -->
  ```
- **Point edit** (anchored at a single position):
  ```markdown
  <!-- edit @user (2026-11-23): add a benchmark table here -->
  ```
- **Multi-line edit**:
  ```markdown
  <!-- edit -->target text<!-- /edit
  @user (2026-11-23): line 1
    line 2 (indent continuations with 2 spaces)
  -->
  ```

### Discussion Comments (threaded conversation)

- **Range discussion**:
  ```markdown
  <!-- discussion -->target text<!-- /discussion @user (2026-11-23): should we keep this? -->
  ```
- **Point discussion**:
  ```markdown
  <!-- discussion @user (2026-11-23): open question about scope -->
  ```
- **Threaded replies (multi-line)**:
  ```markdown
  <!-- discussion -->target text<!-- /discussion
  @alice (2026-11-23): initial comment
    continuation line
  > @bob (2026-11-23): reply line
    reply continuation
  -->
  ```

### Comment Rules for Agents

- **Applying `edit` comments:** Make the requested change to the surrounding/wrapped prose and **remove** the `<!-- edit ... -->` / `<!-- /edit ... -->` tags.
- **Handling `discussion` comments:** **Preserve** `discussion` threads intact unless explicitly asked to resolve or delete them. To reply to a discussion, append a `> @agent (YYYY-MM-DD): ...` line before `-->`.
- **No literal `--`:** Escape `--` inside comment body text as `-&#45;` so it does not prematurely close `<!-- ... -->`.
- **No blank lines inside `<!-- ... -->`:** A blank line inside an HTML comment breaks CommonMark block parsing. Prefix any empty continuation line inside a multi-line comment with 2 spaces (`  `).

---

## 3. Colours & Highlights

- **Highlight:** `==highlighted text==`
- **Inline coloured spans** (Pandoc-style bracketed spans):
  - Named text colour: `[text]{.red}`
  - Named background colour: `[text]{.bg-amber}`
  - Combined classes: `[text]{.red .bg-red}` or `[text]{.text-blue .bg-blue}`
  - Custom hex colours: `[text]{#c2410c}` or `[text]{color=#c2410c bg=#fff7ed}`
- **Table cell colours** (leading directive at the start of a cell):
  ```markdown
  | Service | Status | Notes |
  | --- | --- | --- |
  | API | {.green} Healthy | {.bg-amber} High latency |
  | Worker | {#fef3c7} Degraded | {bg=#fee2e2 color=#991b1b} OOM |
  ```
- **Named palette:** `red`, `orange`, `amber`, `green`, `teal`, `blue`, `purple`, `pink`, `gray`.
- **Aliases:** `danger` (`red`), `yellow` / `warn` (`amber`), `ok` (`green`), `info` (`blue`), `grey` / `muted` (`gray`).

---

## 4. Math (KaTeX)

- **Inline math:** `$E = mc^2$` or `\( E = mc^2 \)`
- **Display math:**
  - `$$ ... $$` (single-line or multi-line)
  - `\[ ... \]` (single-line or multi-line)
  - Fenced code blocks with language `math` or `katex`:
    ````markdown
    ```math
    \int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
    ```
    ````

---

## 5. Interactive Fenced Blocks

- **Live Data Table (```` ```table ````):**
  - Load from a relative `.csv`, `.tsv`, or `.json` file:
    ````markdown
    ```table
    src: ./data/benchmarks.csv
    ```
    ````
  - Or embed CSV, TSV, or JSON directly inside the fence.
- **Plotly Chart (```` ```plotly ````):**
  - Load from a relative JSON file (`src: ./data/chart.json`) or provide an inline Plotly JSON spec (`data`, `layout`).
- **Mermaid Diagram (```` ```mermaid ````):**
  - Standard Mermaid syntax (`flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, etc.).
- **Lua Live Cell (```` ```lua-run ````):**
  - Sandboxed Lua 5.4 cell executed on demand in the browser (`▶ Run`). Output is never written back into the Markdown file.
  - Note: Plain ```` ```lua ```` renders as a syntax-highlighted code block; use ```` ```lua-run ```` for an executable cell.

---

## 6. Document Structure

- **YAML Frontmatter:** Optional `---` YAML block at the very top of the file (folded into a properties card in Burley).
- **Collapsible Sections:** Standard HTML `<details><summary>Title</summary> ... </details>`.
- **Presentation Slides:** In Presentation Mode, `---` horizontal rules (outside frontmatter and code fences) split the document into slides.
