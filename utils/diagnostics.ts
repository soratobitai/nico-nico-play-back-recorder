// 調査用の記録（音ズレなどの原因を調べる。診断版だけで動く: npm run build:diag）
// 録画中に1秒ごとに、原因の候補を見分けるための数字を記録し、拡張機能の保存領域に少しずつ書き込む。
// 録画一覧の「診断ログを保存」で、1つの JSON ファイルにして保存できる。
// 普段の版（production）では、import.meta.env.MODE が 'diag' でないので、何もしない
import { parseInit, parseMoof } from './fmp4'

const DIAG_ENABLED = import.meta.env.MODE === 'diag'
const DIAG_PREFIX = 'diag:'
// 保存領域に書き込む間隔
const FLUSH_MS = 10 * 1000
// 残しておく記録の数（ページを開くたびに1つ増える。古いものから消す）
const KEEP_SESSIONS = 20
// 音声を数える時に、読み切れずにためておくデータの上限（ページが忙しい時に、ためすぎないように）
const AUDIO_BUFFER_FRAMES = 300

// Chrome にしかない API なので TypeScript の型定義にない。使う分だけ宣言する
declare const MediaStreamTrackProcessor: {
    new (init: { track: MediaStreamTrack, maxBufferSize?: number }): { readable: ReadableStream<AudioData> }
} | undefined

type PipelineStats = { frames: number, maxProcMs: number, lagMs: number, maxLagMs: number }
type FragmentRow = { seg: string, kind: string, wallMs: number, a?: [number, number], v?: [number, number] }
type Row = {
    t: number // 記録を始めてからの秒
    hidden: boolean // タブが裏にあったか（裏のタブは、タイマーなどが遅くなる）
    loopMaxMs: number // ページの処理の詰まり（50ms ごとのタイマーが、どれだけ遅れたか）の最大
    longTaskMs: number // 50ms を超える処理の合計
    pipes: Record<string, PipelineStats> // 描き直しの処理ごと
    // ahead: 先読みしてある秒数（再生位置から、読み込んである所の終わりまで）。live: ライブの先端からの遅れ（秒）
    play?: { ct: number, rate: number, paused: boolean, dropped: number, frames: number, avgVideoLagMs: number, maxVideoLagMs: number, ahead: number, live: number | null }
    audio?: { samples: number, sampleRate: number, gapMs: number }
    frags: FragmentRow[]
}

let active = false
let sessionKey = ''
let startedAt = 0
let chunkIndex = 0
let meta: Record<string, unknown> = {}
let rows: Row[] = []
let events: { t: number, type: string, detail?: unknown }[] = []
let current: Row | null = null

const now = () => +((performance.now() - startedAt) / 1000).toFixed(3)
const newRow = (): Row => ({ t: Math.round((performance.now() - startedAt) / 1000), hidden: document.hidden, loopMaxMs: 0, longTaskMs: 0, pipes: {}, frags: [] })
const row = () => current ??= newRow()

const flush = () => {
    if (!active || (rows.length === 0 && events.length === 0)) return
    const chunk = { meta: chunkIndex === 0 ? meta : undefined, rows, events }
    rows = []
    events = []
    try {
        chrome.storage.local.set({ [`${sessionKey}:${String(chunkIndex++).padStart(5, '0')}`]: chunk }).catch(() => {})
    } catch {
        // 拡張機能が更新された後は書き込めない
    }
}

// 古い記録を消す（新しい KEEP_SESSIONS 個を残す）
const pruneSessions = async () => {
    const keys = Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith(DIAG_PREFIX))
    const sessions = [...new Set(keys.map(k => k.slice(0, k.lastIndexOf(':'))))].sort()
    const old = new Set(sessions.slice(0, Math.max(0, sessions.length - KEEP_SESSIONS)))
    if (old.size > 0) await chrome.storage.local.remove(keys.filter(k => old.has(k.slice(0, k.lastIndexOf(':')))))
}

// 先読みしてある秒数と、ライブの先端からの遅れ（「低遅延重視」では、先読みが少ないと止まりやすい）
const bufferOf = (video: HTMLVideoElement) => {
    const ct = video.currentTime
    let ahead = 0
    for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= ct + 0.1 && video.buffered.end(i) > ct) ahead = video.buffered.end(i) - ct
    }
    const live = video.seekable.length ? video.seekable.end(video.seekable.length - 1) - ct : null
    return { ahead: +ahead.toFixed(2), live: live === null ? null : +live.toFixed(2) }
}

