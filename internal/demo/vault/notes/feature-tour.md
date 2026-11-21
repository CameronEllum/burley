---
title: Feature Tour (Basic Formatting)
tags: [demo, formatting]
---

# Feature Tour — Basic Formatting

A compact reference note for Burley's core Markdown formatting. Click into any element to reveal and edit its raw Markdown source, or switch to **Read-Only** mode to browse cleanly.

## Text & emphasis

Regular text with **bold**, *italic*, ***both at once***, ~~strikethrough~~, ==highlighted==, `inline code`, and an internal [link to Equations](./equations.md).

A line ending with two spaces gets a hard break.  
This line proves it.

## Lists

### Unordered & nested

- Fast local rendering
- Live preview hides Markdown markers until your cursor enters them
  - Headings, emphasis, and links
  - Tables, math, and interactive blocks
- Atomic saves with conflict detection

### Ordered & task lists

1. Open any folder with `burley --root <folder>`.
2. Press `Ctrl+P` to quick-open a note (or type an explicit path).
3. Track work with interactive checkboxes:
   - [x] Serve Markdown from a plain folder
   - [x] Render KaTeX, Mermaid, Plotly, and live CSV tables locally
   - [x] Inline review comments (`Alt+C`)
   - [ ] Your next note

## Blockquotes & collapsible sections

> The file on disk is the source of truth.
> Everything else is a view.

<details>
<summary>Collapsible section (click to toggle)</summary>

Hidden details stay collapsed in live preview until clicked, and render natively in GitHub and HTML exports.

</details>

## Code fences

```go
type FileData struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	ModTime int64  `json:"modTime"`
	Hash    string `json:"hash"`
}
```

## Tables

| Feature | Shortcut | Notes |
| :--- | :---: | ---: |
| Quick open | `Ctrl+P` | Fuzzy search or explicit path |
| Content search | `Ctrl+Shift+F` | Ripgrep-backed |
| Add comment | `Alt+C` | Discussion or Edit |
| Present slides | `F5` | Splits on `---` |
