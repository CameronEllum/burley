/** Prompts and helpers for the selection AI toolbar. */

export type SparkleAction = 'ask' | 'explain' | 'summarize' | 'shorten' | 'rewrite'

export const SPARKLE_LABELS: Record<SparkleAction, string> = {
  ask: 'Ask',
  explain: 'Explain',
  summarize: 'Summarize',
  shorten: 'Shorten',
  rewrite: 'Rewrite',
}

export const SPARKLE_PROMPTS: Record<Exclude<SparkleAction, 'ask'>, string> = {
  explain:
    'Explain the selected text clearly and concisely. Define unfamiliar terms and preserve technical accuracy.',
  summarize:
    'Summarize the selected text in a few short bullet points. Keep only the essential information.',
  shorten:
    'Shorten the selected text while preserving its meaning, tone and formatting. Return only the shortened text.',
  rewrite:
    'Rewrite the selected text to be clearer and more polished. Preserve its meaning and Markdown formatting. Return only the rewritten text with no commentary or code fences.',
}

/** Strip a wrapping code fence the agent sometimes adds around a rewrite. */
export function cleanSuggestion(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return fenced ? fenced[1].trim() : trimmed
}
