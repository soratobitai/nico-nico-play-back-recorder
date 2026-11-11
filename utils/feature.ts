
import { downloadBlob } from './download'
import { getOutputSize } from './frame-pipeline'
import { COMMENT_CANVAS_SELECTOR } from './comment-compositor'

// Chrome にしかない API なので TypeScript の型定義にない。使う分だけ宣言する
declare const MediaStreamTrackProcessor: {
    new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
} | undefined

// 映像のトラックから、今の1コマを canvas に描く（取れなければ null）
const FRAME_WAIT_MS = 2000
const grabFrame = async (track: MediaStreamTrack) => {
    if (typeof MediaStreamTrackProcessor === 'undefined' || track.readyState !== 'live') return null
    const clone = track.clone()
    const reader = new MediaStreamTrackProcessor({ track: clone }).readable.getReader()
    try {
        const result = await Promise.race([reader.read(), new Promise<null>(resolve => setTimeout(() => resolve(null), FRAME_WAIT_MS))])
        const frame = result?.value
        if (!frame) return null
        try {
            const canvas = document.createElement('canvas')
            canvas.width = frame.displayWidth
            canvas.height = frame.displayHeight
            canvas.getContext('2d')?.drawImage(frame, 0, 0)
            return canvas
        } finally {
            frame.close()
        }
    } finally {
        reader.cancel().catch(() => {})
        clone.stop()
    }
}

