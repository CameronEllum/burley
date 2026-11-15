# Feature Tour

A compact reference note for checking that Burley's live preview handles the
formats you actually write. Open it in **Read-Only** mode to see everything
rendered at once, or click into any element to reveal its Markdown source.

## Text and emphasis

Regular text with **bold**, *italic*, ***both at once***, ~~strikethrough~~, `inline code`, and a [link to Plotly charts](./plotly-charts.md).

A line ending with two spaces gets a hard break.  
This line proves it.

## Lists

### Unordered, nested

- Fast local rendering
- Live preview that hides syntax when the cursor is elsewhere
  - Headings, emphasis, and links
  - Tables and task lists
    - Math via KaTeX
    - Charts via Plotly
- Lossless saves

### Ordered, with mixed nesting

1. Open the vault folder.
2. Pick a note from the right-hand tree.
3. Edit and let autosave handle the rest.
   1. Watch the status pill change.
   2. Keep typing; saves are debounced.
4. Press `Ctrl+P` to jump to another file.

### Task lists

- [x] Serve Markdown from a plain folder
- [x] Render math without a CDN
- [x] Render Plotly blocks lazily
- [ ] Add a diff view to the conflict dialog
- [ ] Ship a Wails desktop wrapper
  - [ ] Decide on window chrome
  - [ ] Test on Windows and macOS

## Table

| Feature | Syntax | Status | Notes |
|:--------|:------:|:------:|------:|
| Headings | `#` — `######` | Done | Six levels |
| Tables | GFM pipe tables | Done | Alignment supported |
| Math | `$...$`, `$$...$$` | Done | KaTeX, strict off |
| Plotly | plotly fenced block | Done | Inline JSON or `src:` |
| Search | `Ctrl+P` / `Ctrl+Shift+F` | In progress | `rg` backend |

## Code

Fenced blocks keep their exact contents when the cursor is outside them.

```go
type FileData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	ModTime int64  `json:"modTime"`
	Hash    string `json:"hash"`
}
```

```ts
export async function saveFile(path: string, content: string, expectedHash: string) {
  const res = await fetch('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, expectedHash }),
  })
  if (res.status === 409) throw new ConflictError(await res.json())
  return res.json()
}
```

## Math

Inline math works mid-sentence: the identity $e^{i\pi} + 1 = 0$ holds, and so does $\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$.

A displayed derivation:

$$
\begin{aligned}
\frac{d}{dx}\left( x^n \right) &= n x^{n-1} \\
\int_0^1 x^2 \, dx &= \left. \frac{x^3}{3} \right|_0^1 = \frac{1}{3} \\
\nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0}
\end{aligned}
$$

Matrices and cases render too:

$$
\mathbf{A} =
\begin{pmatrix}
a & b \\
c & d
\end{pmatrix},
\qquad
\det(\mathbf{A}) = ad - bc
$$

$$
f(x) =
\begin{cases}
x^2 & \text{if } x \ge 0 \\
-x  & \text{otherwise}
\end{cases}
$$

## Blockquotes

> A quote can hold **formatting**, `code`, and even a list:
>
> - first point
> - second point
>
> > And a nested quote for good measure.

## Rules and links

---

Relative links are resolved against the current note: see
[Plotly Charts](./plotly-charts.md) for chart recipes.
