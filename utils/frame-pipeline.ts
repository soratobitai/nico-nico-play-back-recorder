// 映像のコマを1枚ずつ受け取って一定の大きさの canvas に描き直し、新しい映像として流す
// （コメントの合成と、画面ごと録画の両方で使う）
// タイマーで描くと、タブが裏にある間は Chrome にタイマーを間引かれてコマ落ちするため、
// コマを受け取る MediaStreamTrackProcessor と、描き直したコマを流す MediaStreamTrackGenerator を使い、
// コマが届くたびに描く。

// Chrome にしかない API なので TypeScript の型定義にない。使う分だけ宣言する
declare const MediaStreamTrackProcessor: {
    new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> }
} | undefined
declare const MediaStreamTrackGenerator: {
    new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<VideoFrame> }
} | undefined

type FramePipeline = {
    track: MediaStreamTrack // 描き直した映像
    stop: () => void // 描き直しを止める（元の映像のトラックは呼び出し側で止める）
}

const isFramePipelineSupported = () =>
    typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined'

// 出力する映像の大きさ。縦は動画に合わせ、縦横比は表示領域（プレイヤーの画面）に合わせる
// （H.264 は幅・高さが偶数である必要がある）
const getOutputSize = (videoHeight: number, area: { width: number, height: number } | null) => {
    const aspect = area && area.width > 0 && area.height > 0
        ? area.width / area.height
        : 16 / 9
    const height = videoHeight > 0 ? videoHeight : 720
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
    return { width: even(height * aspect), height: even(height) }
}

// コマの一部（コマの中の位置。コマの画素で）
type FrameRegion = { x: number, y: number, width: number, height: number }

// コマ（region を指定すれば、その部分）を表示領域に収まるように中央に描く（縦横比が違う場合はプレイヤーと同じく黒帯になる）
// region がコマの外にはみ出していても、はみ出した所は描かれずに黒のまま残る（drawImage が切り詰める）
const drawContain = (ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame, width: number, height: number, region?: FrameRegion) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)
    const source = region ?? { x: 0, y: 0, width: frame.displayWidth, height: frame.displayHeight }
    if (source.width <= 0 || source.height <= 0) return
    const scale = Math.min(width / source.width, height / source.height)
    const w = source.width * scale
    const h = source.height * scale
    ctx.drawImage(frame, source.x, source.y, source.width, source.height, (width - w) / 2, (height - h) / 2, w, h)
}

// source のコマが届くたびに draw で描き直した映像を作る（isFramePipelineSupported() を確認してから呼ぶ）
const createFramePipeline = (
    source: MediaStreamTrack,
    width: number,
    height: number,
    draw: (ctx: OffscreenCanvasRenderingContext2D, frame: VideoFrame) => void,
): FramePipeline => {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!

    const reader = new MediaStreamTrackProcessor!({ track: source }).readable.getReader()
    const generator = new MediaStreamTrackGenerator!({ kind: 'video' })
    const writer = generator.writable.getWriter()

    let stopped = false
    const pump = async () => {
        while (!stopped) {
            const { value: frame, done } = await reader.read()
            if (done || !frame) break
            try {
                draw(ctx, frame)
                // 書き込んだコマは generator 側で解放される
                await writer.write(new VideoFrame(canvas, { timestamp: frame.timestamp }))
            } finally {
                frame.close()
            }
        }
    }
    pump().catch((error) => {
        if (!stopped) console.log('映像の描き直しに失敗しました:', error)
    })

    return {
        track: generator,
        stop: () => {
            stopped = true
            reader.cancel().catch(() => {})
            generator.stop()
        },
    }
}

export { isFramePipelineSupported, getOutputSize, drawContain, createFramePipeline }
export type { FramePipeline, FrameRegion }
