---
title: Live Data Tables Demo
tags: [demo, tables, csv, data]
---

# Live Data Tables

Burley renders `table` fenced code blocks as interactive, sortable, filterable data tables. Link them to an external `.csv`, `.tsv`, or `.json` file with `src:` and they automatically update whenever the file changes on disk.

## External CSV (`src: ./data/benchmarks.csv`)

Click any column header to sort numerically or alphabetically, or type in **Filter rows…** to search across all columns.

```table
src: ./data/benchmarks.csv
```

## Inline JSON array

You can also embed structured JSON arrays directly inside a `table` fence:

```table
[
  { "Feature": "External CSV/TSV/JSON", "LiveReload": "Yes", "MaxRows": 500 },
  { "Feature": "Column Sorting", "LiveReload": "Client-side", "MaxRows": 500 },
  { "Feature": "Row Filtering", "LiveReload": "Instant", "MaxRows": 500 }
]
```

## Inline CSV

Small datasets can live inline as comma-separated (or tab-separated) text:

```table
Shortcut,Action,Context
Ctrl+P,Quick open palette,Global
Alt+C,Add discussion or edit comment,Markdown note
Alt+T,Toggle Talk panel,Global
F5,Presentation mode,Markdown note
```
