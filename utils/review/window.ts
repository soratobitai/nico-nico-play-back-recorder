// 見直しのウィンドウ
// ニコ生のページで生放送を見ながら、少し前の録画を別のウィンドウ（Document Picture-in-Picture）で見直す。
// ウィンドウは大きさを変えられ、他のウィンドウの上に重なって表示される。
// 録画は止めずに続け、録画中の最新の部分も届くたびに見直せるようになる。
// 見直しの音は初めは消しておき（ライブの音はそのまま）、ボタンで出せる。
// 種類（動画のみ・コメント付き・画面）を同時に録っている場合は、同じ場面のまま切り替えて見られる。
import { getTimeline, getFragmentBlobs } from '../library/api'
import type { RecordingKind, TimelineSegment } from '../library/db'
import { subscribeLiveFeed, type LiveFeedEvent } from './live-feed'
import { Timeline } from './timeline'
import { createReviewPlayer, type ReviewPlayer } from './player'
import { REVIEW_STYLE } from './style'

// Document Picture-in-Picture（TypeScript の型にまだないので必要な分だけ）
type DocumentPictureInPicture = {
    requestWindow(options?: { width?: number, height?: number }): Promise<Window>
    readonly window: Window | null
}
const documentPictureInPicture = () =>
    (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture

// 開いた時の再生位置（最新の録画のこれだけ前から）
const INITIAL_BEHIND_SECONDS = 30
// 「ライブに戻る」で移る位置（最新の録画のこれだけ前。届いたばかりの断片で途切れないように少し余裕を持つ）
const LIVE_EDGE_SECONDS = 8
// ライブからこれ以内なら「ライブ」とみなす（録画は数秒ごとの断片で届くので、少し遅れる）
const LIVE_THRESHOLD_SECONDS = 15
const SKIP_SECONDS = 10
// 保存先から番組の録画を読み直す間隔（容量の上限を超えて消された部分などを反映する）
const SYNC_INTERVAL_MS = 30 * 1000
const WINDOW_SIZE = { width: 640, height: 420 }
// 種類の名前と、初めに見る種類の優先順
const KIND_LABELS: Record<RecordingKind, string> = { video: '動画のみ', comments: 'コメント付き', screen: '画面' }
const KIND_ORDER: RecordingKind[] = ['video', 'comments', 'screen']

const MESSAGE_EMPTY = 'まだ見直せる録画がありません。\n録画が始まると、ここで少し前から見直せます。'
const MESSAGE_UNAVAILABLE = '拡張機能が更新されたため見直せません。\nページを開き直してください。'
const MESSAGE_LOAD_ERROR = '録画を読み込めませんでした。'
const MESSAGE_PLAY_ERROR = '録画を再生できませんでした。\nウィンドウを開き直してください。'

const icon = (path: string) =>
    `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
const ICONS = {
    back: icon('<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v5h5"></path>'),
    forward: icon('<path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 4v5h-5"></path>'),
    play: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>',
    pause: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>',
    muted: icon('<path d="M11 5L6 9H3v6h3l5 4z"></path><path d="M22 9l-6 6M16 9l6 6"></path>'),
    sound: icon('<path d="M11 5L6 9H3v6h3l5 4z"></path><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"></path>'),
}

const TEMPLATE = `
<div class="stage">
  <video playsinline muted></video>
  <div class="message" role="status" hidden></div>
</div>
<div class="bar">
  <input class="seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="再生位置">
  <div class="row">
    <button type="button" class="back" aria-label="${SKIP_SECONDS}秒戻る" title="${SKIP_SECONDS}秒戻る（←）">${ICONS.back}<span class="label">${SKIP_SECONDS}秒</span></button>
    <button type="button" class="play" aria-label="再生" title="再生・一時停止（スペース）">${ICONS.play}</button>
    <button type="button" class="forward" aria-label="${SKIP_SECONDS}秒進む" title="${SKIP_SECONDS}秒進む（→）"><span class="label">${SKIP_SECONDS}秒</span>${ICONS.forward}</button>
    <div class="time"><span class="clock">--:--:--</span><span class="behind"></span></div>
    <span class="spacer"></span>
    <div class="kinds" role="group" aria-label="録画の種類" hidden>
      ${KIND_ORDER.map(kind => `<button type="button" class="kind kind-${kind}" data-kind="${kind}" aria-pressed="false" hidden>${KIND_LABELS[kind]}</button>`).join('')}
    </div>
    <button type="button" class="mute" title="見直しの音（M）"></button>
    <button type="button" class="live" title="最新の録画へ（L）"><span class="live-dot" aria-hidden="true"></span><span class="label live-label">ライブに戻る</span></button>
  </div>
</div>
`

const pad = (n: number) => String(n).padStart(2, '0')

// 録った時刻の表示（今日でなければ日付も）
const formatClock = (ms: number) => {
    const date = new Date(ms)
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`
}

