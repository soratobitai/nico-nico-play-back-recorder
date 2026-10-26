// 撮った素材に見出しを付けて、ストア用のスクリーンショット（1280×800）にする
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'
import path from 'node:path'

const SHOTS = new URL('shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
// 書き出し先（このリポジトリの store/screenshots/ など）
const OUT = process.env.OUT
if (!OUT) throw new Error('OUT に書き出し先のフォルダを指定してください')
fs.mkdirSync(OUT, { recursive: true })
// 視聴ページの素材の、録画バーの位置（shots-raw が書き出す）。プレイヤーと録画バーの所を切り抜く
const regions = JSON.parse(fs.readFileSync(path.join(SHOTS, 'regions.json'), 'utf8'))
const watchCrop = { x: regions.video.x, y: regions.bar.y + regions.bar.height - 524, w: 768, h: 524 }
const img = (name) => 'data:image/png;base64,' + fs.readFileSync(path.join(SHOTS, name)).toString('base64')

const page = (title, sub, body) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 800px; overflow: hidden; font-family: "Yu Gothic UI", "Yu Gothic", "Meiryo", sans-serif;
    background: radial-gradient(1200px 600px at 20% -10%, #2b3550 0%, #151a26 55%, #0e121b 100%); color: #f4f6fb; }
  header { height: 150px; padding: 34px 64px 0; }
  h1 { font-size: 40px; font-weight: 700; letter-spacing: 0.02em; }
  h1 .mark { display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: #ff4d5e; margin-right: 16px; vertical-align: 6px; box-shadow: 0 0 0 6px rgba(255, 77, 94, 0.18); }
  p.sub { margin-top: 14px; font-size: 20px; color: #b9c2d6; line-height: 1.5; }
  main { position: relative; height: 650px; }
  .frame { position: absolute; border-radius: 14px; overflow: hidden; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08); background: #000; }
  .frame img { display: block; position: absolute; }
  .highlight { position: absolute; border: 3px solid #ff9f43; border-radius: 10px; box-shadow: 0 0 0 6px rgba(255, 159, 67, 0.25); }
  .pip { position: absolute; border-radius: 10px; overflow: hidden; background: #1b1f2a; box-shadow: 0 28px 70px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.14); }
  .pip .bar { height: 34px; display: flex; align-items: center; gap: 10px; padding: 0 14px; font-size: 14px; color: #dfe4ef; background: #262c3a; }
  .pip .bar .dot { width: 9px; height: 9px; border-radius: 50%; background: #ff4d5e; }
  .pip img { display: block; }
  .note { position: absolute; right: 64px; top: 624px; font-size: 14px; color: #8a93a8; }
  .tag { position: absolute; padding: 8px 16px; border-radius: 999px; font-size: 18px; font-weight: 700; color: #1a1205; background: #ffb454; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }
</style></head><body><header><h1><span class="mark"></span>${title}</h1><p class="sub">${sub}</p></header><main>${body}</main></body></html>`

// 素材の一部（x, y, w, h）を、幅 width で表示する
const cropped = (name, { x, y, w, h }, width, left, top, extra = '') => {
  const s = width / w
  return `<div class="frame" style="left:${left}px; top:${top}px; width:${w * s}px; height:${h * s}px">
    <img src="${img(name)}" style="width:${1280 * s}px; left:${-x * s}px; top:${-y * s}px">${extra(s)}</div>`
}
const centered = (w, h, maxW, maxH) => {
  const s = Math.min(maxW / w, maxH / h)
  return { width: w * s, left: (1280 - w * s) / 2 }
}

const shots = [
  {
    file: '1-recording-bar.png',
    title: '見ている番組を、そのまま自動で録画',
    sub: 'プレイヤーの下の録画バーで、録画の状態・時間・画質を確認。録画する種類（コメントなし・コメントあり・画面録画）もタブごとに切り替え。',
    body: () => {
      const crop = watchCrop
      const { width, left } = centered(crop.w, crop.h, 1120, 610)
      const { x, y, width: w, height: h } = regions.bar
      return cropped('raw-watch.png', crop, width, left, 8, (s) =>
        `<div class="highlight" style="left:${(x - crop.x) * s - 6}px; top:${(y - crop.y) * s - 6}px; width:${w * s + 12}px; height:${h * s + 12}px"></div>`)
    },
  },
  {
    file: '2-playback.png',
    title: '録画を止めずに、少し前の場面をすぐ見返せる',
    sub: '「プレイバック」の別ウィンドウで、生放送を見ながら「さっきのシーン」を確認。見ている場面のスクリーンショットや、前後30秒の動画も保存できます。',
    body: () => {
      // 視聴ページは、プレイヤーと録画バーの所だけ（ニコ生のお知らせなどが入らないように）
      const base = cropped('raw-watch-pip.png', watchCrop, 760, 64, 16, () => '')
      const pipW = 600
      const pipH = 400 * (pipW / 640)
      const pip = `<div class="pip" style="left:${1280 - 64 - pipW}px; top:${650 - pipH - 34 - 26}px; width:${pipW}px">
        <div class="bar"><span class="dot"></span>プレイバック</div><img src="${img('raw-pip.png')}" style="width:${pipW}px; height:${pipH}px"></div>`
      const tag = `<div class="tag" style="left:${1280 - 64 - pipW + 18}px; top:${650 - pipH - 34 - 26 - 52}px">ライブの少し前を再生中</div>`
      return base + pip + tag
    },
  },
  {
    file: '3-library.png',
    title: '番組ごとに見返して、1本の動画で保存',
    sub: '「録画一覧」で、録った番組をタイムラインから再生。種類ごとの録画を、画質を落とさずに mp4 で保存できます。',
    body: () => {
      const { width, left } = centered(1280, 800, 1120, 610)
      return cropped('raw-library.png', { x: 0, y: 0, w: 1280, h: 800 }, width, left, 8, () => '')
    },
  },
  {
    file: '4-comments.png',
    title: '流れるコメントを重ねた録画も',
    sub: '「コメントなし」と「コメントあり」を同時に録画して、同じ場面のまま切り替えて見られます（ゲームやギフトの演出ごと録る「画面録画」にも対応）。',
    body: () => {
      // プレイヤーの部分を大きく
      const crop = { x: 340, y: 60, w: 940, h: 740 }
      const { width, left } = centered(crop.w, crop.h, 1120, 610)
      // コメントの少ない番組で撮る時は、見本のコメントを流して撮る（shots-comments.mjs）
      return cropped('raw-library-comments.png', crop, width, left, 8, () => '') + (process.env.SAMPLE_COMMENTS ? '<div class="note">※ 画面のコメントは見本です（イメージ）</div>' : '')
    },
  },
  {
    file: '5-settings.png',
    title: '録画する種類や、保存する容量の上限を設定',
    sub: '上限を超えたら、古い録画から自動で削除。配信の画質が変わった時の録り方も選べます。',
    body: () => {
      const crop = { x: 151, y: 107, w: 978, h: 586 }
      const { width, left } = centered(crop.w, crop.h, 1120, 610)
      return cropped('raw-settings.png', crop, width, left, 8, () => '')
    },
  },
]

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, pipe: true, defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 } })
try {
  const tab = await browser.newPage()
  for (const shot of shots) {
    await tab.setContent(page(shot.title, shot.sub, shot.body()), { waitUntil: 'load' })
    await tab.screenshot({ path: OUT + shot.file })
    console.log('wrote', shot.file)
  }
} finally { await browser.close() }
