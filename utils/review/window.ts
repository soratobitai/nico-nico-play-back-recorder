// プレイバックのウィンドウ
// ニコ生のページで生放送を見ながら、少し前の録画を別のウィンドウ（Document Picture-in-Picture）で見る。
// ウィンドウは大きさを変えられ、他のウィンドウの上に重なって表示される。
// 最後に変えた大きさを覚えておき、他のタブで開いた時（Chrome を開き直した後も）その大きさで開く。
// 位置はページから決められない（Chrome が決める）。同じタブで開き直すと、Chrome がそのタブで前に閉じた位置と大きさに戻す。
// 録画は止めずに続け、録画中の最新の部分も届くたびに見られるようになる（画面は view.ts）。
import { getTimeline, getFragmentBlobs } from '../library/api'
import { subscribeLiveFeed } from './live-feed'
import { mountReviewView } from './view'
import { REVIEW_STYLE, REVIEW_WINDOW_STYLE } from './style'
import { PLAYBACK_WINDOW_SIZE, PLAYBACK_WINDOW_FRAME, type PlaybackWindowSize } from '../storage'

// Document Picture-in-Picture（TypeScript の型にまだないので必要な分だけ）
type DocumentPictureInPicture = {
    requestWindow(options?: { width?: number, height?: number }): Promise<Window>
    readonly window: Window | null
}
const documentPictureInPicture = () =>
    (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture

// 開く時に頼む大きさ（覚えた大きさがない時）
const DEFAULT_SIZE: PlaybackWindowSize = { width: 640, height: 420 }
// 頼んだ大きさと、開いたウィンドウの外側の大きさの差（タイトルバーと枠の分。測るまでの見込み）
const DEFAULT_FRAME: PlaybackWindowSize = { width: 16, height: 42 }
// このタブで開く時に頼む大きさ（sessionStorage。タブごと）
// 同じタブでは、頼む大きさを変えない（頼む大きさが前と違うと、Chrome がそのタブで前に閉じた位置と大きさに戻さなくなるので）
const TAB_SIZE_KEY = 'nicoPlaybackRecorder.playbackWindowSize'
// 開いてすぐの大きさの変化は、ユーザーが変えたものとして覚えない
const SETTLE_MS = 1000
// 大きさを変えている間は覚えず、変え終えてから覚える
const SAVE_DELAY_MS = 500
// 覚える大きさの範囲（閉じる途中などの、おかしな値は覚えない。Chrome は幅 約270・高さ 約100 より小さくしない）
const MIN_SIZE = 50
const MAX_SIZE = 10000

type PlaybackWindowOptions = {
    programId: string
    title: string
    programBeginAt?: number | null // 番組が始まった時刻（番組の経過時間を出す）
    screenshotName?: string // スクリーンショットのファイル名の始め（配信者_タイトル）
    onClose?: () => void
}

let current: { close: () => void } | null = null
let opening = false

const isPlaybackSupported = () => !!documentPictureInPicture() && typeof MediaSource !== 'undefined'
const isPlaybackOpen = () => current !== null

const isSize = (value: unknown): value is PlaybackWindowSize => {
    const size = value as PlaybackWindowSize | null
    return !!size && [size.width, size.height].every(n => Number.isFinite(n) && n >= MIN_SIZE && n <= MAX_SIZE)
}

// このタブで開く時に頼む大きさ。このタブで初めて開く時は、覚えた大きさ（なければ初めの大きさ）にして、このタブに覚える
const tabSize = (saved: PlaybackWindowSize | null): { size: PlaybackWindowSize, first: boolean } => {
    try {
        const stored: unknown = JSON.parse(sessionStorage.getItem(TAB_SIZE_KEY) ?? 'null')
        if (isSize(stored)) return { size: stored, first: false }
    } catch {
        // 読めなければ、初めて開いたものとする
    }
    const size = isSize(saved) ? saved : DEFAULT_SIZE
    try {
        sessionStorage.setItem(TAB_SIZE_KEY, JSON.stringify(size))
    } catch {
        // 覚えられなくても開く
    }
    return { size, first: true }
}

// プレイバックのウィンドウを開く（開いていれば閉じる）
// ボタンを押した時に呼ぶこと（ウィンドウは、ユーザーの操作からしか開けない。開いた後は、ページから大きさを変えられない）
const togglePlaybackWindow = async (options: PlaybackWindowOptions) => {
    if (current) {
        current.close()
        return
    }
    if (opening) return
    opening = true
    try {
        const [saved, frame] = await Promise.all([
            PLAYBACK_WINDOW_SIZE.getValue().catch(() => null),
            PLAYBACK_WINDOW_FRAME.getValue().catch(() => null),
        ])
        const { size, first } = tabSize(saved)
        const pip = await documentPictureInPicture()!.requestWindow(size)
        rememberSize(pip, size, frame ?? DEFAULT_FRAME, first)
        current = mountPlaybackWindow(pip, options)
    } finally {
        opening = false
    }
}

// ユーザーが大きさを変えたら、次に開く時に頼む大きさとして覚える
// requested: 開く時に頼んだ大きさ。measure: このタブで初めて開いた（頼んだ大きさで開くので、タイトルバーと枠の分を測れる）
const rememberSize = (pip: Window, requested: PlaybackWindowSize, frame: PlaybackWindowSize, measure: boolean) => {
    const openedAt = Date.now()
    let frameSize = frame
    if (measure) {
        setTimeout(() => {
            const measured = { width: pip.outerWidth - requested.width, height: pip.outerHeight - requested.height }
            // 画面に収まらず小さくされた時などの、おかしな値は使わない
            if (pip.closed || measured.width < 0 || measured.width > 100 || measured.height < 0 || measured.height > 200) return
            frameSize = measured
            void PLAYBACK_WINDOW_FRAME.setValue(measured).catch(() => {})
        }, SETTLE_MS)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    pip.addEventListener('resize', () => {
        if (pip.closed || Date.now() - openedAt < SETTLE_MS) return
        // 閉じた後は大きさを読めないので、変えた時の大きさを覚えておく
        const size = { width: pip.outerWidth - frameSize.width, height: pip.outerHeight - frameSize.height }
        if (!isSize(size)) return
        clearTimeout(timer)
        timer = setTimeout(() => void PLAYBACK_WINDOW_SIZE.setValue(size).catch(() => {}), SAVE_DELAY_MS)
    })
}

const mountPlaybackWindow = (pip: Window, { programId, title, programBeginAt, screenshotName, onClose }: PlaybackWindowOptions) => {
    const doc = pip.document
    doc.title = `プレイバック - ${title}`
    const style = doc.createElement('style')
    style.textContent = REVIEW_WINDOW_STYLE + REVIEW_STYLE
    doc.head.append(style)

    const view = mountReviewView({
        root: doc.body,
        mode: 'live',
        programId,
        programBeginAt,
        screenshotName: () => screenshotName ?? '',
        readTimeline: () => getTimeline(programId),
        readFragments: getFragmentBlobs,
        subscribe: subscribeLiveFeed,
    })

    pip.addEventListener('pagehide', () => {
        view.destroy()
        current = null
        onClose?.()
    }, { once: true })

    return { close: () => pip.close() }
}

export { isPlaybackSupported, isPlaybackOpen, togglePlaybackWindow }
