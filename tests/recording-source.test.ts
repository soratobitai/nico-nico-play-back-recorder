// 録画する映像の作り方（動画の取り込みを種類ごとに共有する）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVideoCapture, createVideoSource, createCommentSource } from '@/utils/recording-source'

class FakeTrack {
    readyState: 'live' | 'ended' = 'live'
    constructor(public kind: 'video' | 'audio') {}
    stop() { this.readyState = 'ended' }
    clone() { return new FakeTrack(this.kind) }
}

class FakeStream {
    constructor(private tracks: FakeTrack[] = []) {}
    getTracks() { return this.tracks }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
}

const captured: FakeStream[] = []
const captureStream = vi.fn(() => {
    const stream = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')])
    captured.push(stream)
    return stream
})
const video = { captureStream } as unknown as HTMLVideoElement

const allEnded = (stream: { getTracks: () => FakeTrack[] }) => stream.getTracks().every(t => t.readyState === 'ended')

beforeEach(() => {
    captured.length = 0
    vi.mocked(captureStream).mockClear()
    vi.stubGlobal('MediaStream', FakeStream)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('createVideoCapture', () => {
    it('動画の取り込みは1回だけにして、種類ごとに複製したトラックを渡す', () => {
        const capture = createVideoCapture(video)

        const a = capture.acquire()
        const b = capture.acquire()

        expect(captureStream).toHaveBeenCalledTimes(1)
        expect(a.stream.getTracks()).toHaveLength(2)
        expect(a.stream.getTracks()[0]).not.toBe(b.stream.getTracks()[0])
        expect(a.stream.getTracks()[0]).not.toBe(captured[0].getTracks()[0])
    })

    it('使う種類がなくなったら取り込みを止め、また使う時に取り込み直す', () => {
        const capture = createVideoCapture(video)
        const a = capture.acquire()
        const b = capture.acquire()

        a.release()
        expect(allEnded(a.stream as unknown as FakeStream)).toBe(true)
        expect(allEnded(captured[0])).toBe(false) // まだ b が使っている

        b.release()
        b.release() // 2回呼んでも数え間違えない
        expect(allEnded(captured[0])).toBe(true)

        capture.acquire()
        expect(captureStream).toHaveBeenCalledTimes(2)
    })

    it('取り込みが終わっていたら（プレイヤーが作り直された など）、取り込み直す', () => {
        const capture = createVideoCapture(video)
        capture.acquire()
        captured[0].getVideoTracks()[0].stop()

        capture.acquire()

        expect(captureStream).toHaveBeenCalledTimes(2)
    })
})

describe('種類ごとの映像', () => {
    it('動画のみ: 描き直せない環境では、一定の解像度の設定でもそのまま録る', () => {
        const capture = createVideoCapture(video)

        const source = createVideoSource(capture, video, 720)

        expect(source.fixedSize).toBe(false)
        source.stop()
        expect(allEnded(captured[0])).toBe(true)
    })

    it('コメント付き: 合成できない環境では null にして、取り込みを残さない', () => {
        const capture = createVideoCapture(video)

        expect(createCommentSource(capture, video, null)).toBeNull()
        expect(allEnded(captured[0])).toBe(true)
    })
})
