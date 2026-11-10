// 種類ごとに、録画する映像（と音声）を作る
// - コメントなし: 動画をそのまま。一定の解像度で録る場合は、決まった大きさに描き直す
// - コメントあり: 動画に流れるコメントを重ねたもの（comment-compositor）
// - 画面録画: プレイヤーの表示部分を画面ごと（screen-capture。ユーザーの操作から始める必要があるので、ここでは作らない）
import { createFramePipeline, drawContain, getOutputSize, isFramePipelineSupported } from './frame-pipeline'
import { createCommentCompositor } from './comment-compositor'
import { watchAudio, diagEvent } from './diagnostics'

type RecordingSource = {
    // 録画に渡す映像と音声（録り始めるたびに読む。音声は、その時に使える方。下の createContinuousAudio）
    stream: MediaStream
    // 動画の解像度が変わっても、録画の解像度が変わらない（録り直さなくてよい）
    fixedSize: boolean
    // 録画の途中で映像の大きさが変わらない（描き直している）。録り直す場合も、録り直すまで録り続けられる
    steadySize: boolean
    stop: () => void
}

// 録画の音声を、再生が止まっている間も途切れない音声にする（止まっている間は無音になる）
// ニコ生のプレイヤーが読み込み待ちで止まっている間は、取り込んだ映像には止まったコマが届き続けるが、音声は届かない。
// Chrome の録画（MediaRecorder）は、取り込んだ音声を、届かなかった間を空けずにつないでいくので、そのまま録ると、
// 止まるたびに音声だけが短くなり、その区間の終わりまで、止まっていた時間だけ音が映像より先に出る
// （録り始めた時に止まっていた場合も、音声が後から始まるのに映像と同じ 0 秒にそろえられるので、同じく音が先に出る）。
// Web Audio に通すと、元の音声が届かない間も、実際の時間に合わせて無音が続く音声になるので、映像とずれない。
// Web Audio が動いていない時（ページで操作する前で、ブラウザの自動再生の決まりで止められた など）は、元の音声をそのまま録る
// （音声のない録画にしないように）。ページを操作したら動かし始める。録り始めるたびに（区切って録り直す時も）どちらを使うか決める
const createContinuousAudio = (audioTrack: MediaStreamTrack | undefined) => {
    if (!audioTrack || typeof AudioContext === 'undefined') return { track: () => audioTrack, stop: () => {} }
    let context: AudioContext | null = null
    let output: MediaStreamTrack | undefined
    try {
        context = new AudioContext()
        const input = context.createMediaStreamSource(new MediaStream([audioTrack]))
        const destination = context.createMediaStreamDestination()
        input.connect(destination)
        output = destination.stream.getAudioTracks()[0]
        if (context.state !== 'running') {
            context.resume().catch(() => {})
            // 自動再生の決まりで止められた時は、ページを操作した時に動かし始める
            const resume = () => {
                if (context?.state === 'suspended') context.resume().catch(() => {})
            }
            for (const type of ['pointerdown', 'keydown']) globalThis.addEventListener?.(type, resume, { capture: true, once: true })
        }
    } catch (error) {
        console.log('録画の音声を Web Audio に通せませんでした（元の音声をそのまま録ります）:', error)
        context = null
    }
    return {
        // 録り始める時に使う音声
        track: () => {
            const continuous = context?.state === 'running' && output?.readyState === 'live'
            diagEvent('audio:track', { webAudio: continuous, state: context?.state ?? 'none' }) // 診断版だけ
            return continuous ? output : audioTrack
        },
        stop: () => {
            output?.stop()
            context?.close().catch(() => {})
        },
    }
}

// 映像のトラックと音声のトラックを、録画に渡す1つの MediaStream にする
const withAudio = (videoTrack: MediaStreamTrack, audioTrack: MediaStreamTrack | undefined) =>
    new MediaStream(audioTrack ? [videoTrack, audioTrack] : [videoTrack])

const stopAll = (stream: MediaStream) => stream.getTracks().forEach(track => track.stop())

// 動画の取り込み
// 同じ video で captureStream() を何度も呼ぶと、前に取り込んだ方にコマが届かなくなるので、
// 取り込みは1つにして、種類ごとにトラックを複製して使う。
// 取り込みは止めずに使い続ける（止めてすぐ取り込み直した録画が、データを出さないことがあった）。
// 動画が読み込み直されると（プレイヤーの再読み込みなど）、取り込みには新しいトラックが加わり、
// 前のトラックはコマが届かないまま live で残る。種類ごとの複製は、最後に加わったトラックから作る。
// （取り込み直してから前の取り込みを止めると、新しい取り込みの音声まで止まり、録画がデータを出さなくなる）
const createVideoCapture = (video: HTMLVideoElement) => {
    let capture: MediaStream | null = null

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
            watchAudio(capture.getAudioTracks().at(-1)) // 診断版だけ
            const tracks = [capture.getVideoTracks().at(-1), capture.getAudioTracks().at(-1)]
                .filter((track): track is MediaStreamTrack => !!track)
            const stream = new MediaStream(tracks.map(track => track.clone()))
            return { stream, release: () => stopAll(stream) }
        },
    }
}

type VideoCapture = ReturnType<typeof createVideoCapture>

// コメントなし。fixedHeight を指定すると、その高さ（16:9）に描き直して一定の解像度で録る
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
        const audio = createContinuousAudio(stream.getAudioTracks()[0])
        const pipeline = createFramePipeline(track, width, height, (ctx, frame) => drawContain(ctx, frame, width, height))
        return {
            get stream() {
                return withAudio(pipeline.track, audio.track())
            },
            fixedSize: fixedHeight !== null,
            steadySize: true,
            stop: () => {
                pipeline.stop()
                audio.stop()
                release()
            },
        }
    }
    return { stream, fixedSize: false, steadySize: false, stop: release }
}

// コメントあり。この環境でコメントを合成できない場合は null
const createCommentSource = (capture: VideoCapture, video: HTMLVideoElement, fixedHeight: number | null): RecordingSource | null => {
    const { stream, release } = capture.acquire()
    const compositor = createCommentCompositor(video, stream, fixedHeight ?? undefined)
    if (!compositor) {
        release()
        return null
    }
    const audio = createContinuousAudio(stream.getAudioTracks()[0])
    const [videoTrack] = compositor.stream.getVideoTracks()
    return {
        get stream() {
            return withAudio(videoTrack, audio.track())
        },
        fixedSize: fixedHeight !== null,
        steadySize: true, // 合成する大きさは、作った時に決める
        stop: () => {
            compositor.stop()
            audio.stop()
            release()
        },
    }
}

export { createVideoCapture, createVideoSource, createCommentSource, createContinuousAudio }
export type { RecordingSource, VideoCapture }
