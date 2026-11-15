/** Path helpers for resolving vault-relative references. */

/** Directory part of a vault-relative file path ("" for root). */
export function dirOf(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i === -1 ? '' : filePath.slice(0, i)
}

/** File name part of a vault-relative path. */
export function baseName(filePath: string): string {
  const i = filePath.lastIndexOf('/')
  return i === -1 ? filePath : filePath.slice(i + 1)
}

/** Strip a Markdown extension, for display. */
export function stripMdExt(name: string): string {
  return name.replace(/\.(md|markdown|mdown|mkd)$/i, '')
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/** True for absolute URLs / data URIs that should be left untouched. */
export function isExternalRef(ref: string): boolean {
  return SCHEME.test(ref) || ref.startsWith('//')
}

/**
 * Resolve a relative reference (image, data file, link) against the directory
 * of the currently open file. Returns a clean vault-relative path, or null if
 * the reference is external or escapes the vault root.
 */
export function resolveRelative(currentFile: string, ref: string): string | null {
  if (!ref || isExternalRef(ref)) return null
  let clean = ref.split('#')[0].split('?')[0]
  try {
    clean = decodeURIComponent(clean)
  } catch {
    /* keep raw */
  }
  if (!clean) return null

  const base = dirOf(currentFile)
  const combined = clean.startsWith('/') ? clean.slice(1) : base ? `${base}/${clean}` : clean
  const out: string[] = []
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}
