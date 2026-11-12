// @vitest-environment happy-dom
// プレイヤーの再生が落ち着いているか（止まらずに続けて再生してから録画を始める）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchPlaybackStability, STABLE_PLAYBACK_MS } from '@/utils/playback-stability'

// 再生中の video の代わり（進める時は advance を呼ぶ）
class FakeVideo extends EventTarget {
    paused = false
    readyState = 4
    currentTime = 10
}

const play = (video: FakeVideo, ms: number) => {
    for (let t = 0; t < ms; t += 100) {
        video.currentTime += 0.1
        vi.advanceTimersByTime(100)
    }
}

beforeEach(() => {
    vi.useFakeTimers()
})
afterEach(() => {
    vi.useRealTimers()
})

describe('watchPlaybackStability', () => {
    it('見始めてから、止まらずに続けて再生したら落ち着いたとする', () => {
        const video = new FakeVideo()
        const stability = watchPlaybackStability(video as unknown as HTMLVideoElement)

        expect(stability.isStable()).toBe(false)
        play(video, STABLE_PLAYBACK_MS)
        expect(stability.isStable()).toBe(true)
    })

    it('読み込み待ちになったら、そこからまた続けて再生するまで落ち着いていない', () => {
        const video = new FakeVideo()
        const stability = watchPlaybackStability(video as unknown as HTMLVideoElement)
        play(video, STABLE_PLAYBACK_MS)

        video.dispatchEvent(new Event('waiting'))
        expect(stability.isStable()).toBe(false)
        play(video, STABLE_PLAYBACK_MS - 1000)
        expect(stability.isStable()).toBe(false)
        play(video, 1000)
        expect(stability.isStable()).toBe(true)
    })

    it('出来事がなくても、再生が進んでいなければ落ち着いていない', () => {
        const video = new FakeVideo()
        const stability = watchPlaybackStability(video as unknown as HTMLVideoElement)
        // 再生位置が進まないまま
        vi.advanceTimersByTime(STABLE_PLAYBACK_MS * 2)
        expect(stability.isStable()).toBe(false)
    })

    it('落ち着くまで待ち、待ちすぎたら待つのをやめる。取り消されたら false', async () => {
        const video = new FakeVideo()
        const stability = watchPlaybackStability(video as unknown as HTMLVideoElement)

        const settled = stability.waitUntilStable(30 * 1000, () => false)
        play(video, STABLE_PLAYBACK_MS + 500)
        await expect(settled).resolves.toBe(true)

        // ずっと止まっていても、上限まで待ったら進める
        video.paused = true
        video.dispatchEvent(new Event('pause'))
        const timedOut = stability.waitUntilStable(3000, () => false)
        vi.advanceTimersByTime(3500)
        await expect(timedOut).resolves.toBe(true)

        let cancelled = false
        const waiting = stability.waitUntilStable(30 * 1000, () => cancelled)
        cancelled = true
        vi.advanceTimersByTime(1000)
        await expect(waiting).resolves.toBe(false)
    })
})
