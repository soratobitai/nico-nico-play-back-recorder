// 流れるコメントを含めて録画するための映像を作る
// ニコ生のプレイヤーはコメントを canvas（表示サイズに関係なく 1366x768）に描いているので、
// 動画のコマが届くたびに「動画 → コメントの canvas」の順に描き重ねる。
// タイマーで描くと、タブが裏にある間は Chrome にタイマーを間引かれてコマ落ちするため、
// 動画のコマを受け取る MediaStreamTrackProcessor と、合成したコマを流す MediaStreamTrackGenerator を使う。

// Chrome にしかない API なので TypeScript の型定義にない。使う分だけ宣言する
declare const MediaStreamTrackProcessor: {
    new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
} | undefined
declare const MediaStreamTrackGenerator: {
    new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<VideoFrame> }
} | undefined

// コメントの層の canvas
const COMMENT_CANVAS_SELECTOR = '[class*="___comment-layer___"] canvas'

type CommentCompositor = {
    stream: MediaStream // 合成した映像と、動画の音声
    stop: () => void
}

// 出力する映像の大きさ。縦は動画に合わせ、縦横比はコメントの canvas（＝プレイヤーの表示領域）に合わせる
// （H.264 は幅・高さが偶数である必要がある）
const getOutputSize = (videoHeight: number, commentCanvas: { width: number, height: number } | null) => {
    const aspect = commentCanvas && commentCanvas.width > 0 && commentCanvas.height > 0
        ? commentCanvas.width / commentCanvas.height
        : 16 / 9
    const height = videoHeight > 0 ? videoHeight : 720
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
    return { width: even(height * aspect), height: even(height) }
}

// コメントを合成した映像を作る。この環境で使えない場合は null を返す（呼び出し側でコメントなしの録画にする）
const createCommentCompositor = (video: HTMLVideoElement): CommentCompositor | null => {
    if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') {
        console.log('この環境ではコメントを合成できないため、コメントなしで録画します')
        return null
    }

    const source = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
    const [sourceVideoTrack] = source.getVideoTracks()
    if (!sourceVideoTrack) {
        source.getTracks().forEach(track => track.stop())
        return null
    }

    let commentCanvas = document.querySelector<HTMLCanvasElement>(COMMENT_CANVAS_SELECTOR)
    const { width, height } = getOutputSize(video.videoHeight, commentCanvas)
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!

    const draw = (frame: VideoFrame) => {
        // 動画は表示領域に収まるように中央に描く（縦横比が違う場合はプレイヤーと同じく黒帯になる）
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, width, height)
        const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight)
        const w = frame.displayWidth * scale
        const h = frame.displayHeight * scale
        ctx.drawImage(frame, (width - w) / 2, (height - h) / 2, w, h)

        // プレイヤーが作り直された場合に備えて、外れていたら探し直す
        if (!commentCanvas?.isConnected) {
            commentCanvas = document.querySelector<HTMLCanvasElement>(COMMENT_CANVAS_SELECTOR)
        }
        // タブが裏にある間はページがコメントの描画を止めるので、止まったコメントを重ねない
        // プレイヤーでコメントを非表示にしている間も重ねない
        if (commentCanvas && !document.hidden && commentCanvas.checkVisibility()) {
            ctx.drawImage(commentCanvas, 0, 0, width, height)
        }
    }

    const reader = new MediaStreamTrackProcessor({ track: sourceVideoTrack }).readable.getReader()
    const generator = new MediaStreamTrackGenerator({ kind: 'video' })
    const writer = generator.writable.getWriter()

    let stopped = false
    const pump = async () => {
        while (!stopped) {
            const { value: frame, done } = await reader.read()
            if (done || !frame) break
            try {
                draw(frame)
                // 書き込んだコマは generator 側で解放される
                await writer.write(new VideoFrame(canvas, { timestamp: frame.timestamp }))
            } finally {
                frame.close()
            }
        }
    }
    pump().catch((error) => {
        if (!stopped) console.log('コメントの合成に失敗しました:', error)
    })

    return {
        stream: new MediaStream([generator, ...source.getAudioTracks()]),
        stop: () => {
            stopped = true
            reader.cancel().catch(() => {})
            generator.stop()
            source.getTracks().forEach(track => track.stop())
        },
    }
}

export { createCommentCompositor, getOutputSize }
export type { CommentCompositor }
