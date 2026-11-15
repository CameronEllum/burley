/** Project identity and GitHub helpers (About, bug reports, release links). */

export const REPO_URL = 'https://github.com/CameronEllum/burley'
export const RELEASES_URL = `${REPO_URL}/releases`
export const ISSUES_URL = `${REPO_URL}/issues`

/** GitHub "new issue" URL prefilled with the environment details we need. */
export function bugReportUrl(repo: string, version: string, notePath = ''): string {
  const base = repo || REPO_URL
  const agent = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown browser'
  const body = [
    '### What happened?',
    '',
    '',
    '### Steps to reproduce',
    '',
    '1. ',
    '2. ',
    '',
    '### Environment',
    '',
    `- Burley: ${version || 'unknown'}`,
    `- Browser: ${agent}`,
    notePath ? `- Note: \`${notePath}\`` : '- Note: (none open)',
    '- Served from: local binary / EC2',
    '',
    '---',
    '_Reported from Burley’s About page._',
  ].join('\n')

  const params = new URLSearchParams({
    title: 'Bug: ',
    body,
    labels: 'bug',
  })
  return `${base}/issues/new?${params.toString()}`
}

export function openExternal(url: string): void {
  if (typeof window === 'undefined') return
  window.open(url, '_blank', 'noopener,noreferrer')
}
