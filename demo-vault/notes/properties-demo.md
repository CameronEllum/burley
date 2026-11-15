---
title: Properties demo
date: 2026-11-15
status: draft
tags: [demo, frontmatter, "yaml"]
aliases:
  - properties
  - metadata note
author:
  name: Cameron
  team: Docs
source: https://example.com/burley
reviewers:
  - Ada
  - Grace
---

# Properties demo

The block above the heading is YAML frontmatter. Burley folds it into a
**Properties** card so the note opens on its content instead of raw metadata.

- Click any row (or **Edit** in the card header) to edit the YAML in place.
- Move the cursor out of the block and it folds back into the card.
- Lists such as `tags` and `aliases` render as chips; nested maps and links
  render as structured values.

```yaml
tags:
  - still valid YAML inside a code fence
```