const getProgramData = () => {
    // ユーザー名を取得（ページの構造が変わって取れなくても、録画は続けられるように空にする）
    let userName_ = ''
    let ldStartDate: unknown
    try {
        const ldJson = JSON.parse(document.querySelector('script[type="application/ld+json"]')?.textContent || '{}')
        const name = ldJson?.author?.name
        if (typeof name === 'string') userName_ = name
        ldStartDate = ldJson?.startDate
    } catch (error) {
        console.log('ユーザー名の取得に失敗しました:', error)
    }
    const userName = userName_.replace(/[\\/:*?"<>|]/g, '')

    // タイトルを取得
    let title_ = ''
    const meta = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null
    if (meta) title_ = meta.content
    const title = (title_ || '').replace(/[\\/:*?"<>|]/g, '')

    // ページに埋め込まれた番組の情報
    let program: { beginTime?: unknown, nicoliveProgramId?: unknown } | undefined
    try {
        program = JSON.parse(document.getElementById('embedded-data')?.dataset.props || '{}')?.program
    } catch {
        // 読めなければ、URL と番組情報（ld+json）から
    }

    // 番組 ID（lv…）。チャンネルやコミュニティの URL（/watch/ch…）で開いた時も、今の放送の番組 ID にする
    // （URL のままだと、同じ URL で録った別の日の放送が1つの番組にまとまってしまう）
    const embeddedId = program?.nicoliveProgramId
    const programId = typeof embeddedId === 'string' && /^lv\d+$/.test(embeddedId)
        ? embeddedId
        : location.pathname.match(/lv\d+/)?.[0] ?? location.pathname

    // 番組が始まった時刻（ミリ秒。プレイバックと録画一覧で、番組の経過時間を出すのに使う。読めなければ null）
    let beginAt: number | null = null
    const seconds = program?.beginTime
    if (typeof seconds === 'number' && seconds > 0) beginAt = seconds * 1000
    if (beginAt === null && typeof ldStartDate === 'string') {
        const parsed = Date.parse(ldStartDate)
        if (!Number.isNaN(parsed)) beginAt = parsed
    }

    return { programId, userName, title, beginAt }
}

// ライブ映像の今のコマを、録画リスト用の小さなサムネイル（JPEG の data URL）にする
// 映像がまだ表示されていない場合は null（デフォルトの画像で表示される）
const captureThumbnail = (video: HTMLVideoElement | null, width = 160): string | null => {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
    try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = Math.round(width * video.videoHeight / video.videoWidth)
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', 0.7)
    } catch (error) {
        console.log('サムネイルを作れませんでした:', error)
        return null
    }
}

// 動画の形式からダウンロード時の拡張子を決める（webm で録画した環境以外は mp4）
const getVideoExtension = (type: string) => type.startsWith('video/webm') ? 'webm' : 'mp4'

// 録画バーのスクリーンショット: 今の場面を、動画の解像度の PNG で保存する
// 「コメントなし」（動画だけ）と「コメントあり」（流れているコメントを重ねたもの。録画の「コメントあり」と同じ大きさ）の2枚。
// プレイヤーでコメントを非表示にしている時は、コメントありは同じ絵になるので保存しない。
// ゲームやギフトの演出は、ページから絵として読み出せない（別のサイトの画像を使っているため）。
// 画面録画中（screenTrack: 画面録画の映像）は、その映像から1コマを切り出して「画面録画」の1枚も保存する（演出も入る）
const getScreenShotAndDownload = async (screenTrack?: MediaStreamTrack) => {
    const video = document.querySelector('video')
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return

    try {
        // 画面録画の1コマは、ほかの2枚を描く間に取る（なるべく同じ瞬間になるように）
        const screenShot = screenTrack ? grabFrame(screenTrack).catch(() => null) : Promise.resolve(null)
        const draw = (width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) => {
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const ctx = canvas.getContext('2d')
            if (!ctx) throw new Error('Canvas 2D context not available')
            paint(ctx)
            return canvas
        }
        // 先に両方を描いてから保存する（保存している間に、場面が進まないように）
        const shots = [{ canvas: draw(video.videoWidth, video.videoHeight, ctx => ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight)), suffix: '' }]
        const commentCanvas = document.querySelector<HTMLCanvasElement>(COMMENT_CANVAS_SELECTOR)
        if (commentCanvas?.checkVisibility()) {
            // 縦横比はコメントの canvas（＝プレイヤーの表示領域）に合わせ、動画は収まるように中央に描く（録画の「コメントあり」と同じ）
            const { width, height } = getOutputSize(video.videoHeight, commentCanvas)
            shots.push({
                canvas: draw(width, height, (ctx) => {
                    ctx.fillStyle = '#000'
                    ctx.fillRect(0, 0, width, height)
                    const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
                    const w = video.videoWidth * scale
                    const h = video.videoHeight * scale
                    ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h)
                    ctx.drawImage(commentCanvas, 0, 0, width, height)
                }),
                suffix: '_コメントあり',
            })
        }
        const screen = await screenShot
        if (screen) shots.push({ canvas: screen, suffix: '_画面録画' })
        const { userName, title } = getProgramData()
        const name = [userName, title, formatDateForFileName(Date.now())].filter(Boolean).join('_')
        for (const { canvas, suffix } of shots) {
            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
            if (blob) await downloadBlob(blob, `${name}${suffix}.png`)
        }
    } catch (err) {
        console.error('スクリーンショット処理中にエラー:', err)
    }
}

// 日時を「YYYY-MM-DD hh mm ss」の形にする（時・分・秒の区切りを timeSeparator で指定する）
const formatDateTime = (input: string | number, timeSeparator: string) => {
    const date = new Date(input)

    const pad = (n: number) => n.toString().padStart(2, '0')

    const year = date.getFullYear()
    const month = pad(date.getMonth() + 1)
    const day = pad(date.getDate())
    const hours = pad(date.getHours())
    const minutes = pad(date.getMinutes())
    const seconds = pad(date.getSeconds())

    return `${year}-${month}-${day} ${[hours, minutes, seconds].join(timeSeparator)}`
}

// ファイル名用（ファイル名に使えない「:」を含めない）: 2025-01-02 030405
const formatDateForFileName = (input: string | number) => formatDateTime(input, '')

// 表示用: 2025-01-02 03:04:05




export {
    getProgramData,
    captureThumbnail,
    getVideoExtension,
    downloadBlob,
    getScreenShotAndDownload,
    formatDateForFileName,
}