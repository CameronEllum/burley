/**
 * Browser smoke test for Burley.
 *
 * Run the server first:
 *   .\bin\burley.exe --root .\demo-vault --addr 127.0.0.1:8080
 * then:
 *   cd e2e && npm run smoke
 */
import { chromium } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BURLEY_URL ?? 'http://127.0.0.1:8080'
const here = path.dirname(fileURLToPath(import.meta.url))
const vault = path.resolve(here, '..', 'demo-vault')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  [${extra}]` : ''}`)
}

async function getFile(p) {
  const res = await fetch(`${BASE}/api/file?path=${encodeURIComponent(p)}`)
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`)
  return res.json()
}

async function putFile(p, content, expectedHash) {
  const res = await fetch(`${BASE}/api/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, content, expectedHash }),
  })
  if (!res.ok) throw new Error(`PUT ${p}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function getFavorites() {
  const res = await fetch(`${BASE}/api/favorites`)
  if (!res.ok) throw new Error(`GET favorites: ${res.status}`)
  return (await res.json()).favorites
}

async function putFavorites(favorites) {
  const res = await fetch(`${BASE}/api/favorites`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorites }),
  })
  if (!res.ok) throw new Error(`PUT favorites: ${res.status} ${await res.text()}`)
  return (await res.json()).favorites
}

async function getSettings() {
  const res = await fetch(`${BASE}/api/settings`)
  if (!res.ok) throw new Error(`GET settings: ${res.status}`)
  return res.json()
}

async function putSettings(settings) {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  })
  if (!res.ok) throw new Error(`PUT settings: ${res.status} ${await res.text()}`)
  return res.json()
}

async function getRecent() {
  const res = await fetch(`${BASE}/api/recent`)
  if (!res.ok) throw new Error(`GET recent: ${res.status}`)
  return (await res.json()).recent
}

async function putRecent(recent) {
  const res = await fetch(`${BASE}/api/recent`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recent }),
  })
  if (!res.ok) throw new Error(`PUT recent: ${res.status} ${await res.text()}`)
  return (await res.json()).recent
}

async function waitFor(fn, timeout = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const original = {
  welcome: await getFile('welcome.md'),
  crlf: await getFile('notes/crlf-note.md'),
}
const originalFavorites = await getFavorites()
const originalSettings = await getSettings()
const originalRecent = await getRecent()
await putSettings({ theme: 'system', wideMode: false })
await putRecent([])

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } })
const page = await context.newPage()

const consoleErrors = []
const requestFailures = []
page.on('console', (msg) => {
  if (msg.type() !== 'error') return
  // The deliberate stale-write test produces a 409 network log; that is an
  // expected API response, not a script error.
  if (msg.text().includes('409 (Conflict)')) return
  consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
page.on('requestfailed', (req) => requestFailures.push(`${req.url()} :: ${req.failure()?.errorText}`))

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(1200)

  check('page title is Burley', (await page.title()) === 'Burley')
  check('editor mounted', (await page.locator('.cm-content').count()) === 1)
  check('top bar no longer shows the file path', (await page.locator('.path-crumb').count()) === 0)
  const statusFile = await page.locator('.status-file').innerText()
  check(
    'status bar shows the full file path',
    statusFile.includes('demo-vault') && statusFile.includes('welcome.md'),
    statusFile,
  )
  check(
    'status bar shows the modification time',
    (await page.locator('.status-modified').innerText()).includes('modified'),
  )
  const searchBox = await page.locator('.search-trigger').boundingBox()
  check(
    'quick box is wide and centered',
    searchBox.width > 400 && Math.abs(searchBox.x + searchBox.width / 2 - 720) < 10,
    `${searchBox.width}px at ${Math.round(searchBox.x)}`,
  )
  const sidebarBox = await page.locator('.sidebar').boundingBox()
  const editorBox = await page.locator('.editor-pane').boundingBox()
  check('file tree is on the left', !!sidebarBox && !!editorBox && sidebarBox.x < editorBox.x)
  check('file tree lists root note', (await page.locator('.file-row').count()) >= 1)
  await page.locator('.dir-row').first().click()
  await page.waitForTimeout(300)
  check('tree expands folders', (await page.locator('.file-row').count()) >= 2)

  // Open the welcome note from the sidebar.
  await page.locator('.file-row', { hasText: 'welcome' }).click()
  await page.waitForTimeout(800)
  check('welcome note active', (await page.locator('.status-file').innerText()).includes('welcome.md'))
  check('headings rendered', (await page.locator('.cm-header-1').count()) >= 1)
  check('inline formatting rendered', (await page.locator('.cm-strong').count()) >= 1)

  // Link editing: Ctrl-click reveals source, plain click navigates.
  const internalLinkCount = await page.locator('.cm-burley-link-internal').count()
  await page.locator('.cm-burley-link-internal').first().click({ modifiers: ['Control'] })
  await page.waitForTimeout(400)
  check(
    'Ctrl-click makes a link editable',
    (await page.locator('.status-file').innerText()).includes('welcome.md') &&
      (await page.locator('.cm-burley-link-internal').count()) < internalLinkCount,
  )
  await page.locator('.cm-line').first().click()
  await page.waitForTimeout(300)
  await page.locator('.cm-burley-link-internal').first().click()
  await page.waitForTimeout(700)
  check('plain click opens an internal link', (await page.locator('.status-file').innerText()).includes('todo.md'))
  await page.locator('.file-row', { hasText: 'welcome' }).click()
  await page.waitForTimeout(600)

  const katexCount = await page.locator('.katex').count()
  check('KaTeX formulas rendered', katexCount >= 4, `${katexCount} formulas`)
  check('task checkboxes rendered', (await page.locator('.cm-burley-task input[type="checkbox"]').count()) >= 3)
  const headingDecoration = await page
    .locator('.cm-header-1')
    .first()
    .evaluate((el) => getComputedStyle(el).textDecorationLine)
  check('headings are not underlined', headingDecoration === 'none', headingDecoration)

  // Left sidebar tabs: Files | Outline (Typora style).
  check('sidebar has Files and Outline tabs', (await page.locator('.sidebar-tab').count()) === 2)
  await page.locator('.sidebar-tab', { hasText: 'Outline' }).click()
  await page.waitForTimeout(400)
  const outlineCount = await page.locator('.outline-item').count()
  check('outline lists the note headings', outlineCount >= 5, `${outlineCount} headings`)
  const mathItem = page.locator('.outline-item', { hasText: 'Math' }).first()
  const lineTitle = await mathItem.getAttribute('title')
  const targetLine = Number((lineTitle ?? '').replace(/\D+/g, ''))
  await mathItem.click()
  await page.waitForTimeout(500)
  const statusText = await page.locator('.statusbar').innerText()
  check(
    'outline jumps to the heading line',
    targetLine > 0 && statusText.includes(`Ln ${targetLine},`),
    statusText.replace(/\s+/g, ' '),
  )
  check(
    'outline highlights the current heading',
    await mathItem.evaluate((el) => el.classList.contains('active')),
  )
  await page.screenshot({ path: path.join(here, 'screenshot-outline.png') })
  await page.locator('.sidebar-tab', { hasText: 'Files' }).click()
  await page.waitForTimeout(300)
  check('Files tab restores the tree', (await page.locator('.tree-root').count()) === 1)

  // List markers stay visible in the live preview (feature-tour note).
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.search-modal', { timeout: 5000 })
  await page.locator('.search-input').fill('feature-tour')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  check('feature tour opened', (await page.locator('.crumb-file').innerText()).includes('feature-tour'))
  await page.locator('.sidebar-tab', { hasText: 'Outline' }).click()
  await page.waitForTimeout(300)
  await page.locator('.outline-item', { hasText: 'Lists' }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.sidebar-tab', { hasText: 'Files' }).click()
  await page.waitForTimeout(300)
  const bullets = page.locator('.cm-burley-list-mark.bullet')
  const ordered = page.locator('.cm-burley-list-mark.ordered')
  check('unordered list bullets are visible', (await bullets.count()) >= 2, `${await bullets.count()} bullets`)
  check('ordered list numbers are visible', (await ordered.count()) >= 1, `${await ordered.count()} numbers`)
  const bulletGlyph = await bullets
    .first()
    .evaluate((el) => getComputedStyle(el, '::before').content)
  check('bullet glyph rendered', /[•◦▪]/.test(bulletGlyph), bulletGlyph)
  const orderedWidth = await ordered.first().evaluate((el) => el.getBoundingClientRect().width)
  check('ordered marker has visible width', orderedWidth > 5, `${orderedWidth}px`)
  await page.screenshot({ path: path.join(here, 'screenshot-lists.png') })
  await page.locator('.file-row', { hasText: 'welcome' }).click()
  await page.waitForTimeout(600)

  // CodeMirror virtualizes the viewport, so walk the note to exercise every
  // widget type (plotly, code block, image chart) as it scrolls into view.
  const scroller = page.locator('.cm-scroller')
  const seen = { plotly: false, go: false, image: false, chart: false, table: false }
  let chartShot = false
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    await scroller.evaluate((el, f) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * f
    }, fraction)
    await page.waitForTimeout(900)
    if ((await page.locator('.cm-burley-block[data-lang="plotly"]').count()) > 0) seen.plotly = true
    if ((await page.locator('.cm-burley-block[data-lang="go"]').count()) > 0) seen.go = true
    if ((await page.locator('.cm-table-widget table').count()) > 0) seen.table = true
    if ((await page.locator('.plotly .main-svg').count()) > 0) seen.chart = true
    if ((await page.locator('.cm-burley-image img').count()) > 0) {
      const ok = await page
        .locator('.cm-burley-image img')
        .first()
        .evaluate((img) => img.complete && img.naturalWidth > 0)
      if (ok) seen.image = true
    }
    if (!chartShot && seen.chart) {
      await page.locator('.cm-burley-block[data-lang="plotly"]').first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(700)
      await page.screenshot({ path: path.join(here, 'screenshot-chart.png') })
      chartShot = true
    }
  }
  if (!seen.chart) {
    await page.waitForTimeout(4000)
    await scroller.evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.7
    })
    await page.waitForTimeout(1500)
    seen.chart = (await page.locator('.plotly .main-svg').count()) > 0
    if (seen.chart) {
      await page.locator('.cm-burley-block[data-lang="plotly"]').first().scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(here, 'screenshot-chart.png') })
    }
  }
  check('plotly block rendered', seen.plotly)
  check('plotly chart drew an SVG', seen.chart)
  check('generic code block rendered', seen.go)
  check('relative image loaded', seen.image)
  check('GFM table rendered', seen.table)

  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })
  await page.waitForTimeout(500)

  // Quick open (fuzzy filename search).
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.search-modal', { timeout: 5000 })
  const paletteBox = await page.locator('.palette').boundingBox()
  check(
    'palette opens directly under the quick box',
    Math.abs(paletteBox.x - searchBox.x) < 6 &&
      Math.abs(paletteBox.y - (searchBox.y + searchBox.height + 6)) < 4,
    `palette ${Math.round(paletteBox.x)},${Math.round(paletteBox.y)}`,
  )
  check(
    'palette matches the quick-box width',
    Math.abs(paletteBox.width - searchBox.width) < 6,
    `${Math.round(paletteBox.width)}px`,
  )
  await page.locator('.search-input').fill('todo')
  await page.waitForTimeout(250)
  const firstResult = await page.locator('.search-item').first().innerText()
  check('fuzzy quick open finds todo', firstResult.toLowerCase().includes('todo'), firstResult.replace(/\s+/g, ' '))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  check('quick open navigated', (await page.locator('.crumb-file').innerText()).includes('todo'))

  // Content search.
  await page.keyboard.press('Control+Shift+F')
  await page.waitForSelector('.search-modal', { timeout: 5000 })
  const contentPrefix = await page.locator('.palette-input').inputValue()
  check('Ctrl+Shift+F prefills content mode', contentPrefix.startsWith('?'))
  await page.locator('.palette-input').fill('?plotly')
  const gotResults = await waitFor(async () => (await page.locator('.content-item').count()) >= 2, 8000)
  check('content search returns matches', gotResults)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  check(
    'content search opened a note',
    (await page.locator('.crumb-file').innerText()).length > 0,
    await page.locator('.crumb-file').innerText(),
  )

  // F1 opens an empty palette; @ headings; > commands; no-match fallback.
  await page.keyboard.press('F1')
  await page.waitForSelector('.palette', { timeout: 5000 })
  check('F1 opens the palette', (await page.locator('.palette-input').inputValue()) === '')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  await page.keyboard.press('Control+Shift+O')
  await page.waitForSelector('.palette', { timeout: 5000 })
  const headingPrefix = await page.locator('.palette-input').inputValue()
  check('Ctrl+Shift+O prefills heading mode', headingPrefix.startsWith('@'))
  await page.locator('.palette-input').fill('@math')
  await page.waitForTimeout(300)
  const headingRow = await page.locator('.search-item').first().innerText()
  const headingLineHint = await page.locator('.search-item .item-hint').first().innerText()
  const headingLine = Number(headingLineHint.replace(/\D+/g, ''))
  check('heading mode filters current-note headings', headingRow.toLowerCase().includes('math'), headingRow.replace(/\s+/g, ' '))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  check(
    'heading mode jumps to the heading',
    headingLine > 0 && (await page.locator('.statusbar').innerText()).includes(`Ln ${headingLine},`),
  )

  await page.keyboard.press('Control+p')
  await page.waitForSelector('.palette', { timeout: 5000 })
  await page.locator('.palette-input').fill('>sidebar')
  await page.waitForTimeout(300)
  const commandRow = await page.locator('.search-item').first().innerText()
  check('command mode finds sidebar action', commandRow.toLowerCase().includes('sidebar'), commandRow.replace(/\s+/g, ' '))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  check('command mode executes the action', (await page.locator('.sidebar.closed').count()) === 1)
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(200)

  await page.keyboard.press('Control+p')
  await page.waitForSelector('.palette', { timeout: 5000 })
  await page.locator('.palette-input').fill('zzzznotafile')
  await page.waitForTimeout(300)
  check(
    'no matches shows the content-search fallback',
    (await page.locator('.palette-message').innerText()).includes('No matching files') &&
      (await page.locator('.search-item').last().innerText()).includes('Search inside file contents'),
  )
  await page.locator('.search-item').last().click()
  await page.waitForTimeout(300)
  check(
    'fallback switches to content mode',
    (await page.locator('.palette-input').inputValue()).startsWith('?zzzznotafile'),
  )
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  // Read-only lock.
  await page.locator('.toggle-btn').click()
  await page.waitForTimeout(300)
  check('read-only toggle active', (await page.locator('.toggle-btn.on').count()) === 1)
  check(
    'editor is not editable in read-only mode',
    (await page.locator('.cm-content').getAttribute('contenteditable')) === 'false',
  )
  check('read-only indicator in status bar', (await page.locator('.status-item.lock').count()) === 1)
  await page.locator('.toggle-btn').click()
  await page.waitForTimeout(200)

  // Autosave.
  await page.locator('.file-row', { hasText: 'welcome' }).click()
  await page.waitForTimeout(800)
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nAUTOSAVE_MARKER')
  const saved = await waitFor(async () => (await page.locator('.pill').innerText()).trim() === 'Saved', 8000)
  check('autosave reports Saved', saved, (await page.locator('.pill').innerText()).trim())
  const afterSave = await getFile('welcome.md')
  check('autosave persisted to disk', afterSave.content.includes('AUTOSAVE_MARKER'))
  await putFile('welcome.md', original.welcome.content, afterSave.hash)

  // CRLF round-trip through the UI save path.
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.search-modal', { timeout: 5000 })
  await page.locator('.search-input').fill('crlf')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('Z')
  const crlfSaved = await waitFor(async () => (await page.locator('.pill').innerText()).trim() === 'Saved', 8000)
  const crlfFile = await getFile('notes/crlf-note.md')
  check(
    'CRLF preserved on UI save',
    crlfSaved &&
      crlfFile.content.includes('\r\nZ') &&
      !crlfFile.content.replace(/\r\n/g, '').includes('\n'),
    JSON.stringify(crlfFile.content.slice(-10)),
  )
  await putFile('notes/crlf-note.md', original.crlf.content, crlfFile.hash)

  // Conflict detection: edit on disk, then type in the browser.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(800)
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.search-modal', { timeout: 5000 })
  await page.locator('.search-input').fill('crlf')
  await page.waitForTimeout(250)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  check('crlf note opened for conflict test', (await page.locator('.crumb-file').innerText()).includes('crlf'))
  const external = '# Changed outside Burley\n\nAn external editor wrote this.\n'
  await putFile('notes/crlf-note.md', external, original.crlf.hash)
  await page.locator('.cm-line').first().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nlocal edit')
  const conflictVisible = await waitFor(async () => (await page.locator('.conflict-modal').count()) === 1, 8000)
  check('conflict modal appears on external change', conflictVisible)
  if (conflictVisible) {
    check(
      'conflict modal names the file',
      (await page.locator('.conflict-modal').innerText()).includes('crlf-note.md'),
    )
    await page.screenshot({ path: path.join(here, 'screenshot-conflict.png') })
    await page.locator('.conflict-modal .secondary').click()
    await page.waitForTimeout(600)
    check(
      'take theirs reloaded disk content',
      (await page.locator('.cm-content').innerText()).includes('Changed outside Burley'),
    )
    check('save pill back to Saved', (await page.locator('.pill').innerText()).trim() === 'Saved')
  }
  const afterConflict = await getFile('notes/crlf-note.md')
  await putFile('notes/crlf-note.md', original.crlf.content, afterConflict.hash)

  // Sidebar collapse.
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(250)
  check('sidebar collapses with Ctrl+B', (await page.locator('.sidebar.closed').count()) === 1)
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(200)

  // Resizable sidebar (drag + keyboard + persistence + reset).
  const sidebarBefore = (await page.locator('.sidebar').boundingBox()).width
  const resizer = page.locator('.sidebar-resizer')
  const handleBox = await resizer.boundingBox()
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 120)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 90, handleBox.y + 120, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const sidebarAfter = (await page.locator('.sidebar').boundingBox()).width
  check(
    'sidebar can be resized by dragging',
    sidebarAfter >= sidebarBefore + 70,
    `${sidebarBefore}px -> ${sidebarAfter}px`,
  )
  const storedWidth = Number(await page.evaluate(() => localStorage.getItem('burley:sidebar-width')))
  check('sidebar width persists', Math.abs(storedWidth - sidebarAfter) <= 2, `${storedWidth}px`)
  await resizer.focus()
  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  const sidebarKeyboard = (await page.locator('.sidebar').boundingBox()).width
  check('sidebar resizer supports arrow keys', sidebarKeyboard < sidebarAfter, `${sidebarKeyboard}px`)
  await resizer.dblclick()
  await page.waitForTimeout(200)
  const sidebarReset = (await page.locator('.sidebar').boundingBox()).width
  check('double-click resets sidebar width', Math.abs(sidebarReset - 302) <= 2, `${sidebarReset}px`)

  // Theme: follows the OS by default and cycles system → light → dark.
  const themeButton = page.locator('button[aria-label^="Theme:"]')
  check('theme defaults to follow system', (await themeButton.getAttribute('aria-label'))?.includes('follow system'))
  check(
    'theme resolved from the OS',
    ['light', 'dark'].includes(await page.evaluate(() => document.documentElement.dataset.theme ?? '')),
  )
  await themeButton.click()
  await page.waitForTimeout(150)
  check('theme switches to light', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light')
  await themeButton.click()
  await page.waitForTimeout(150)
  check('theme switches to dark', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  check('dark palette applied', darkBackground === 'rgb(23, 20, 15)', darkBackground)
  await themeButton.click()
  await page.waitForTimeout(150)
  check(
    'theme cycles back to system',
    (await themeButton.getAttribute('aria-label'))?.includes('follow system'),
  )

  // Narrow / wide reading width.
  const contentEl = page.locator('.cm-content')
  const narrowContentWidth = (await contentEl.boundingBox()).width
  const wideButton = page.locator('button[aria-label="Toggle wide reading mode"]')
  await wideButton.click()
  await page.waitForTimeout(350)
  const wideContentWidth = (await contentEl.boundingBox()).width
  check(
    'wide mode expands the reading measure',
    wideContentWidth > narrowContentWidth + 120,
    `${narrowContentWidth}px -> ${wideContentWidth}px`,
  )
  check(
    'wide mode persists',
    (await page.evaluate(() => localStorage.getItem('burley:wide-mode'))) === '1',
  )
  await page.screenshot({ path: path.join(here, 'screenshot-wide.png') })
  await wideButton.click()
  await page.waitForTimeout(350)
  const backToNarrow = (await contentEl.boundingBox()).width
  check(
    'wide mode toggles back to narrow',
    Math.abs(backToNarrow - narrowContentWidth) < 4,
    `${backToNarrow}px`,
  )

  // Settings live in .burley/settings.yaml and survive a reload.
  await themeButton.click()
  await page.waitForTimeout(120)
  await themeButton.click()
  await page.waitForTimeout(120)
  await wideButton.click()
  await page.waitForTimeout(600)
  const savedSettings = await getSettings()
  check(
    'settings saved to .burley/settings.yaml',
    savedSettings.exists === true &&
      savedSettings.settings.theme === 'dark' &&
      savedSettings.settings.wideMode === true,
    JSON.stringify(savedSettings),
  )
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(800)
  check(
    'theme restored from server settings',
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
  )
  const restoredWide = (await page.locator('.cm-content').boundingBox()).width
  check('wide mode restored from server settings', restoredWide > 900, `${restoredWide}px`)
  await putSettings(originalSettings.settings)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(700)


  // Favorites: star, fuzzy filter, empty Ctrl+P ordering, persistence, missing files.
  await putFavorites([])
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(700)
  await page.locator('.file-row', { hasText: 'welcome' }).click()
  await page.waitForTimeout(600)

  await page.locator('button[aria-label="Toggle favorite"]').click()
  await page.waitForTimeout(500)
  check('starring the active note adds a favorite', (await page.locator('.favorite-item').count()) === 1)
  check('favorite persisted to YAML API', (await getFavorites()).includes('welcome.md'))

  const todoRow = page.locator('.file-row', { hasText: 'todo' }).first()
  await todoRow.hover()
  await todoRow.locator('..').locator('.row-star').click()
  await page.waitForTimeout(500)
  check('tree hover star adds another favorite', (await page.locator('.favorite-item').count()) === 2)
  const twoFavorites = await getFavorites()
  check(
    'favorites keep insertion order',
    twoFavorites.length === 2 && twoFavorites[0] === 'welcome.md',
    twoFavorites.join(', '),
  )

  const favoritesDivider = await page
    .locator('.favorites')
    .evaluate((el) => getComputedStyle(el).borderBottomWidth)
  check('divider separates favorites from the tree', favoritesDivider === '1px', favoritesDivider)

  await page.locator('.tree-filter').fill('wel')
  await page.waitForTimeout(300)
  const filteredFavoriteText = await page.locator('.favorite-item').first().innerText()
  check(
    'filter box filters favorites',
    (await page.locator('.favorite-item').count()) === 1 && filteredFavoriteText.includes('welcome'),
  )
  await page.locator('.tree-filter').fill('zzz-no-such-note')
  await page.waitForTimeout(300)
  check('favorites section hides when nothing matches', (await page.locator('.favorites').count()) === 0)
  await page.locator('.tree-filter').fill('')
  await page.waitForTimeout(200)

  await page.keyboard.press('Control+p')
  await page.waitForSelector('.search-modal', { timeout: 5000 })
  const pinnedResults = await page.locator('.search-item .pin').count()
  const firstSearchResult = await page.locator('.search-item').first().innerText()
  check('empty Ctrl+P lists favorites first', pinnedResults >= 2 && firstSearchResult.includes('welcome'), firstSearchResult.replace(/\s+/g, ' '))
  check('palette divides favorites from other files', (await page.locator('.palette-divider').count()) === 1)
  const recentHints = await page.locator('.palette-item .item-hint', { hasText: 'Recent' }).count()
  check('recent files appear below favorites', recentHints >= 1, `${recentHints} recent`)
  const serverRecent = await getRecent()
  check('recents stored in .burley/recent.yaml', serverRecent.length > 0, serverRecent.join(', '))
  const recentYaml = await fs.readFile(path.join(vault, '.burley', 'recent.yaml'), 'utf8')
  check(
    'recent.yaml is a YAML list',
    recentYaml.includes('recent:') && recentYaml.includes('- "'),
    recentYaml.split('\n').slice(0, 3).join(' | '),
  )
  await page.locator('.palette-input').fill('wel')
  await page.waitForTimeout(300)
  check('matched filename characters are highlighted', (await page.locator('.palette-item mark').count()) >= 1)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(here, 'screenshot-favorites.png') })

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(800)
  check('favorites survive a reload', (await page.locator('.favorite-item').count()) === 2)

  const welcomeFavorite = page.locator('.favorite-item', { hasText: 'welcome' }).first()
  await welcomeFavorite.hover()
  await welcomeFavorite.locator('.favorite-remove').click()
  await page.waitForTimeout(500)
  check('removing a favorite updates the list', (await page.locator('.favorite-item').count()) === 1)

  await putFavorites(['welcome.md', 'notes/ghost.md'])
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.cm-content', { timeout: 15000 })
  await page.waitForTimeout(700)
  check('missing favorites are shown dimmed', (await page.locator('.favorite-item.missing').count()) === 1)
  await page.locator('.favorite-item.missing .favorite-remove').click()
  await page.waitForTimeout(500)
  check('missing favorite can be removed', (await page.locator('.favorite-item.missing').count()) === 0)

  await putFavorites(originalFavorites)


  // Visual snapshot (light).
  await page.locator('.file-row', { hasText: 'welcome' }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: path.join(here, 'screenshot.png') })

  // A separate context with an OS dark preference verifies first-load theming.
  const darkContext = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: 'dark',
  })
  const darkPage = await darkContext.newPage()
  await darkPage.goto(`${BASE}/`, { waitUntil: 'networkidle' })
  await darkPage.waitForSelector('.cm-content', { timeout: 15000 })
  await darkPage.waitForTimeout(2500)
  check(
    'OS dark preference applied on first load',
    (await darkPage.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
  )
  await darkPage.screenshot({ path: path.join(here, 'screenshot-dark.png') })
  await darkContext.close()

  // Quit flow (API intercepted so the test server keeps running).
  await page.route('**/api/quit', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"shutting_down"}' }),
  )
  await page.locator('.quit-btn').click()
  await page.waitForSelector('.quit-modal', { timeout: 5000 })
  check('quit confirmation shown', (await page.locator('.quit-modal').count()) === 1)
  await page.screenshot({ path: path.join(here, 'screenshot-quit.png') })
  await page.locator('.quit-modal .danger').click()
  await page.waitForSelector('.shutdown-screen', { timeout: 5000 })
  check('shutdown overlay shown after quit', (await page.locator('.shutdown-screen').count()) === 1)

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 4).join(' | '))
  check('no failed requests', requestFailures.length === 0, requestFailures.slice(0, 4).join(' | '))
} finally {
  // Restore fixtures even if a check threw.
  for (const [file, data] of [
    ['welcome.md', original.welcome],
    ['notes/crlf-note.md', original.crlf],
  ]) {
    try {
      const current = await getFile(file)
      if (current.content !== data.content) {
        await putFile(file, data.content, current.hash)
      }
    } catch {
      /* ignore */
    }
  }
  try {
    await putFavorites(originalFavorites)
  } catch {
    /* ignore */
  }
  try {
    await putSettings(originalSettings.settings)
  } catch {
    /* ignore */
  }
  try {
    await putRecent(originalRecent)
  } catch {
    /* ignore */
  }
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`Failed: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
