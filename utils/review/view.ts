// 録画を見る画面（再生・シークバー・10秒戻る/進む・種類の切り替え）
// プレイバックのウィンドウ（ニコ生のページから開く。mode: 'live'）と、録画一覧のページ（mode: 'library'）で使う。
// - live: 録画中の番組を、ライブの少し前から見る。音は初めは消しておく（ライブの音はそのまま）。
//         「ライブ」ボタンで最新の録画へ移り、録画中に届く断片を追いかける。
// - library: 録画した番組を見る。音は出す。録った時刻を指定して見られる。
// 種類（コメントなし・コメントあり・画面録画）を同時に録っている場合は、同じ場面のまま切り替えて見られる。
import type { RecordingKind, TimelineSegment } from '../library/db'
import type { LiveFeedEvent } from './live-feed'
import { Timeline } from './timeline'
import { createReviewPlayer, type ReviewPlayer } from './player'

// 開いた時の再生位置（live: 最新の録画のこれだけ前から）
const INITIAL_BEHIND_SECONDS = 30
// 「ライブ」ボタンで移る位置（最新の録画のこれだけ前。届いたばかりの断片で途切れないように少し余裕を持つ）
const LIVE_EDGE_SECONDS = 8
// ライブからこれ以内なら「ライブ」とみなす（録画は数秒ごとの断片で届くので、少し遅れる）
const LIVE_THRESHOLD_SECONDS = 15
const SKIP_SECONDS = 10
// 保存先から番組の録画を読み直す間隔（録画中に増えた分や、容量の上限を超えて消された部分を反映する）
const SYNC_INTERVAL_MS = 30 * 1000
// 再生できない所を飛ばすのは、1分にこの回数まで（それより多ければ、飛ばし続けずにお知らせする）
const MAX_RECOVERIES_PER_MINUTE = 5
// 種類の名前と、初めに見る種類の優先順
const KIND_LABELS: Record<RecordingKind, string> = { video: 'コメントなし', comments: 'コメントあり', screen: '画面録画' }
const KIND_ORDER: RecordingKind[] = ['video', 'comments', 'screen']

const MESSAGES = {
    live: {
        empty: 'まだプレイバックできる録画がありません。\n録画が始まると、ここで少し前から見られます。',
        unavailable: '拡張機能が更新されたため、プレイバックできません。\nページを開き直してください。',
        loadError: '録画を読み込めませんでした。',
        playError: '録画を再生できませんでした。\nウィンドウを開き直してください。',
    },
    library: {
        empty: 'この番組には、ここで再生できる録画がありません。\n（webm の録画は、区間の一覧から保存して見てください）',
        unavailable: '録画を読み込めませんでした。',
        loadError: '録画を読み込めませんでした。',
        playError: '録画を再生できませんでした。\nページを読み込み直してください。',
    },
}

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
  <video playsinline></video>
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
      ${KIND_ORDER.map(kind => `<button type="button" class="kind kind-${kind}" data-kind="${kind}" aria-pressed="false" aria-label="${KIND_LABELS[kind]}" title="${KIND_LABELS[kind]}" hidden><span class="kind-dot" aria-hidden="true"></span><span class="kind-label">${KIND_LABELS[kind]}</span></button>`).join('')}
    </div>
    <button type="button" class="mute" title="音（M）"></button>
    <button type="button" class="live" title="最新の録画へ戻る（L）"><span class="live-dot" aria-hidden="true"></span><span class="label live-label">ライブ</span></button>
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

// 拡張機能が更新・削除されて、このページから拡張機能の機能を使えなくなった
const isExtensionGone = () => {
    try {
        return !chrome.runtime?.id
    } catch {
        return true
    }
}

// 文字を入力している所（検索欄など）では、キー操作を横取りしない
const isTyping = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
    if (target instanceof HTMLInputElement) return target.type !== 'range' && target.type !== 'checkbox' && target.type !== 'radio'
    return (target as HTMLElement).isContentEditable
}

type ReviewViewState = {
    kind: RecordingKind
    kinds: RecordingKind[] // 見られる種類
    wallClock: number | null // 今の再生位置を録った時刻
    playing: boolean
}

type ReviewViewOptions = {
    root: HTMLElement // この中に画面を作る
    mode: 'live' | 'library'
    readTimeline: () => Promise<TimelineSegment[]>
    readFragments: (segmentId: string, indexes: number[]) => Promise<(Blob | null)[]>
    // 録画中に書き込んだ断片の知らせ（live。同じページで録画している番組の分だけ使う）
    subscribe?: (listener: (event: LiveFeedEvent) => void) => () => void
    programId?: string
    onChange?: (state: ReviewViewState) => void
}