const formatDuration = (seconds: number) => {
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

type ReviewWindowOptions = {
    programId: string
    title: string
    onClose?: () => void
}

let current: { close: () => void } | null = null
let opening = false

const isReviewSupported = () => !!documentPictureInPicture() && typeof MediaSource !== 'undefined'
const isReviewOpen = () => current !== null

// 見直しのウィンドウを開く（開いていれば閉じる）
// ボタンを押した時に呼ぶこと（ウィンドウは、ユーザーの操作からしか開けない）
const toggleReviewWindow = async (options: ReviewWindowOptions) => {
    if (current) {
        current.close()
        return
    }
    if (opening) return
    opening = true
    try {
        const pip = await documentPictureInPicture()!.requestWindow(WINDOW_SIZE)
        current = mountReviewWindow(pip, options)
    } finally {
        opening = false
    }
}

const mountReviewWindow = (pip: Window, { programId, title, onClose }: ReviewWindowOptions) => {
    const doc = pip.document
    doc.title = `見直し - ${title}`
    const style = doc.createElement('style')
    style.textContent = REVIEW_STYLE
    doc.head.append(style)
    doc.body.innerHTML = TEMPLATE

    const $ = <T extends Element>(selector: string) => doc.querySelector<T>(selector)!
    const video = $<HTMLVideoElement>('video')
    const message = $<HTMLDivElement>('.message')
    const seek = $<HTMLInputElement>('.seek')
    const playButton = $<HTMLButtonElement>('.play')
    const muteButton = $<HTMLButtonElement>('.mute')
    const liveButton = $<HTMLButtonElement>('.live')
    const liveLabel = $<HTMLSpanElement>('.live-label')
    const clock = $<HTMLSpanElement>('.clock')
    const behind = $<HTMLSpanElement>('.behind')
    video.muted = true

    const kindsGroup = $<HTMLDivElement>('.kinds')
    const kindButtons = [...doc.querySelectorAll<HTMLButtonElement>('.kind')]

    // 種類ごとの時間軸（見ているのは、そのうちの1つ）
    const timelines = new Map<RecordingKind, Timeline>()
    const timelineOf = (kind: RecordingKind) => {
        let found = timelines.get(kind)
        if (!found) {
            found = new Timeline()
            timelines.set(kind, found)
        }
        return found
    }
    const availableKinds = () => KIND_ORDER.filter(kind => !timelines.get(kind)?.isEmpty && timelines.has(kind))
    let selectedKind: RecordingKind = 'video'
    let timeline = timelineOf(selectedKind)
    let started = false // 最初の再生位置に移ったか
    let dragging = false // シークバーを動かしている間

    const showMessage = (text: string | null) => {
        message.hidden = text === null
        message.textContent = text ?? ''
    }

    const createPlayer = (target: Timeline): ReviewPlayer => createReviewPlayer({
        video,
        timeline: target,
        readFragments: getFragmentBlobs,
        onError: (error) => {
            console.error('見直しの再生に失敗しました:', error)
            showMessage(MESSAGE_PLAY_ERROR)
        },
    })
    let player = createPlayer(timeline)

    // 見る種類を切り替える（同じ場面から続けて見る）
    const selectKind = (kind: RecordingKind) => {
        if (kind === selectedKind) return
        const wallClock = timeline.isEmpty ? null : timeline.wallClockAt(player.position)
        const wasPlaying = !video.paused
        player.destroy()
        selectedKind = kind
        timeline = timelineOf(kind)
        player = createPlayer(timeline)
        if (timeline.isEmpty) return
        const target = wallClock === null ? null : timeline.timeAtWallClock(wallClock)
        player.seek(target ?? Math.max(timeline.start, timeline.end - INITIAL_BEHIND_SECONDS))
        if (wasPlaying || !started) video.play().catch(() => {})
        started = true
        showMessage(null)
        render()
    }

    // 録画があれば、最新の少し前から再生を始める（初めは「動画のみ」、なければ録ってある種類）
    const startIfReady = () => {
        if (started) return
        const kind = availableKinds()[0]
        if (!kind) return
        if (kind !== selectedKind) {
            selectKind(kind)
            return
        }
        started = true
        showMessage(null)
        player.seek(Math.max(timeline.start, timeline.end - INITIAL_BEHIND_SECONDS))
        video.play().catch(() => {})
    }

    const render = () => {
        const empty = timeline.isEmpty
        for (const element of [seek, playButton, $<HTMLButtonElement>('.back'), $<HTMLButtonElement>('.forward')]) element.disabled = empty
        if (!dragging) {
            seek.min = String(timeline.start)
            seek.max = String(timeline.end)
            seek.value = String(player.position)
        }
        const t = dragging ? Number(seek.value) : player.position
        const wallClock = empty ? null : timeline.wallClockAt(t)
        clock.textContent = wallClock === null ? '--:--:--' : formatClock(wallClock)
        seek.setAttribute('aria-valuetext', clock.textContent)

        const behindSeconds = wallClock === null ? null : (Date.now() - wallClock) / 1000
        const atLive = behindSeconds !== null && behindSeconds < LIVE_THRESHOLD_SECONDS
        behind.textContent = behindSeconds === null ? '' : atLive ? 'ライブ' : `ライブの ${formatDuration(behindSeconds)} 前`
        liveButton.classList.toggle('at-live', atLive)
        liveButton.disabled = empty || atLive
        liveLabel.textContent = atLive ? 'ライブ' : 'ライブに戻る'
        liveButton.setAttribute('aria-label', atLive ? 'ライブ（最新の録画）を再生中' : 'ライブに戻る')

        // 種類が2つ以上ある時だけ、切り替えのボタンを出す
        const kinds = availableKinds()
        kindsGroup.hidden = kinds.length < 2
        for (const button of kindButtons) {
            const kind = button.dataset.kind as RecordingKind
            button.hidden = !kinds.includes(kind)
            button.setAttribute('aria-pressed', String(kind === selectedKind))
        }

        // アイコンは変わった時だけ描き直す
        const playState = video.paused ? 'paused' : 'playing'
        if (playButton.dataset.state !== playState) {
            playButton.dataset.state = playState
            playButton.innerHTML = video.paused ? ICONS.play : ICONS.pause
            playButton.setAttribute('aria-label', video.paused ? '再生' : '一時停止')
        }
        const muteState = video.muted ? 'muted' : 'sound'
        if (muteButton.dataset.state !== muteState) {
            muteButton.dataset.state = muteState
            muteButton.innerHTML = `${video.muted ? ICONS.muted : ICONS.sound}<span class="label">${video.muted ? '音を出す' : '音を消す'}</span>`
            muteButton.setAttribute('aria-label', video.muted ? '見直しの音を出す' : '見直しの音を消す')
        }
    }

    const skip = (seconds: number) => player.seek(player.position + seconds)
    const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause() }
    const toggleMute = () => { video.muted = !video.muted }
    const goLive = () => {
        player.seek(timeline.end - LIVE_EDGE_SECONDS)
        video.play().catch(() => {})
    }

    seek.addEventListener('input', () => { dragging = true; render() })
    seek.addEventListener('change', () => {
        dragging = false
        player.seek(Number(seek.value))
        render()
    })
    $<HTMLButtonElement>('.back').addEventListener('click', () => skip(-SKIP_SECONDS))
    $<HTMLButtonElement>('.forward').addEventListener('click', () => skip(SKIP_SECONDS))
    playButton.addEventListener('click', togglePlay)
    muteButton.addEventListener('click', toggleMute)
    liveButton.addEventListener('click', goLive)
    for (const button of kindButtons) button.addEventListener('click', () => selectKind(button.dataset.kind as RecordingKind))
    doc.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return
        const actions: Record<string, () => void> = {
            ' ': togglePlay, k: togglePlay,
            ArrowLeft: () => skip(-SKIP_SECONDS), j: () => skip(-SKIP_SECONDS),
            ArrowRight: () => skip(SKIP_SECONDS), l: goLive,
            m: toggleMute, End: goLive,
        }
        const action = actions[event.key]
        if (!action || timeline.isEmpty) return
        event.preventDefault()
        action()
    })
    for (const type of ['play', 'pause', 'volumechange', 'timeupdate', 'seeking']) video.addEventListener(type, render)
    // 読み込みに一時的に失敗しても、その後に再生できたらお知らせを消す
    video.addEventListener('playing', () => { if (message.textContent === MESSAGE_PLAY_ERROR) showMessage(null) })

    // ---- 録画の読み込み ----

    const applyFeed = (event: LiveFeedEvent) => {
        switch (event.type) {
            case 'init': {
                const { segment } = event
                if (segment.programId !== programId || segment.format !== 'fmp4') return
                timelineOf(segment.kind).addSegment({
                    segmentId: segment.segmentId, kind: segment.kind, mimeType: segment.mimeType,
                    startedAt: segment.startedAt, endedAt: null, init: event.init,
                })
                break
            }
            case 'fragments': {
                const owner = [...timelines.values()].find(t => t.segment(event.segmentId))
                if (!owner) return
                // 見ている種類の断片は、保存先から読み直さずに使えるように覚えておく
                if (owner === timeline) for (const f of event.fragments) player.cacheFragment(event.segmentId, f.index, f.blob)
                owner.addFragments(event.segmentId, event.fragments.map(f => ({
                    index: f.index, startTime: f.startTime, duration: f.duration, keyframe: f.keyframe ?? true,
                })))
                break
            }
            case 'finish':
                for (const t of timelines.values()) t.finishSegment(event.segmentId, event.endedAt)
                break
        }
        startIfReady()
        player.update()
        render()
    }

    // 最初に保存先から読み終えるまでに届いた知らせは、読み終えてから反映する
    let queued: LiveFeedEvent[] | null = []
    const unsubscribe = subscribeLiveFeed((event) => {
        if (queued) queued.push(event)
        else applyFeed(event)
    })

    const applyQueued = () => {
        if (!queued) return
        const events = queued
        queued = null
        events.forEach(applyFeed)
    }

    const sync = async () => {
        try {
            const segments = await getTimeline(programId)
            const byKind = new Map<RecordingKind, TimelineSegment[]>(KIND_ORDER.map(kind => [kind, []]))
            for (const segment of segments) byKind.get(segment.kind)?.push(segment)
            for (const [kind, list] of byKind) {
                if (list.length > 0 || timelines.has(kind)) timelineOf(kind).sync(list)
            }
            applyQueued()
            if (availableKinds().length === 0) showMessage(MESSAGE_EMPTY)
            startIfReady()
            player.update()
        } catch (error) {
            console.error('見直しの録画を読み込めませんでした:', error)
            applyQueued() // 録画中に届く分だけでも見直せるように
            if (availableKinds().length === 0) {
                showMessage(error instanceof Error && error.name === 'BridgeUnavailableError' ? MESSAGE_UNAVAILABLE : MESSAGE_LOAD_ERROR)
            }
        }
        render()
    }

    render()
    void sync()
    const syncTimer = setInterval(sync, SYNC_INTERVAL_MS)
    const renderTimer = setInterval(render, 1000)

    pip.addEventListener('pagehide', () => {
        unsubscribe()
        clearInterval(syncTimer)
        clearInterval(renderTimer)
        player.destroy()
        current = null
        onClose?.()
    }, { once: true })

    return { close: () => pip.close() }
}

export { isReviewSupported, isReviewOpen, toggleReviewWindow }
