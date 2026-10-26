// ストア用の「コメントあり」の1枚（4-comments）の素材を撮る
// コメントの少ない番組でも撮れるように、ニコ生のコメントの canvas に見本のコメントを流してから録画する
// （ストアの画像は「イメージ」。実際の視聴者のコメントではない）
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

// 読み込む拡張機能（npm run build で作る .output/chrome-mv3 のフォルダ）
const EXT = process.env.EXT
if (!EXT) throw new Error('EXT に .output/chrome-mv3 のフォルダを指定してください')
const OUT = new URL('shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
fs.mkdirSync(OUT, { recursive: true })
const MAIN = process.env.MAIN
if (!MAIN) throw new Error('MAIN に撮る番組の URL を指定してください')
const RECORD_MS = Number(process.env.RECORD_MS || 60000)
const COMMENTS = (process.env.COMMENTS || 'のどかだなぁ,癒やされる,山がきれい,空気おいしそう,ひこばえ伸びてる,落ち着く,秋田いいね,定点ありがたい,稲刈りのあとかな,888888').split(',')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const hidePopups = (page) => page.evaluate(() => {
  const style = document.createElement('style')
  style.textContent = '#player-ad-panel, [class*="___player-ad-panel___"], iframe[id^="ads_"], [class*="___announcement-renderer___"] { visibility: hidden !important; }'
  document.head.append(style)
})

// コメントの canvas に、右から左へ流れる見本のコメントを描き続ける（ニコ生の描画の後に、毎回描き直す）
const flowComments = (page) => page.evaluate((comments) => {
  const canvas = document.querySelector('[class*="___comment-layer___"] canvas')
  const ctx = canvas?.getContext('2d')
  if (!ctx) return false
  const DURATION = 4000
  const LINES = 11
  const lineHeight = canvas.height / LINES
  const active = []
  let next = 0
  let spawnAt = performance.now()
  const draw = (now) => {
    if (now >= spawnAt) {
      const text = comments[next % comments.length]
      const used = new Set(active.filter(c => now - c.start < DURATION / 2).map(c => c.line))
      let line = 0
      while (used.has(line) && line < LINES - 1) line++
      active.push({ text, start: now, line })
      next++
      spawnAt = now + 650
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.font = `bold ${Math.round(lineHeight * 0.72)}px "Yu Gothic UI", "Meiryo", sans-serif`
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'
    for (let i = active.length - 1; i >= 0; i--) {
      const c = active[i]
      const width = ctx.measureText(c.text).width
      const progress = (now - c.start) / DURATION
      if (progress > 1) { active.splice(i, 1); continue }
      const x = canvas.width - progress * (canvas.width + width)
      const y = c.line * lineHeight + lineHeight * 0.12
      ctx.lineWidth = 5
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.strokeText(c.text, x, y)
      ctx.fillStyle = '#fff'
      ctx.fillText(c.text, x, y)
    }
    requestAnimationFrame(draw)
  }
  requestAnimationFrame(draw)
  return true
}, COMMENTS)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, enableExtensions: true, pipe: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--screen-info={1920x1080}'],
  defaultViewport: { width: 1280, height: 800 }, protocolTimeout: 180000,
})
try {
  const extId = await browser.installExtension(EXT)
  const setup = await browser.newPage()
  await setup.goto(`chrome-extension://${extId}/bridge.html`)
  await setup.evaluate(() => chrome.storage.local.set({ RECORD_VIDEO: true, RECORD_WITH_COMMENTS: true, MAX_STORAGE_SIZE: 10 * 1024 ** 3 }))
  await setup.close()

  const main = await browser.newPage()
  await main.goto(MAIN, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await main.waitForSelector('[class*="___comment-layer___"] canvas', { timeout: 60000 })
  log('flowing comments:', await flowComments(main))
  await hidePopups(main)
  await main.waitForFunction(() => document.getElementById('recordStatus')?.textContent === '録画中', { timeout: 60000 })
  log(`recording ${RECORD_MS / 1000}s`)
  await sleep(RECORD_MS)
  await main.screenshot({ path: OUT + 'raw-watch-comments.png' })

  const lib = await browser.newPage()
  await lib.goto(`chrome-extension://${extId}/library.html`)
  await sleep(3000)
  await lib.evaluate(() => document.querySelector('.program-item')?.click())
  await sleep(2500)
  await lib.click('.review .play').catch(() => {})
  await sleep(3000)
  const switched = await lib.evaluate(() => {
    const b = [...document.querySelectorAll('.review [data-kind]')].find(e => e.getAttribute('data-kind') === 'comments')
    if (!b) return false
    b.click()
    return true
  })
  await sleep(5000)
  await lib.screenshot({ path: OUT + 'raw-library-comments.png' })
  log('switched to comments:', switched)
} catch (e) {
  log('ERROR', e.stack)
} finally {
  await browser.close()
}
