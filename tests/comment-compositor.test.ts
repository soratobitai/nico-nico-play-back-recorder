import { describe, expect, it } from 'vitest'
import { createCommentCompositor } from '@/utils/comment-compositor'
import { getOutputSize } from '@/utils/frame-pipeline'

describe('getOutputSize（コメントを合成した映像の大きさ）', () => {
    it('縦は動画に合わせ、縦横比はコメントの canvas（1366x768）に合わせる', () => {
        expect(getOutputSize(720, { width: 1366, height: 768 })).toEqual({ width: 1280, height: 720 })
        expect(getOutputSize(1080, { width: 1366, height: 768 })).toEqual({ width: 1920, height: 1080 })
    })

    it('4:3 の動画でも、プレイヤーの表示領域と同じ横長の映像にする（動画の左右は黒帯）', () => {
        expect(getOutputSize(480, { width: 1366, height: 768 })).toEqual({ width: 854, height: 480 })
    })

    it('幅・高さは偶数にする（H.264 の制約）', () => {
        const { width, height } = getOutputSize(451, { width: 1366, height: 768 })
        expect(width % 2).toBe(0)
        expect(height % 2).toBe(0)
    })

    it('コメントの canvas が見つからない・動画の大きさが分からない場合は 16:9 の 720p にする', () => {
        expect(getOutputSize(0, null)).toEqual({ width: 1280, height: 720 })
    })
})

describe('createCommentCompositor', () => {
    it('コメントを合成するための API がない環境では null を返す（呼び出し側でコメント付きの録画をしない）', () => {
        // Node には MediaStreamTrackProcessor / MediaStreamTrackGenerator がない
        expect(createCommentCompositor({} as HTMLVideoElement, {} as MediaStream)).toBeNull()
    })
})
