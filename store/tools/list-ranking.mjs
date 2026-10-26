import puppeteer from 'puppeteer-core'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, pipe: true })
try {
  const page = await browser.newPage()
  for (const url of ['https://live.nicovideo.jp/ranking', 'https://live.nicovideo.jp/search?keyword=%E5%AE%9A%E7%82%B9&status=onair', 'https://live.nicovideo.jp/search?keyword=%E3%83%A9%E3%82%A4%E3%83%96%E3%82%AB%E3%83%A1%E3%83%A9&status=onair']) {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await sleep(3000)
    const items = await page.$$eval('a[href*="/watch/lv"]', as => [...new Map(as.map(a => [a.href.split('?')[0], (a.textContent || a.title || '').trim().replace(/\s+/g, ' ').slice(0, 70)])).entries()].filter(([, t]) => t))
    console.log('==', url)
    for (const [u, t] of items.slice(0, 20)) console.log(u, t)
  }
} finally { await browser.close() }
