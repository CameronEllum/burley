# Welcome to Burley

Burley is a **folder-first** Markdown viewer with an Obsidian-style *live preview*.
It edits plain `.md` files in place — no database, no hidden metadata folders — and
saves atomically with conflict detection.

## What's inside

- [x] Folder-first vault
- [x] Live preview with inline math
- [x] Left-pane file tree and fuzzy quick open
- [x] Plotly fenced blocks
- [ ] Your next note

## Inline formatting

This is **bold**, this is *italic*, this is ~~struck through~~, and this is `inline code`. Links *such* as [the todo list](./notes/todo.md) navigate inside Burley; external links
like [the CodeMirror docs](https://codemirror.net) open in a new tab.

## Math

Inline math: $E = mc^2$ and the Pythagorean identity $a^2 + b^2 = c^2$.

A display block:

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

Single-line display math also works: $$e^{i\pi} + 1 = 0$$.

## Tables

| Feature | Shortcut | Notes |
| --- | --- | --- |
| Quick open | `Ctrl+P` | Fuzzy filename search |
| Content search | `Ctrl+Shift+F` | Ripgrep-backed |
| Save now | `Ctrl+S` | Autosave is also on |
| Toggle sidebar | `Ctrl+B` | Collapsible left pane |

## Plotly

An inline chart spec:

```plotly
{
  "data": [
    { "type": "scatter", "mode": "lines+markers", "name": "Views",
      "x": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      "y": [12, 19, 15, 27, 32, 24, 30] }
  ],
  "layout": { "title": "Weekly page views" }
}
```

The same renderer can load a relative JSON file, which is served through
`/api/asset`:

```plotly
src: ./notes/data/results.json
```

## Image

Relative images resolve against this note's folder:

![Burley banner](./notes/img/banner.png)

## Code

```go
func main() {
	fmt.Println("hello from burley")
}
```

## Blockquote

> The file on disk is the source of truth.
> Everything else is a view.

---

1. Open a note from the left sidebar.
2. Press `Ctrl+P` to jump to another note.
3. Click any rendered element to reveal its Markdown source.

## More samples

- [Feature tour](./notes/feature-tour.md) — a denser pass over lists, tasks, tables, code, and math.
- [Plotly charts](./notes/plotly-charts.md) — line, bar, scatter, heatmap, and a `src:` data file.
