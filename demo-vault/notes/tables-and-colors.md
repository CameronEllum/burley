---
title: Tables and Colourizing Demo
tags: [demo, tables, colors]
---

# Tables and Colourizing

Burley supports Pandoc-style `{...}` colour directives and `==highlights==` in prose and GFM tables, adapting automatically across light and dark themes while remaining readable plain Markdown.

## Inline text colouring

- Named text colours: [error]{.red}, [warning]{.amber}, [healthy]{.green}, [info]{.blue}, [teal]{.teal}, [purple]{.purple}, [pink]{.pink}, [orange]{.orange}, [muted]{.gray}.
- Highlight shorthand: ==important point== or inline background spans like [needs review]{.bg-amber} and [**critical alert**]{.red .bg-red}.
- Custom hex colours: [brand badge]{color=#c2410c bg=#fff7ed} and [midnight tag]{color=#f8f6f2 bg=#1e3a8a}.
- Click into any coloured phrase in the editor to inspect or edit its raw Markdown delimiters.

## Service status table

- **Select & copy:** drag across cells to select text without entering edit mode.
- **Edit cell:** double-click a cell (`Tab` / `Shift+Tab`, `Enter`, `Shift+Enter` for `<br>`, `Esc` commits).
- **Structure:** hover row or column borders for **`+`** insert guides and **`−`** immediate delete (`Ctrl+Z` undoes); use top-right **`</>`** for raw table source.
- **Colour cells:** hover a cell's top-right palette icon or right-click any cell to open the colour swatch picker.

| Service | State | Latency | Notes |
| :--- | :---: | ---: | :--- |
| API Gateway | {.green} Healthy | 12 ms | Inline [SLA met]{.green} |
| Auth Worker | {.green} Healthy | 18 ms | Token cache ==99.4%== hit rate |
| Billing Queue | {.amber} Degraded | {.amber} 240 ms | Retry backlog [increasing]{.orange} |
| Webhook Dispatcher | {.red} Down | {.red} timeout | Upstream [503 errors]{.red} |
| Staging Mirror | {.blue} Syncing | 45 ms | Snapshot in progress |
| Legacy Exporter | {.gray} Paused | — | Scheduled sunset |

## Theme-aware named palette

Each built-in colour maps to matched background and foreground tokens for both light and dark Burley palettes.

| Swatch | Cell directive | Text only | Background only | Aliases |
| --- | --- | --- | --- | --- |
| {.red} Red | `{.red}` | {.text-red} `.text-red` | {.bg-red} `.bg-red` | `danger` |
| {.orange} Orange | `{.orange}` | {.text-orange} `.text-orange` | {.bg-orange} `.bg-orange` | — |
| {.amber} Amber | `{.amber}` | {.text-amber} `.text-amber` | {.bg-amber} `.bg-amber` | `yellow`, `warn` |
| {.green} Green | `{.green}` | {.text-green} `.text-green` | {.bg-green} `.bg-green` | `ok` |
| {.teal} Teal | `{.teal}` | {.text-teal} `.text-teal` | {.bg-teal} `.bg-teal` | — |
| {.blue} Blue | `{.blue}` | {.text-blue} `.text-blue` | {.bg-blue} `.bg-blue` | `info` |
| {.purple} Purple | `{.purple}` | {.text-purple} `.text-purple` | {.bg-purple} `.bg-purple` | — |
| {.pink} Pink | `{.pink}` | {.text-pink} `.text-pink` | {.bg-pink} `.bg-pink` | — |
| {.gray} Gray | `{.gray}` | {.text-gray} `.text-gray` | {.bg-gray} `.bg-gray` | `grey`, `muted` |

## Custom `#RRGGBB` hex & contrast ink

Bare hex cell fills (`{#rrggbb}` or `#rgb`) automatically choose dark or light ink for legibility, or you can specify both `bg=` and `color=` explicitly.

| Style | Markdown syntax | Rendered example |
| --- | --- | --- |
| Soft warm hex | `{#fef3c7} Warm highlight` | {#fef3c7} Warm highlight |
| Soft ice blue | `{#dbeafe} Cool note` | {#dbeafe} Cool note |
| Mint highlight | `{#dcfce7} Passed` | {#dcfce7} Passed |
| Deep navy (auto light ink) | `{#1e3a8a} Production freeze` | {#1e3a8a} Production freeze |
| Deep crimson (auto light ink) | `{#7f1d1d} Critical incident` | {#7f1d1d} Critical incident |
| Forest green (auto light ink) | `{#14532d} Verified release` | {#14532d} Verified release |
| Explicit foreground + background | `{bg=#fdf2f8 color=#9d174d} Custom pair` | {bg=#fdf2f8 color=#9d174d} Custom pair |
