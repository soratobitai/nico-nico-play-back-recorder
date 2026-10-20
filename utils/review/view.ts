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
import { formatRecorded, formatElapsed, formatBroadcastTime, formatAgo } from '../time-format'
import { KIND_ICON_PATHS, SCREEN_DOT } from '../kind-icons'
import { createRowFitter } from './fit'

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
// 掴んで動かしている間に、移った位置のコマが出るのを待つ時間の上限（読み込みに時間がかかる所でも、次の位置へ移れるように）
const SCRUB_WAIT_MS = 250
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
        empty: 'この番組には、ここで再生できる録画がありません。\n（webm の録画は、右の録画の一覧から保存して見てください）',
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
// 種類の切り替えのアイコン（録画バーの種類のチップと同じ形）
const KIND_ICONS: Record<RecordingKind, string> = {
    video: icon(KIND_ICON_PATHS.video),
    comments: icon(KIND_ICON_PATHS.comments),
    screen: icon(`${KIND_ICON_PATHS.screen}<circle cx="${SCREEN_DOT.cx}" cy="${SCREEN_DOT.cy}" r="${SCREEN_DOT.r}"></circle>`),
}

const TRANSPORT = `
    <button type="button" class="back" aria-label="${SKIP_SECONDS}秒戻る" title="${SKIP_SECONDS}秒戻る（←）">${ICONS.back}<span class="label">${SKIP_SECONDS}秒</span></button>
    <button type="button" class="play" aria-label="再生" title="再生・一時停止（スペース）">${ICONS.play}</button>
    <button type="button" class="forward" aria-label="${SKIP_SECONDS}秒進む" title="${SKIP_SECONDS}秒進む（→）"><span class="label">${SKIP_SECONDS}秒</span>${ICONS.forward}</button>`
const TIME = `
    <div class="time"><span class="time-main"><span class="clock">--:--</span><span class="program-time" title="番組が始まってからの時間（ニコ生のプレイヤーの表示と同じ）"></span></span><span class="behind" hidden><span class="scene-time"></span><span class="ago"></span></span></div>`
const OPTIONS = `
    <div class="kinds" role="group" aria-label="録画の種類" hidden>
      ${KIND_ORDER.map(kind => `<button type="button" class="kind kind-${kind}" data-kind="${kind}" aria-pressed="false" aria-label="${KIND_LABELS[kind]}" title="${KIND_LABELS[kind]}の録画を見る" hidden>${KIND_ICONS[kind]}</button>`).join('')}
    </div>
    <button type="button" class="mute" title="音（M）"></button>`
const LIVE = `
    <button type="button" class="live" title="最新の録画へ戻る（L）"><span class="live-dot" aria-hidden="true"></span><span class="label live-label">ライブ</span></button>`

// 操作の行: 再生の操作を真ん中に、種類と音を左に、時間（と、プレイバックではライブに戻るボタン）を右に
const TEMPLATE = `
<div class="stage">
  <video playsinline></video>
  <div class="message" role="status" hidden></div>
</div>
<div class="bar">
  <input class="seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="再生位置">
  <div class="row"><div class="row-start">${OPTIONS}</div><div class="row-center">${TRANSPORT}</div><div class="row-end">${TIME}${LIVE}</div></div>
</div>
`

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
    // 番組が始まった時刻（録画の時間の横に、番組の経過時間を出す。分からなければ出さない）
    programBeginAt?: number | null
    // 録画を始めた時刻（録画の時間を出す。指定しなければ、最初に録った所の時刻）
    recordingStartedAt?: number | null
    onChange?: (state: ReviewViewState) => void
}

type TimeBases = Pick<ReviewViewOptions, 'programBeginAt' | 'recordingStartedAt'>

