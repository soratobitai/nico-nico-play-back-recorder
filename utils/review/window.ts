// 見直しのウィンドウ
// ニコ生のページで生放送を見ながら、少し前の録画を別のウィンドウ（Document Picture-in-Picture）で見直す。
// ウィンドウは大きさを変えられ、他のウィンドウの上に重なって表示される。
// 録画は止めずに続け、録画中の最新の部分も届くたびに見直せるようになる（画面は view.ts）。
import { getTimeline, getFragmentBlobs } from '../library/api'
import { subscribeLiveFeed } from './live-feed'
import { mountReviewView } from './view'
import { REVIEW_STYLE, REVIEW_WINDOW_STYLE } from './style'

// Document Picture-in-Picture（TypeScript の型にまだないので必要な分だけ）
type DocumentPictureInPicture = {
    requestWindow(options?: { width?: number, height?: number }): Promise<Window>
    readonly window: Window | null
}
const documentPictureInPicture = () =>
    (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture

const WINDOW_SIZE = { width: 640, height: 420 }

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
    style.textContent = REVIEW_WINDOW_STYLE + REVIEW_STYLE
    doc.head.append(style)

    const view = mountReviewView({
        root: doc.body,
        mode: 'live',
        programId,
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

export { isReviewSupported, isReviewOpen, toggleReviewWindow }
