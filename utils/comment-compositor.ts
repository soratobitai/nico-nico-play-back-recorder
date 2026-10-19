// 流れるコメントを含めて録画するための映像を作る
// ニコ生のプレイヤーはコメントを canvas（表示サイズに関係なく 1366x768）に描いているので、
// 動画のコマが届くたびに「動画 → コメントの canvas」の順に描き重ねる。
import { isFramePipelineSupported, getOutputSize, drawContain, createFramePipeline } from './frame-pipeline'

// コメントの層の canvas
const COMMENT_CANVAS_SELECTOR = '[class*="___comment-layer___"] canvas'

type CommentCompositor = {
    stream: MediaStream // 合成した映像と、動画の音声
    stop: () => void
}

// 動画（source。video を取り込んだもの）にコメントを合成した映像を作る。この環境で使えない場合は null を返す
// fixedHeight を指定すると、動画の解像度によらずその高さで作る（一定の解像度で録る場合）
// source のトラックは呼び出し側で止める
const createCommentCompositor = (video: HTMLVideoElement, source: MediaStream, fixedHeight?: number): CommentCompositor | null => {
    if (!isFramePipelineSupported()) {
        console.log('この環境ではコメントを合成できません')
        return null
    }

    const [sourceVideoTrack] = source.getVideoTracks()
    if (!sourceVideoTrack) return null

    // 縦横比はコメントの canvas（＝プレイヤーの表示領域）に合わせる
    let commentCanvas = document.querySelector<HTMLCanvasElement>(COMMENT_CANVAS_SELECTOR)
    const { width, height } = getOutputSize(fixedHeight ?? video.videoHeight, commentCanvas)

    const pipeline = createFramePipeline(sourceVideoTrack, width, height, (ctx, frame) => {
        drawContain(ctx, frame, width, height)

        // プレイヤーが作り直された場合に備えて、外れていたら探し直す
        if (!commentCanvas?.isConnected) {
            commentCanvas = document.querySelector<HTMLCanvasElement>(COMMENT_CANVAS_SELECTOR)
        }
        // タブが裏にある間はページがコメントの描画を止めるので、止まったコメントを重ねない
        // プレイヤーでコメントを非表示にしている間も重ねない
        if (commentCanvas && !document.hidden && commentCanvas.checkVisibility()) {
            ctx.drawImage(commentCanvas, 0, 0, width, height)
        }
    })

    return {
        stream: new MediaStream([pipeline.track, ...source.getAudioTracks()]),
        stop: () => pipeline.stop(),
    }
}

export { createCommentCompositor }
export type { CommentCompositor }
