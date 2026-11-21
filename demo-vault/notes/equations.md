---
title: Equations & Math Demo
tags: [demo, math, katex]
---

# Equations & Math

Burley renders math offline with **KaTeX** across inline, single-line display, multi-line display, and fenced block syntaxes. Click any rendered formula to edit its LaTeX source with a live floating preview tooltip.

## Inline math options

- **Dollar delimiters (`$...$`):** Einstein's mass–energy equivalence $E = mc^2$ and Euler's identity $e^{i\pi} + 1 = 0$.
- **LaTeX paren delimiters (`\( ... \)`):** Works with or without inner spaces, e.g. \( a^2 + b^2 = c^2 \) and \( \sum_{k=1}^{n} k = \frac{n(n+1)}{2} \).
- **Currency safety:** Dollar signs with spaces or currency amounts like $5 and $10 (or ~$9,900–$10,150) stay plain text instead of accidentally triggering math mode.

## Single-line display math

Double-dollar on one line (`$$...$$`):

$$e^{i\pi} + 1 = 0$$

LaTeX bracket delimiters on one line (`\[ ... \]`):

\[ \nabla \cdot \mathbf{E} = \frac{\rho}{\varepsilon_0} \]

## Multi-line display blocks

Aligned derivation with `$$ ... $$`:

$$
\begin{aligned}
\frac{d}{dx}\left( x^n \right) &= n x^{n-1} \\
\int_0^1 x^2 \, dx &= \left. \frac{x^3}{3} \right|_0^1 = \frac{1}{3}
\end{aligned}
$$

Matrices and piecewise functions with `\[ ... \]`:

\[
\mathbf{A} =
\begin{pmatrix}
a & b \\
c & d
\end{pmatrix},
\qquad
f(x) =
\begin{cases}
x^2 & x \ge 0 \\
-x & x < 0
\end{cases}
\]

## Fenced `math` / `katex` blocks

```math
\mathcal{L}\{f(t)\} = \int_0^\infty e^{-st} f(t)\,dt
```
