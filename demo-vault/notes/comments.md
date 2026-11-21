---
title: Comments Demo
tags: [demo, comments, review]
---

# Inline Review Comments

Burley supports self-contained inline review comments stored inside standard HTML comments. They stay invisible in GitHub and other Markdown viewers, live directly beside their target text (no footer IDs to look up), and can be added in **Edit** or **Read-Only** mode.

- **Shortcut:** Select text or place your cursor anywhere and press `Alt+C` (or click `+` in the Comments panel) to compose in the right sidebar without blurring the document.
- **Two types:** **Discussion** (amber, supports threaded replies) and **Edit** (blue, single actionable note with no threads). Both can be edited or deleted cleanly.
- **Right panel:** Opening **Comments** from the topbar badge shares the right sidebar slot with **Talk** (`Alt+T`). Click any highlighted span, badge, or panel card to jump between text and comments.

## Range Discussions (Threaded)

When the deploy rolled out on Tuesday, <!-- discussion -->query cache warm-up latency<!-- /discussion
@cameron (2026-11-20): Should we include a chart comparing cold vs. warm runs?
> @alex (2026-11-20): Yes, let's link a live data table block right below this paragraph.
> @cameron (2026-11-20): Sounds good — I will export the Q3 CSV alongside the benchmark.
--> spiked briefly before settling back down to baseline within four minutes.

Operators should verify the <!-- discussion -->rolling restart window<!-- /discussion @cameron (2026-11-20): Confirm whether 15 minutes is enough for stateful workers. --> in staging before promoting the configuration to production.

## Range & Point Edits (Single Note)

Switching the serializer cut allocations by <!-- edit -->roughly 10x<!-- /edit @cameron (2026-11-20): Replace with the measured 12.4x benchmark figure from Q3. --> across typical Markdown notes under 200 KB.

Each worker pulls jobs from the shared queue and acknowledges completion once the checksum matches on disk.<!-- edit @cameron (2026-11-20): Add an architecture diagram right below this paragraph. -->

## Point Discussion (Threaded)

Everything below this line tracks the post-release follow-ups for the next milestone.<!-- discussion
@alex (2026-11-20): Do we want a dedicated FAQ subsection before the release checklist?
> @cameron (2026-11-20): Yes — let's keep it to 3 short questions.
-->

## Raw Markdown Syntax

Toggle **Raw** in the topbar to inspect how these comments sit inline in Markdown (code blocks like the one below are always ignored by the parser):

```markdown
Range Discussion (single-line):
  <!-- discussion -->selected text<!-- /discussion @cameron (2026-11-20): Note -->

Range Discussion (threaded):
  <!-- discussion -->selected text<!-- /discussion
  @cameron (2026-11-20): First message
  > @alex (2026-11-20): Threaded reply
  -->

Point Discussion:
  Some sentence.<!-- discussion
  @cameron (2026-11-20): Should we split this paragraph?
  > @alex (2026-11-20): Good idea.
  -->

Range Edit (single note, no threads):
  <!-- edit -->roughly 10x<!-- /edit @cameron (2026-11-20): Use exact 12.4x figure. -->

Point Edit:
  Some sentence.<!-- edit @cameron (2026-11-20): Add diagram here. -->
```