const mountReviewView = ({ root, mode, readTimeline, readFragments, subscribe, programId, onChange }: ReviewViewOptions) => {
    const doc = root.ownerDocument
    const messages = MESSAGES[mode]
    const container = doc.createElement('div')
    container.className = 'review'
    container.innerHTML = TEMPLATE
    root.append(container)

    const $ = <T extends Element>(selector: string) => container.querySelector<T>(selector)!
    const video = $<HTMLVideoElement>('video')
    const message = $<HTMLDivElement>('.message')
    const seek = $<HTMLInputElement>('.seek')
    const playButton = $<HTMLButtonElement>('.play')
    const backButton = $<HTMLButtonElement>('.back')
    const forwardButton = $<HTMLButtonElement>('.forward')
    const muteButton = $<HTMLButtonElement>('.mute')
    const liveButton = $<HTMLButtonElement>('.live')
    const clock = $<HTMLSpanElement>('.clock')
    const behind = $<HTMLSpanElement>('.behind')
    const kindsGroup = $<HTMLDivElement>('.kinds')
    const kindButtons = [...container.querySelectorAll<HTMLButtonElement>('.kind')]
    // live はプレイバックの音を消しておく（ライブの音と重ならないように）
    video.muted = mode === 'live'
    liveButton.hidden = mode !== 'live'

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
    const availableKinds = () => KIND_ORDER.filter(kind => timelines.has(kind) && !timelines.get(kind)!.isEmpty)
    let selectedKind: RecordingKind = 'video'
    let timeline = timelineOf(selectedKind)
    let started = false // 最初の再生位置に移ったか
    let dragging = false // シークバーを動かしている間
    // 読み込む前に見る場所を指定された（library）
    let requested: { kind?: RecordingKind, wallClock?: number, play: boolean } | null = null

    const showMessage = (text: string | null) => {
        message.hidden = text === null
        message.textContent = text ?? ''
    }

    let destroyed = false
    const createPlayer = (target: Timeline): ReviewPlayer => createReviewPlayer({
        video,
        timeline: target,
        readFragments,
        // live は録画中の番組を追いかけるので、区間の切り替わりで動画を終わりにしない
        endAtLast: mode === 'library',
        onError: (error, fragment) => {
            console.error('録画の再生に失敗しました:', error)
            recover(fragment)
        },
        onReadError: () => {
            // 拡張機能が更新されて、保存先から読めなくなった（録画中に届いた分だけは見られる）
            if (isExtensionGone()) showMessage(messages.unavailable)
        },
    })
    let player = createPlayer(timeline)
    let wantsPlaying = false // 再生しようとしているか（再生できない所を飛ばした後に、続けて再生する）
    const playVideo = () => {
        wantsPlaying = true
        // 最後まで再生して止まった後に続きが増えていたら（録画中の番組）、最初からではなく続きから再生する
        if (video.ended && timeline.end > video.currentTime + 0.5) player.seek(video.currentTime)
        video.play().catch(() => {})
    }
    // 最後まで再生して止まっている間に続きが届いたら、続けて再生する
    const resumeIfEnded = () => {
        if (wantsPlaying && video.ended && timeline.end > video.currentTime + 0.5) playVideo()
    }

    // ---- 再生できない所を飛ばす ----
    // 録画が壊れている所（以前のバージョンで、録画の途中で映像の大きさが変わった所など）に当たると、
    // 動画が止まって先へ進めなくなる。その区間の壊れた所から後を外し、再生し直して続きから見る
    const brokenFrom = new Map<string, number>() // 区間 → この時刻（区間の中の秒）から後は再生できない
    const recoveredAt: number[] = []
    let recovering = false

    const removeBroken = () => {
        if (brokenFrom.size === 0) return
        for (const t of timelines.values()) {
            for (const f of t.fragments.filter(f => f.startTime >= (brokenFrom.get(f.segmentId) ?? Infinity))) {
                t.removeFragment(f.segmentId, f.index)
            }
        }
    }

    // fragment: 読み込めなかった断片（わからなければ、再生位置の断片が壊れているとみなす）
    const recover = (fragment?: { segmentId: string, startTime: number, start: number }) => {
        if (recovering || destroyed) return
        // 何度も続く場合は、飛ばし続けずにお知らせする
        const now = Date.now()
        while (recoveredAt.length > 0 && now - recoveredAt[0] > 60 * 1000) recoveredAt.shift()
        const position = player.position
        const broken = fragment ?? timeline.fragments[timeline.indexAt(position)]
        if (!broken || recoveredAt.length >= MAX_RECOVERIES_PER_MINUTE) {
            showMessage(messages.playError)
            return
        }
        recoveredAt.push(now)
        console.log('再生できない所を飛ばします:', broken.segmentId, broken.startTime)
        brokenFrom.set(broken.segmentId, Math.min(brokenFrom.get(broken.segmentId) ?? Infinity, broken.startTime))
        removeBroken()

        recovering = true
        player.destroy()
        player = createPlayer(timeline)
        recovering = false
        if (timeline.isEmpty) return
        // 外した所は録っていない間と同じ扱いになり、次の再生できる所へ進む
        // （先の方の断片が壊れていた場合は、今の位置から続ける）
        player.seek(Math.min(position, broken.start))
        if (wantsPlaying) playVideo()
        render()
    }

    video.addEventListener('error', () => {
        // MEDIA_ERR_DECODE（別のウィンドウの video でも同じ番号）
        if (!recovering && video.error?.code === 3) recover()
    })

    // 録画があれば、見始める位置を決める（live: 最新の少し前から再生、library: 最初から）
    const initialPosition = () => mode === 'live'
        ? Math.max(timeline.start, timeline.end - INITIAL_BEHIND_SECONDS)
        : timeline.start

    // 見る種類と場所を変える。wallClock を指定しなければ、今見ている場面のまま
    const moveTo = (kind: RecordingKind, wallClock: number | null, play: boolean) => {
        if (kind !== selectedKind) {
            player.destroy()
            selectedKind = kind
            timeline = timelineOf(kind)
            player = createPlayer(timeline)
        }
        if (timeline.isEmpty) return
        const target = wallClock === null ? null : timeline.timeAtWallClock(wallClock)
        player.seek(target ?? initialPosition())
        if (play) playVideo()
        started = true
        showMessage(null)
        render()
    }

    // 見る種類を切り替える（同じ場面から続けて見る）
    const selectKind = (kind: RecordingKind) => {
        if (kind === selectedKind) return
        const wallClock = timeline.isEmpty ? null : timeline.wallClockAt(player.position)
        moveTo(kind, wallClock, !video.paused || (!started && mode === 'live'))
    }

    // 初めて録画が読めた時に見始める（初めは「コメントなし」、なければ録ってある種類）
    const startIfReady = () => {
        if (started || destroyed) return
        const kinds = availableKinds()
        if (kinds.length === 0) return
        if (requested) {
            const { kind, wallClock, play } = requested
            requested = null
            moveTo(kind && kinds.includes(kind) ? kind : kinds[0], wallClock ?? null, play)
            return
        }
        moveTo(kinds[0], null, mode === 'live')
    }

    const render = () => {
        if (destroyed) return
        const empty = timeline.isEmpty
        for (const element of [seek, playButton, backButton, forwardButton]) element.disabled = empty
        if (!dragging) {
            seek.min = String(timeline.start)
            seek.max = String(timeline.end)
            seek.value = String(player.position)
        }
        const t = dragging ? Number(seek.value) : player.position
        // シークバーの再生した所まで色をつける
        const length = timeline.end - timeline.start
        seek.style.setProperty('--progress', `${length > 0 ? Math.min(100, Math.max(0, ((t - timeline.start) / length) * 100)) : 0}%`)
        const wallClock = empty ? null : timeline.wallClockAt(t)
        clock.textContent = wallClock === null ? '--:--:--' : formatClock(wallClock)
        seek.setAttribute('aria-valuetext', clock.textContent)

        if (mode === 'live') {
            const behindSeconds = wallClock === null ? null : (Date.now() - wallClock) / 1000
            const atLive = behindSeconds !== null && behindSeconds < LIVE_THRESHOLD_SECONDS
            behind.textContent = behindSeconds === null ? '' : atLive ? 'ライブ' : `ライブの ${formatDuration(behindSeconds)} 前`
            liveButton.classList.toggle('at-live', atLive)
            liveButton.disabled = empty || atLive
            liveButton.setAttribute('aria-label', atLive ? 'ライブ（最新の録画）を再生中' : 'ライブに戻る')
        } else {
            // 番組の録画の中での位置
            behind.textContent = empty ? '' : `${formatDuration(t - timeline.start)} / ${formatDuration(timeline.end - timeline.start)}`
        }

        // 種類が2つ以上ある時だけ、切り替えのボタンを出す
        const kinds = availableKinds()
        kindsGroup.hidden = kinds.length < 2
        kindsGroup.dataset.count = String(kinds.length) // 3つの時は、狭い時に早めに詰める
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
            const target = mode === 'live' ? 'プレイバックの音' : '音'
            muteButton.setAttribute('aria-label', video.muted ? `${target}を出す` : `${target}を消す`)
        }

        onChange?.({ kind: selectedKind, kinds, wallClock, playing: !video.paused })
    }

    const skip = (seconds: number) => player.seek(player.position + seconds, { backward: seconds < 0 })
    const togglePlay = () => {
        if (video.paused) {
            playVideo()
        } else {
            wantsPlaying = false
            video.pause()
        }
    }
    const toggleMute = () => { video.muted = !video.muted }
    const goLive = () => {
        if (mode !== 'live') return
        player.seek(timeline.end - LIVE_EDGE_SECONDS)
        playVideo()
    }

    seek.addEventListener('input', () => { dragging = true; render() })
    // 動かし終えたら（値が変わったら）、その位置へ移る
    const commitSeek = () => {
        dragging = false
        player.seek(Number(seek.value))
        render()
    }
    seek.addEventListener('change', commitSeek)
    // 動かして元の値に戻して離した時は change が届かないので、離した時などにも終える
    // （終えないと、シークバーと時刻の表示が止まったままになる）。離した直後に change が届く時は、
    // そちらで終えるので、少し待ってから確かめる（2回移らないように）
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
        seek.addEventListener(type, () => setTimeout(() => { if (dragging) commitSeek() }))
    }
    backButton.addEventListener('click', () => skip(-SKIP_SECONDS))
    forwardButton.addEventListener('click', () => skip(SKIP_SECONDS))
    playButton.addEventListener('click', togglePlay)
    muteButton.addEventListener('click', toggleMute)
    liveButton.addEventListener('click', goLive)
    for (const button of kindButtons) button.addEventListener('click', () => selectKind(button.dataset.kind as RecordingKind))

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return
        // ページの他のボタンなどを操作している時は横取りしない
        const target = event.target as Node | null
        const onPage = target === doc || target === doc.body || target === doc.documentElement
        if (target && !onPage && !container.contains(target)) return
        // ボタンの上のスペースは、そのボタンを押す
        if (event.key === ' ' && (target as Element | null)?.closest?.('button')) return
        const actions: Record<string, () => void> = {
            ' ': togglePlay, k: togglePlay,
            ArrowLeft: () => skip(-SKIP_SECONDS), j: () => skip(-SKIP_SECONDS),
            ArrowRight: () => skip(SKIP_SECONDS),
            m: toggleMute,
            ...(mode === 'live' ? { l: goLive, End: goLive } : {}),
        }
        const action = actions[event.key]
        if (!action || timeline.isEmpty) return
        event.preventDefault()
        action()
    }
    doc.addEventListener('keydown', onKeyDown)
    for (const type of ['play', 'pause', 'volumechange', 'timeupdate', 'seeking']) video.addEventListener(type, render)
    // 読み込みに一時的に失敗しても、その後に再生できたらお知らせを消す
    video.addEventListener('playing', () => { if (message.textContent === messages.playError) showMessage(null) })

    // ---- 録画の読み込み ----

    const applyFeed = (event: LiveFeedEvent) => {
        if (destroyed) return
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
                removeBroken()
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
    const unsubscribe = subscribe?.((event) => {
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
        if (destroyed) return
        try {
            const segments = await readTimeline()
            // 読んでいる間に閉じられた
            if (destroyed) return
            const byKind = new Map<RecordingKind, TimelineSegment[]>(KIND_ORDER.map(kind => [kind, []]))
            for (const segment of segments) byKind.get(segment.kind)?.push(segment)
            for (const [kind, list] of byKind) {
                if (list.length > 0 || timelines.has(kind)) timelineOf(kind).sync(list)
            }
            removeBroken()
            applyQueued()
            if (availableKinds().length === 0) showMessage(messages.empty)
            startIfReady()
            player.update()
            resumeIfEnded()
        } catch (error) {
            if (destroyed) return
            console.error('録画を読み込めませんでした:', error)
            applyQueued() // 録画中に届く分だけでも見られるように
            if (availableKinds().length === 0) {
                showMessage(error instanceof Error && error.name === 'BridgeUnavailableError' ? messages.unavailable : messages.loadError)
            }
        }
        render()
    }

    render()
    void sync()
    const syncTimer = setInterval(sync, SYNC_INTERVAL_MS)
    const renderTimer = setInterval(render, 1000)

    return {
        // 種類と録った時刻を指定して見る（library。読み込む前なら、読み込んでから）
        show(kind?: RecordingKind, wallClock?: number, play = true) {
            if (destroyed) return
            if (!started) {
                requested = { kind, wallClock, play }
                startIfReady()
                return
            }
            const kinds = availableKinds()
            moveTo(kind && kinds.includes(kind) ? kind : selectedKind, wallClock ?? null, play)
        },

        // 保存先から読み直す（区間を消した後など）
        refresh: sync,

        destroy() {
            destroyed = true
            unsubscribe?.()
            clearInterval(syncTimer)
            clearInterval(renderTimer)
            doc.removeEventListener('keydown', onKeyDown)
            player.destroy()
            container.remove()
        },
    }
}

type ReviewView = ReturnType<typeof mountReviewView>

export { mountReviewView, KIND_LABELS }
export type { ReviewView, ReviewViewState, ReviewViewOptions }
