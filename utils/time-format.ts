// 録画を見る時の時間の出し方（プレイバックのウィンドウと録画一覧で使う）
// - 録画の時間: 録画を始めてからの時間（1:05、1:02:03）
// - 番組の経過時間: 番組が始まってからの時間。ニコ生のプレイヤーの表示（16:18:42/24:00:00）と同じ形
// - 放送した時刻: 午前・午後を付けた時刻（今日でなければ日付も）
// - どれだけ前か: ライブからの遅れ（5:30前）

const pad = (n: number) => String(n).padStart(2, '0')

// 番組の経過時間（時:分:秒。1時間に満たなくても時を付ける。seconds: false なら時:分）
const formatElapsed = (ms: number, { seconds = true } = {}) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    return seconds ? `${h}:${pad(m)}:${pad(total % 60)}` : `${h}:${pad(m)}`
}

// 録画の時間（1時間に満たなければ 分:秒、それより長ければ 時:分:秒）
const formatRecorded = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`
}

// どれだけ前か（例: 5:30前、1:02:03前）
const formatAgo = (ms: number) => `${formatRecorded(ms)}前`

// 放送した時刻（例: 午後4:18、10/19 午前0:05）
const formatBroadcastTime = (ms: number, { seconds = false, now = Date.now() } = {}) => {
    const d = new Date(ms)
    const h = d.getHours()
    const time = `${h < 12 ? '午前' : '午後'}${h % 12}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
    return d.toDateString() === new Date(now).toDateString() ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

export { formatRecorded, formatElapsed, formatBroadcastTime, formatAgo }