const mountReviewView = ({ root, mode, readTimeline, readFragments, subscribe, programId, onChange, ...options }: ReviewViewOptions) => {
    // 時間を数える基準（録画を消した後などに、setTimeBases で差し替える）
    let bases: TimeBases = { programBeginAt: options.programBeginAt, recordingStartedAt: options.recordingStartedAt }
    const doc = root.ownerDocument
    const messages = MESSAGES[mode]
    const container = doc.createElement('div')
    container.className = 'review'
    container.dataset.mode = mode
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
    const programTime = $<HTMLSpanElement>('.program-time')
    const behind = $<HTMLSpanElement>('.behind')
    const sceneTime = $<HTMLSpanElement>('.scene-time')
    const ago = $<HTMLSpanElement>('.ago')
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
    // live は動画の終わりにしない（録画中の番組を追いかけるので）。録り終えた録画（録画中の区間がない）を最後まで見て、
    // しばらく続きが届かなければ止める（止めないと、再生中のまま固まって見える）
    const FINISHED_WAIT_MS = 10 * 1000
    let waitingAtEndSince: number | null = null
    let stoppedAtEnd = false
    const stopIfFinished = () => {
        const finished = mode === 'live' && !video.paused && !timeline.isEmpty && player.position >= timeline.end - 0.3
            && !timeline.placedSegments.some(s => s.endedAt === null)
        if (!finished) {
            waitingAtEndSince = null
            return
        }
        waitingAtEndSince ??= Date.now()
        if (Date.now() - waitingAtEndSince < FINISHED_WAIT_MS) return
        waitingAtEndSince = null
        stoppedAtEnd = true
        video.pause()
    }
    video.addEventListener('play', () => { stoppedAtEnd = false })
    // 最後まで再生して止まっている間に続きが届いたら、続けて再生する
    const resumeIfEnded = () => {
        if (wantsPlaying && video.ended && timeline.end > video.currentTime + 0.5) playVideo()
        if (stoppedAtEnd && timeline.end > player.position + 0.5) playVideo()
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

    // 見ていた録画（区間）が消された（録画一覧で削除した・容量の上限を超えて消された）。
    // 読み込み済みの消した録画を再生し続けないように作り直し、残っている所から見る。見ていた種類が全部消されたら、残っている種類へ
    const reopenAfterRemoved = (wallClock: number | null) => {
        const play = !video.paused
        const kinds = availableKinds()
        if (timeline.isEmpty && kinds.length > 0) {
            moveTo(kinds[0], wallClock, play)
            return
        }
        video.pause()
        player.destroy()
        player = createPlayer(timeline)
        if (timeline.isEmpty) return
        player.seek(wallClock === null ? timeline.start : timeline.timeAtWallClock(wallClock) ?? timeline.start)
        if (play) playVideo()
    }

    // 見る種類を切り替える（同じ場面から続けて見る）
    const selectKind = (kind: RecordingKind) => {
        if (kind === selectedKind) return
        const wallClock = timeline.isEmpty ? null : timeline.wallClockAt(player.position)
        moveTo(kind, wallClock, !video.paused || (!started && mode === 'live'))
    }

    // 録った所の終わりの時刻
    const endWallClockOf = (kind: RecordingKind) => {
        const t = timelines.get(kind)
        return t && !t.isEmpty ? t.wallClockAt(t.end) ?? -Infinity : -Infinity
    }
    // 最も新しい所まで録ってある種類（録画中に種類を切り替えた後などに、今録っている種類を見られるように）。
    // 種類ごとに少しずつずれて届くので、preferred より LIVE_THRESHOLD_SECONDS 以上新しい時だけ他の種類にする
    const latestKind = (kinds: RecordingKind[], preferred: RecordingKind) => kinds.reduce(
        (best, kind) => endWallClockOf(kind) > endWallClockOf(best) + LIVE_THRESHOLD_SECONDS * 1000 ? kind : best,
        kinds.includes(preferred) ? preferred : kinds[0],
    )

    // 初めて録画が読めた時に見始める（初めは「コメントなし」、なければ録ってある種類。
    // プレイバックのウィンドウでは、今録っている（最も新しい所まである）種類）
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
        moveTo(mode === 'live' ? latestKind(kinds, kinds[0]) : kinds[0], null, mode === 'live')
    }

    // 最初に録り始めた時刻（録画を始めた時刻を指定されていない時に、録画の時間を数える基準）。
    // 残っている区間の始まりで数える（録画一覧と同じ。容量の上限で古い断片が消されても、区間が残っている間は変わらない）
    const firstRecordedAt = () => {
        let first: number | null = null
        for (const t of timelines.values()) {
            for (const segment of t.placedSegments) if (first === null || segment.startedAt < first) first = segment.startedAt
        }
        return first
    }

    // 操作の行が入りきらない時は、いらないものから隠す
    const rowFitter = createRowFitter(container)
    let lastLayoutKey = ''

    const render = () => {
        if (destroyed) return
        stopIfFinished()
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
        // 大きく出すのは、録画を始めてからの時間。横に番組の経過時間（ニコ生のプレイヤーの表示と同じ）
        const { programBeginAt, recordingStartedAt } = bases
        const recordedBase = recordingStartedAt ?? firstRecordedAt()
        clock.textContent = wallClock === null || recordedBase === null ? '--:--' : formatRecorded(wallClock - recordedBase)
        programTime.textContent = wallClock === null || !programBeginAt ? '' : `（番組 ${formatElapsed(wallClock - programBeginAt)}）`
        // 2段目は、その場面の時刻（プレイバックのウィンドウでは、ライブからどれだけ前か も）
        const at = wallClock === null ? '' : `${formatBroadcastTime(wallClock)}時点`
        sceneTime.textContent = at
        behind.hidden = !at
        // 窓が狭くて番組の経過時間が隠れている時も、マウスを乗せれば分かるように
        clock.title = `録画を始めてからの時間${programTime.textContent}`
        behind.title = wallClock === null ? '' : `${formatBroadcastTime(wallClock, { seconds: true })}時点`
        seek.setAttribute('aria-valuetext', wallClock === null ? clock.textContent : `録画 ${clock.textContent}${programTime.textContent} ${at}`)

        if (mode === 'live') {
            const behindMs = wallClock === null ? null : Date.now() - wallClock
            const atLive = behindMs !== null && behindMs < LIVE_THRESHOLD_SECONDS * 1000
            ago.textContent = behindMs === null ? '' : `（${atLive ? 'ライブ' : formatAgo(behindMs)}）`
            liveButton.classList.toggle('at-live', atLive)
            liveButton.disabled = empty || atLive
            liveButton.setAttribute('aria-label', atLive ? 'ライブ（最新の録画）を再生中' : 'ライブに戻る')
        }

        // 種類が2つ以上ある時だけ、切り替えのボタンを出す
        const kinds = availableKinds()
        kindsGroup.hidden = kinds.length < 2
        kindsGroup.dataset.count = String(kinds.length)
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

        // 文字の長さや種類の数が変わったら、操作の行に入りきるか確かめ直す
        const layoutKey = [clock.textContent, programTime.textContent, sceneTime.textContent, ago.textContent].map(text => text?.length).concat(kinds.length, Number(video.muted)).join()
        if (layoutKey !== lastLayoutKey) {
            lastLayoutKey = layoutKey
            rowFitter.schedule()
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
        // 見ている種類を今は録っていなければ、今録っている種類のライブへ
        const kind = latestKind(availableKinds(), selectedKind)
        if (kind !== selectedKind) moveTo(kind, null, false)
        player.seek(timeline.end - LIVE_EDGE_SECONDS)
        playVideo()
    }

    // ---- 掴んで動かしている間は、その位置のコマを表示する（シークバー・録画一覧のタイムライン） ----
    // 動かしている間は再生を止める。前の位置のコマを出し終えてから（読み込みに時間がかかる時は少し待ってから）
    // 最新の位置へ移す（速く動かして追いつけない分は飛ばす）
    let scrub: { wasPlaying: boolean, target: number | null, waiting: boolean } | null = null
    let scrubTimer: ReturnType<typeof setTimeout> | undefined
    const scrubNext = () => {
        clearTimeout(scrubTimer)
        video.removeEventListener('seeked', scrubNext)
        if (!scrub) return
        scrub.waiting = false
        if (scrub.target === null) return
        const t = scrub.target
        scrub.target = null
        scrub.waiting = true
        video.addEventListener('seeked', scrubNext)
        scrubTimer = setTimeout(scrubNext, SCRUB_WAIT_MS)
        player.seek(t)
    }
    const scrubTo = (t: number) => {
        if (!scrub) {
            scrub = { wasPlaying: !video.paused, target: null, waiting: false }
            wantsPlaying = false
            video.pause()
        }
        scrub.target = t
        if (!scrub.waiting) scrubNext()
    }
    // 動かし終えて、その位置へ移る。play: 続けて再生するか（指定しなければ、動かす前に再生していたら続ける）
    const endScrub = (t: number, play?: boolean) => {
        const wasPlaying = scrub?.wasPlaying
        clearTimeout(scrubTimer)
        video.removeEventListener('seeked', scrubNext)
        scrub = null
        player.seek(t)
        if (play ?? wasPlaying) playVideo()
    }

    seek.addEventListener('input', () => {
        dragging = true
        scrubTo(Number(seek.value))
        render()
    })
    // 動かし終えたら（値が変わったら）、その位置へ移る
    const commitSeek = () => {
        dragging = false
        endScrub(Number(seek.value))
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
    // 動画を押すと再生・一時停止する
    video.addEventListener('click', () => { if (!timeline.isEmpty) togglePlay() })

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
        resumeIfEnded()
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
            // 見ている所（読み直す前）
            const position = player.position
            const watching = started && !timeline.isEmpty
                ? { wallClock: timeline.wallClockAt(position), segmentId: timeline.fragments[timeline.indexAt(position)]?.segmentId }
                : null
            const byKind = new Map<RecordingKind, TimelineSegment[]>(KIND_ORDER.map(kind => [kind, []]))
            for (const segment of segments) byKind.get(segment.kind)?.push(segment)
            for (const [kind, list] of byKind) {
                if (list.length > 0 || timelines.has(kind)) timelineOf(kind).sync(list)
            }
            removeBroken()
            applyQueued()
            if (watching?.segmentId && !timeline.segment(watching.segmentId)) reopenAfterRemoved(watching.wallClock)
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

    // 種類と録った時刻を指定して見る（library。読み込む前なら、読み込んでから）
    const show = (kind?: RecordingKind, wallClock?: number, play = true) => {
        if (destroyed) return
        if (!started) {
            requested = { kind, wallClock, play }
            startIfReady()
            return
        }
        const kinds = availableKinds()
        moveTo(kind && kinds.includes(kind) ? kind : selectedKind, wallClock ?? null, play)
    }
    // 違う種類を掴んだら、その種類に切り替える
    const switchKindFor = (kind: RecordingKind, wallClock: number) => {
        if (kind !== selectedKind && availableKinds().includes(kind)) moveTo(kind, wallClock, false)
    }

    return {
        show,

        // 録った時刻の場面のコマを表示する（library のタイムラインを掴んで動かしている間）
        scrub(kind: RecordingKind, wallClock: number) {
            if (destroyed || !started) return
            switchKindFor(kind, wallClock)
            const t = timeline.timeAtWallClock(wallClock)
            if (t !== null) scrubTo(t)
            render()
        },

        // 掴んで動かし終えた（その時刻から見る。play なら続けて再生する）
        endScrub(kind: RecordingKind, wallClock: number, play = true) {
            if (destroyed) return
            if (!started) {
                show(kind, wallClock, play)
                return
            }
            switchKindFor(kind, wallClock)
            const t = timeline.timeAtWallClock(wallClock)
            if (t !== null) endScrub(t, play)
            render()
        },

        // 保存先から読み直す（区間を消した後など）
        refresh: sync,

        // 時間を数える基準を差し替える（録画を消して、最初に録った時刻が変わった時など）
        setTimeBases(next: TimeBases) {
            if (next.programBeginAt === bases.programBeginAt && next.recordingStartedAt === bases.recordingStartedAt) return
            bases = { ...next }
            render()
        },

        destroy() {
            destroyed = true
            unsubscribe?.()
            clearInterval(syncTimer)
            clearInterval(renderTimer)
            rowFitter.destroy()
            clearTimeout(scrubTimer)
            doc.removeEventListener('keydown', onKeyDown)
            player.destroy()
            container.remove()
        },
    }
}

type ReviewView = ReturnType<typeof mountReviewView>

export { mountReviewView, KIND_LABELS }
export type { ReviewView, ReviewViewState, ReviewViewOptions }
