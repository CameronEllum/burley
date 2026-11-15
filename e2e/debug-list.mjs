import { chromium } from 'playwright'

const BASE = process.env.BURLEY_URL ?? 'http://127.0.0.1:8080'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForSelector('.cm-content')
await page.waitForTimeout(800)
await page.keyboard.press('Control+p')
await page.waitForSelector('.search-modal')
await page.locator('.search-input').fill('feature-tour')
await page.waitForTimeout(200)
await page.keyboard.press('Enter')
await page.waitForTimeout(800)
await page.locator('.cm-scroller').evaluate((el) => {
  el.scrollTop = 700
})
await page.waitForTimeout(500)
const info = await page.evaluate(() => {
  const el = document.querySelector('.cm-burley-list-mark.ordered')
  if (!el) return { error: 'no ordered marker' }
  const cs = getComputedStyle(el)
  const parent = el.parentElement
  const pcs = parent ? getComputedStyle(parent) : null
  return {
    html: el.outerHTML,
    parentHtml: parent?.outerHTML,
    styles: {
      fontSize: cs.fontSize,
      letterSpacing: cs.letterSpacing,
      wordSpacing: cs.wordSpacing,
      transform: cs.transform,
      maxWidth: cs.maxWidth,
      width: cs.width,
      overflow: cs.overflow,
      display: cs.display,
      position: cs.position,
      fontFamily: cs.fontFamily,
      zoom: cs.zoom,
    },
    parentStyles: pcs
      ? {
          fontSize: pcs.fontSize,
          letterSpacing: pcs.letterSpacing,
          transform: pcs.transform,
          display: pcs.display,
          overflow: pcs.overflow,
          maxWidth: pcs.maxWidth,
        }
      : null,
  }
})
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: 'debug-lists.png' })
await browser.close()
