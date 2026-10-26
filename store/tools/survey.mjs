// 候補の番組の映像を撮って見比べる（拡張機能なし）
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = process.argv.slice(2)
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, pipe: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'], defaultViewport: { width: 1280, height: 800 } })
try {
  const page = await browser.newPage()
  for (const id of list) {
    await page.goto(`https://live.nicovideo.jp/watch/${id}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    const ok = await page.waitForFunction(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 2 }, { timeout: 25000 }).then(() => true).catch(() => false)
    const info = await page.evaluate(() => ({ title: document.title.split(' - ')[0], provider: document.querySelector('[class*="provider"], [class*="channel-name"], [class*="user-name"]')?.textContent?.trim()?.slice(0, 40) }))
    const video = await page.$('video')
    if (ok && video) await video.screenshot({ path: `cand/${id}.png` }).catch(() => {})
    console.log(id, ok ? 'PLAYING' : 'no-video', JSON.stringify(info))
  }
} finally { await browser.close() }
