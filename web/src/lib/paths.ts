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

/** True for Markdown files (.md / .markdown / .mdown / .mkd). */
export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(filePath)
}

/** True for HTML files (.html / .htm). */
export function isHtmlPath(filePath: string): boolean {
  return /\.(html|htm)$/i.test(filePath)
}

/** Build a Burley app URL for opening `target` (`path` or `path#slug`) in a tab. */
export function noteTabUrl(target: string): string {
  const hashIdx = target.indexOf('#')
  const path = hashIdx >= 0 ? target.slice(0, hashIdx) : target
  const hash = hashIdx >= 0 ? target.slice(hashIdx + 1) : ''
  const url = new URL(window.location.href)
  if (path) url.searchParams.set('file', path)
  else url.searchParams.delete('file')
  url.hash = hash ? `#${hash}` : ''
  return url.toString()
}

/** Open a vault note (`path` or `path#slug`) in a new browser tab. */
export function openNoteInNewTab(target: string): void {
  window.open(noteTabUrl(target), '_blank', 'noopener,noreferrer')
}

/** Format a byte count into a human-friendly size string. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  if (unit === 0) return `${Math.round(value)} B`
  const formatted = value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  return `${formatted.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1')} ${units[unit]}`
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