// 記録を始める（ニコ生のページで、番組を開いた時に1回）
// 記録できなくても、録画は続ける
const startDiagnostics = (video: HTMLVideoElement | null, info: Record<string, unknown>) => {
    if (!DIAG_ENABLED || active) return
    try {
        start(video, info)
    } catch (error) {
        console.log('診断の記録を始められませんでした:', error)
    }
}
const start = (video: HTMLVideoElement | null, info: Record<string, unknown>) => {
    active = true
    pruneSessions().catch(() => {})
    startedAt = performance.now()
    sessionKey = `${DIAG_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
    const nav = navigator as Navigator & { deviceMemory?: number }
    meta = {
        ...info,
        url: location.href,
        userAgent: navigator.userAgent,
        cores: navigator.hardwareConcurrency,
        memoryGB: nav.deviceMemory,
        pageAgeMs: Math.round(performance.now()),
        startedAt: new Date().toISOString(),
        hidden: document.hidden,
    }
    document.addEventListener('visibilitychange', () => diagEvent('page:visibility', { hidden: document.hidden }))

    // ページの処理の詰まり
    let expected = performance.now() + 50
    setInterval(() => {
        const late = performance.now() - expected
        const r = row()
        r.loopMaxMs = Math.max(r.loopMaxMs, Math.round(late))
        expected = performance.now() + 50
    }, 50)
    try {
        new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) row().longTaskMs += Math.round(entry.duration)
        }).observe({ type: 'longtask', buffered: true })
    } catch {
        // 使えない環境
    }

    // ニコ生のプレイヤー自体の映像の遅れ（表示したコマの時刻が、再生位置（音声に合わせて進む）からどれだけ遅れているか）
    let lagSum = 0
    let lagCount = 0
    let lagMax = 0
    const onFrame = (_now: number, frameMeta: { mediaTime: number }) => {
        if (!video) return
        const lag = (video.currentTime - frameMeta.mediaTime) * 1000
        lagSum += lag
        lagCount++
        lagMax = Math.max(lagMax, lag)
        video.requestVideoFrameCallback(onFrame)
    }
    if (video && 'requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame)
    for (const type of video ?  ['waiting', 'playing', 'stalled', 'ratechange', 'resize', 'seeking', 'seeked', 'emptied', 'loadeddata', 'pause', 'play'] : []) {
        video?.addEventListener(type, () => diagEvent(`video:${type}`, { ct: +video.currentTime.toFixed(2), rate: video.playbackRate, size: `${video.videoWidth}x${video.videoHeight}` }))
    }

    // 1秒ごとに行をまとめる
    let lastQuality = video?.getVideoPlaybackQuality?.()
    setInterval(() => {
        const r = row()
        const quality = video?.getVideoPlaybackQuality?.()
        if (video) r.play = {
            ct: +video.currentTime.toFixed(2),
            rate: video.playbackRate,
            paused: video.paused,
            dropped: (quality?.droppedVideoFrames ?? 0) - (lastQuality?.droppedVideoFrames ?? 0),
            frames: (quality?.totalVideoFrames ?? 0) - (lastQuality?.totalVideoFrames ?? 0),
            avgVideoLagMs: lagCount ? Math.round(lagSum / lagCount) : 0,
            maxVideoLagMs: Math.round(lagMax),
            ...bufferOf(video),
        }
        lastQuality = quality
        lagSum = 0
        lagCount = 0
        lagMax = 0
        if (audioStats) {
            r.audio = { samples: audioStats.samples, sampleRate: audioStats.sampleRate, gapMs: Math.round(audioStats.gapMs) }
            audioStats.samples = 0
            audioStats.gapMs = 0
        }
        rows.push(r)
        current = null
    }, 1000)
    setInterval(flush, FLUSH_MS)
    window.addEventListener('pagehide', flush)
    diagEvent('diag:start')
}

// 出来事（録画の開始・停止・区切り・録り直し など）
const diagEvent = (type: string, detail?: unknown) => {
    if (!active) return
    events.push({ t: now(), type, detail })
}

// 取り込んだ音声の量と途切れ（音声のデータの時刻が、前のデータの終わりより先に飛んだ分を、途切れとして数える）
let audioStats: { samples: number, sampleRate: number, gapMs: number } | null = null
const watchedAudio = new Set<string>()
const watchAudio = (track: MediaStreamTrack | undefined) => {
    if (!active || !track || watchedAudio.has(track.id) || typeof MediaStreamTrackProcessor === 'undefined') return
    watchedAudio.add(track.id)
    diagEvent('audio:watch', { id: track.id.slice(0, 8) })
    const stats = audioStats = { samples: 0, sampleRate: 0, gapMs: 0 }
    let reader: ReadableStreamDefaultReader<AudioData>
    try {
        reader = new MediaStreamTrackProcessor({ track: track.clone(), maxBufferSize: AUDIO_BUFFER_FRAMES }).readable.getReader()
    } catch {
        return
    }
    let expectedNext: number | null = null
    const pump = async () => {
        for (;;) {
            const { value, done } = await reader.read()
            if (done || !value) break
            stats.samples += value.numberOfFrames
            stats.sampleRate = value.sampleRate
            if (expectedNext !== null && value.timestamp - expectedNext > 5000) stats.gapMs += (value.timestamp - expectedNext) / 1000
            expectedNext = value.timestamp + (value.numberOfFrames / value.sampleRate) * 1e6
            value.close()
        }
    }
    pump().catch(() => {})
}

// 描き直しの処理ごとの、1コマにかかった時間と遅れ
// 遅れ: 届いたコマの時刻の進みに比べて、描き直したコマを流すのがどれだけ遅れているか（処理が追いつかないと増える）
let pipelineCount = 0
const watchPipeline = (size: string) => {
    if (!active) return null
    const name = `${++pipelineCount}:${size}`
    diagEvent('pipeline:start', { name })
    let first: { ts: number, at: number } | null = null
    return {
        frame(timestamp: number, readAt: number, writtenAt: number) {
            first ??= { ts: timestamp, at: readAt }
            const lag = (writtenAt - first.at) - (timestamp - first.ts) / 1000
            const r = row()
            const stats = r.pipes[name] ??= { frames: 0, maxProcMs: 0, lagMs: 0, maxLagMs: 0 }
            stats.frames++
            stats.maxProcMs = Math.max(stats.maxProcMs, Math.round(writtenAt - readAt))
            stats.lagMs = Math.round(lag)
            stats.maxLagMs = Math.max(stats.maxLagMs, Math.round(lag))
        },
        stop() {
            diagEvent('pipeline:stop', { name })
        },
    }
}

// 録画のデータ（MediaRecorder の出力）の、断片ごとの映像と音声の時刻（秒）
// 書き込んだ時刻（区間を始めてからのミリ秒）と並べると、映像・音声のどちらかが遅れて届く・時刻が詰まる、が分かる
const segmentTracks = new Map<string, ReturnType<typeof parseInit>>()
const diagSegmentInit = (segmentId: string, kind: string, init: Uint8Array) => {
    if (!active) return
    try {
        segmentTracks.set(segmentId, parseInit(init))
        diagEvent('segment:init', { seg: segmentId.slice(0, 8), kind })
    } catch {
        // 読めない
    }
}
const diagFragments = (segmentId: string, kind: string, startedAtMs: number, fragments: { bytes: Uint8Array, moofSize: number }[]) => {
    if (!active) return
    const tracks = segmentTracks.get(segmentId)
    if (!tracks) return
    for (const fragment of fragments) {
        try {
            const info = parseMoof(fragment.bytes.subarray(0, fragment.moofSize), tracks)
            const out: FragmentRow = { seg: segmentId.slice(0, 8), kind, wallMs: Date.now() - startedAtMs }
            for (const t of info.trackFragments) {
                const track = tracks.get(t.trackId)
                if (!track || t.sampleCount === 0) continue
                const range: [number, number] = [+(t.baseTime / track.timescale).toFixed(3), +((t.baseTime + t.duration) / track.timescale).toFixed(3)]
                if (track.isVideo) out.v = range
                else out.a = range
            }
            row().frags.push(out)
        } catch {
            // 読めない
        }
    }
}

// ---- 録画一覧（記録を集めて保存・消す） ----

const loadDiagnostics = async () => {
    const all = await chrome.storage.local.get(null) as Record<string, unknown>
    const sessions: Record<string, { meta?: unknown, rows: unknown[], events: unknown[] }> = {}
    for (const key of Object.keys(all).filter(k => k.startsWith(DIAG_PREFIX)).sort()) {
        const session = key.slice(0, key.lastIndexOf(':'))
        const chunk = all[key] as { meta?: unknown, rows: unknown[], events: unknown[] }
        const s = sessions[session] ??= { rows: [], events: [] }
        if (chunk.meta) s.meta = chunk.meta
        s.rows.push(...chunk.rows)
        s.events.push(...chunk.events)
    }
    return sessions
}
const clearDiagnostics = async () => {
    const all = await chrome.storage.local.get(null) as Record<string, unknown>
    await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith(DIAG_PREFIX)))
}

export {
    DIAG_ENABLED,
    startDiagnostics, diagEvent, watchAudio, watchPipeline, diagSegmentInit, diagFragments,
    loadDiagnostics, clearDiagnostics,
}
