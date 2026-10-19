// 種類ごとに、録画する映像（と音声）を作る
// - 動画のみ: 動画をそのまま。一定の解像度で録る場合は、決まった大きさに描き直す
// - コメント付き: 動画に流れるコメントを重ねたもの（comment-compositor）
// - 画面: プレイヤーの表示部分を画面ごと（screen-capture。ユーザーの操作から始める必要があるので、ここでは作らない）
import { createFramePipeline, drawContain, getOutputSize, isFramePipelineSupported } from './frame-pipeline'
import { createCommentCompositor } from './comment-compositor'

type RecordingSource = {
    stream: MediaStream
    // 動画の解像度が変わっても、録画の解像度が変わらない（録り直さなくてよい）
    fixedSize: boolean
    stop: () => void
}

const stopAll = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop())

// 動画の取り込み
// 同じ video で captureStream() を何度も呼ぶと、前に取り込んだ方にコマが届かなくなるので、
// 取り込みは1つにして、種類ごとにトラックを複製して使う（使う種類がなくなったら取り込みも止める）
const createVideoCapture = (video: HTMLVideoElement) => {
    let capture: MediaStream | null = null
    let users = 0

    const isLive = (stream: MediaStream | null): stream is MediaStream =>
        !!stream && stream.getTracks().length > 0 && stream.getTracks().every(track => track.readyState === 'live')

    return {
        // 取り込んだ映像の複製を返す。使い終わったら release を呼ぶ
        acquire(): { stream: MediaStream, release: () => void } {
            // プレイヤーが作り直されるなどして取り込みが終わっていたら、取り込み直す
            if (!isLive(capture)) {
                if (capture) stopAll(capture)
                capture = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
            }
            users++
            const stream = new MediaStream(capture.getTracks().map(track => track.clone()))
            let released = false
            return {
                stream,
                release: () => {
                    if (released) return
                    released = true
                    stopAll(stream)
                    users--
                    if (users === 0 && capture) {
                        stopAll(capture)
                        capture = null
                    }
                },
            }
        },
    }
}

type VideoCapture = ReturnType<typeof createVideoCapture>

// 動画のみ。fixedHeight を指定すると、その高さ（16:9）に描き直して一定の解像度で録る
// 指定しなければ、録り始めた時の動画の大きさのまま録る（動画の大きさが変わったら、呼び出し側で録り直す）。
// どちらの場合も、録画の途中で大きさを変えないように描き直す
// （MediaRecorder の mp4 は、録画の途中で映像の大きさが変わると、そこから先が再生できなくなる。
//   ニコ生の画質が変わってから録り直すまでの間のコマも、録り始めた時の大きさにそろえる）。
// 描き直せない環境では、そのまま録る
const createVideoSource = (capture: VideoCapture, video: HTMLVideoElement, fixedHeight: number | null): RecordingSource => {
    const { stream, release } = capture.acquire()
    const [track] = stream.getVideoTracks()
    if (track && isFramePipelineSupported()) {
        const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
        const { width, height } = fixedHeight || !video.videoWidth || !video.videoHeight
            ? getOutputSize(fixedHeight ?? 720, null)
            : { width: even(video.videoWidth), height: even(video.videoHeight) }
        const pipeline = createFramePipeline(track, width, height, (ctx, frame) => drawContain(ctx, frame, width, height))
        return {
            stream: new MediaStream([pipeline.track, ...stream.getAudioTracks()]),
            fixedSize: fixedHeight !== null,
            stop: () => {
                pipeline.stop()
                release()
            },
        }
    }
    return { stream, fixedSize: false, stop: release }
}

// コメント付き。この環境でコメントを合成できない場合は null
const createCommentSource = (capture: VideoCapture, video: HTMLVideoElement, fixedHeight: number | null): RecordingSource | null => {
    const { stream, release } = capture.acquire()
    const compositor = createCommentCompositor(video, stream, fixedHeight ?? undefined)
    if (!compositor) {
        release()
        return null
    }
    return {
        stream: compositor.stream,
        fixedSize: fixedHeight !== null,
        stop: () => {
            compositor.stop()
            release()
        },
    }
}

export { createVideoCapture, createVideoSource, createCommentSource }
export type { RecordingSource, VideoCapture }
