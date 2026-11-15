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
  check('welcome note active', (await page.locator('.crumb-file').innerText()).includes('welcome'))
  check('headings rendered', (await page.locator('.cm-header-1').count()) >= 1)
  check('inline formatting rendered', (await page.locator('.cm-strong').count()) >= 1)

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
  await page.locator('.search-input').fill('plotly')
  const gotResults = await waitFor(async () => (await page.locator('.content-item').count()) >= 2, 8000)
  check('content search returns matches', gotResults)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  check(
    'content search opened a note',
    (await page.locator('.crumb-file').innerText()).length > 0,
    await page.locator('.crumb-file').innerText(),
  )

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
  await browser.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log(`Failed: ${failed.map((f) => f.name).join(', ')}`)
  process.exit(1)
}
