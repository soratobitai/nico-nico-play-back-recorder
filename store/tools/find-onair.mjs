// キーワードで放送中の番組を探し、番組の状態（ON_AIR など）を確かめる
import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const words = process.argv.slice(2)
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, pipe: true })
const statusOf = async (url) => {
  const h = await (await fetch(url)).text()
  const m = h.match(/id="embedded-data" data-props="([^"]*)"/)
  if (!m) return '?'
  const d = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  return `${d.program?.status} ${d.program?.providerType}`
}
try {
  const page = await browser.newPage()
  const seen = new Set()
  for (const word of words) {
    await page.goto('https://live.nicovideo.jp/search?status=onair&keyword=' + encodeURIComponent(word), { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    const items = await page.$$eval('a[href*="/watch/lv"]', as => [...new Map(as.map(a => [a.href.split('?')[0], (a.textContent || a.title || '').trim().replace(/s+/g, ' ').slice(0, 60)])).entries()].filter(([, t]) => t))
    for (const [u, t] of items.slice(0, 12)) {
      if (seen.has(u)) continue
      seen.add(u)
      const s = await statusOf(u).catch(() => 'ERR')
      if (s.startsWith('ON_AIR')) console.log(word, '|', u.split('/').pop(), s, '|', t)
    }
  }
} finally { await browser.close() }
