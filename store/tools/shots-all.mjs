// ストア用のスクリーンショットの素材を撮る（1280×800）
// 番組を録画してから、視聴ページ（録画バー）・プレイバックのウィンドウ・設定・録画一覧を撮る
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

// 読み込む拡張機能（npm run build で作る .output/chrome-mv3 のフォルダ）
const EXT = process.env.EXT
if (!EXT) throw new Error('EXT に .output/chrome-mv3 のフォルダを指定してください')
const OUT = new URL('shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
fs.mkdirSync(OUT, { recursive: true })
const MAIN = process.env.MAIN
if (!MAIN) throw new Error('MAIN に撮る番組の URL を指定してください')
// 一緒に録画して、録画一覧に並べる番組（任意。カンマ区切り）
const OTHERS = (process.env.OTHERS || '').split(',').filter(Boolean)
const RECORD_MS = Number(process.env.RECORD_MS || 150000)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// 広告などを隠す（撮る画面に関係ないもの）
const HIDE_CSS = `
  iframe[src*="googlesyndication"], iframe[id*="google_ads"], [id*="google_ads"], [class*="___ad-"], [class*="AdContainer"], [class*="ad-banner"],
  [class*="___banner"], [class*="___information-panel"] { visibility: hidden !important; }
`

// 広告・お知らせの吹き出しを隠す（撮る画面に関係ないもの）
const hidePopups = (page) => page.evaluate(() => {
  const style = document.createElement('style')
  style.textContent = '#player-ad-panel, [class*="___player-ad-panel___"], iframe[id^="ads_"], [class*="___announcement-renderer___"] { visibility: hidden !important; }'
  document.head.append(style)
  for (const text of ['広告を見ると', 'Xでシェアして', 'シェアして応援']) {
    for (const el of document.querySelectorAll('body *')) {
      if (el.childElementCount > 0 || !el.textContent?.includes(text)) continue
      let target = el
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const position = getComputedStyle(e).position
        if (position === 'absolute' || position === 'fixed') { target = e; break }
      }
      target.style.setProperty('visibility', 'hidden', 'important')
    }
  }
})

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
  // コメントなし・コメントありの両方を録る
  await setup.evaluate(() => chrome.storage.local.set({ RECORD_VIDEO: true, RECORD_WITH_COMMENTS: true, MAX_STORAGE_SIZE: 10 * 1024 ** 3 }))
  await setup.close()

  const open = async (url) => {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.addStyleTag({ content: HIDE_CSS }).catch(() => {})
    await page.waitForFunction(() => document.getElementById('recordStatus')?.textContent === '録画中', { timeout: 60000 })
    log('recording', (await page.title()).slice(0, 50))
    return page
  }
  const others = []
  for (const url of OTHERS) others.push(await open(url).catch(e => { log('skip', url, e.message); return null }))
  const main = await open(MAIN)
  log(`recording for ${RECORD_MS / 1000}s`)
  await sleep(RECORD_MS)
  for (const page of others) await page?.close()

  // 1. 視聴ページと録画バー（プレイヤーと録画バーが入るようにスクロール）
  await main.bringToFront()
  await hidePopups(main)
  await main.evaluate(() => {
    const bar = document.getElementById('playbackRecorderBar')
    const top = bar.getBoundingClientRect().bottom + window.scrollY - 760
    window.scrollTo(0, Math.max(0, top))
  })
  await sleep(1500)
  await hidePopups(main)
  await main.mouse.move(0, 0)
  await main.screenshot({ path: OUT + 'raw-watch.png' })
  const regions = await main.evaluate(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height } }
    return { bar: r(document.getElementById('playbackRecorderBar')), video: r(document.querySelector('video')) }
  })
  fs.writeFileSync(OUT + 'regions.json', JSON.stringify(regions, null, 2))
  log('regions', JSON.stringify(regions))

  // 2. プレイバックのウィンドウ
  await main.click('#playbackButton')
  await main.waitForFunction(() => { const v = window.documentPictureInPicture?.window?.document.querySelector('video'); return v && v.readyState >= 2 && v.currentTime > 0 }, { timeout: 30000 })
  await sleep(2000)
  // プレイバックの画面がある about:blank（起動時の空のタブではなく）。headless では、大きさを決めてから撮る
  const pip = (await Promise.all(browser.targets().filter(t => t.type() === 'page' || t.type() === 'other').map(async t => {
    const p = await t.asPage().catch(() => null)
    const has = p ? await p.evaluate(() => !!document.querySelector('.review .seek')).catch(() => false) : false
    return has ? p : null
  }))).find(Boolean)
  if (!pip) throw new Error('no pip page')
  await pip.setViewport({ width: 640, height: 400, deviceScaleFactor: 1 })
  await sleep(6000)
  await pip.screenshot({ path: OUT + 'raw-pip.png' })
  await hidePopups(main)
  await main.screenshot({ path: OUT + 'raw-watch-pip.png' })
  log('pip size', JSON.stringify(await pip.evaluate(() => ({ w: innerWidth, h: innerHeight }))))
  await main.click('#playbackButton')
  await sleep(1000)

  // 3. 設定
  await main.click('#settingsButton')
  await main.waitForFunction(() => document.getElementById('settingsModal')?.open, { timeout: 5000 })
  await sleep(1000)
  await hidePopups(main)
  await main.screenshot({ path: OUT + 'raw-settings.png' })
  await main.keyboard.press('Escape')
  await sleep(500)

  // 4. 録画一覧（見ている番組を選んで再生）
  const lib = await browser.newPage()
  await lib.goto(`chrome-extension://${extId}/library.html`)
  await sleep(3000)
  const titles = await lib.$$eval('.program-item .card-title', items => items.map(i => i.textContent))
  log('programs', JSON.stringify(titles))
  const mainTitle = (await main.title()).split(' - ')[0].trim()
  await lib.evaluate((t) => {
    const items = [...document.querySelectorAll('.program-item')]
    ;(items.find(i => i.querySelector('.card-title')?.textContent?.trim() === t) ?? items[0]).click()
  }, mainTitle)
  await sleep(2500)
  await lib.click('.review .play').catch(() => {})
  await sleep(5000)
  await lib.screenshot({ path: OUT + 'raw-library.png' })
  // コメントありに切り替える
  const switched = await lib.evaluate(() => {
    const b = [...document.querySelectorAll('.review [data-kind]')].find(e => e.getAttribute('data-kind') === 'comments')
    if (!b) return false
    b.click()
    return true
  })
  await sleep(4000)
  await lib.screenshot({ path: OUT + 'raw-library-comments.png' })
  log('switched to comments:', switched)
} catch (e) {
  log('ERROR', e.stack)
} finally {
  await browser.close()
}
