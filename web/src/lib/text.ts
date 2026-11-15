/**
 * Line-ending and BOM handling.
 *
 * CodeMirror stores the document with "\n" separators, so the original
 * formatting is captured when a file is loaded and re-applied on save. This
 * keeps saves lossless for CRLF files and files with/without a trailing
 * newline.
 */

export interface TextFormat {
  eol: '\n' | '\r\n'
  bom: boolean
}

export const defaultFormat: TextFormat = { eol: '\n', bom: false }

export function decodeForEditor(raw: string): { text: string; format: TextFormat } {
  const bom = raw.charCodeAt(0) === 0xfeff
  const body = bom ? raw.slice(1) : raw
  const eol: '\n' | '\r\n' = body.includes('\r\n') ? '\r\n' : '\n'
  const text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return { text, format: { eol, bom } }
}

export function encodeForSave(text: string, format: TextFormat): string {
  const body = format.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
  return format.bom ? '\ufeff' + body : body
}

/** Word count that ignores code-ish punctuation runs. */
export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
  return matches ? matches.length : 0
}
