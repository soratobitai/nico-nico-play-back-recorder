// @vitest-environment happy-dom
// 録画を見る画面: 再生できない所（壊れた録画）に当たったら、その区間の残りを飛ばして続ける
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountReviewView } from '@/utils/review/view'
import { createReviewPlayer } from '@/utils/review/player'
import type { Timeline } from '@/utils/review/timeline'
import type { TimelineFragment, TimelineSegment } from '@/utils/library/db'

// MediaSource を使う再生の代わり（作られた時の時間軸と、移った位置を覚える）
type FakePlayer = { timeline: Timeline, position: number, seek: ReturnType<typeof vi.fn>, destroy: ReturnType<typeof vi.fn> }
const players: FakePlayer[] = []
vi.mock('@/utils/review/player', () => ({
    createReviewPlayer: vi.fn(({ timeline }: { timeline: Timeline }) => {
        const player: FakePlayer & { update: () => void, cacheFragment: () => void } = {
            timeline,
            position: 0,
            seek: vi.fn((t: number) => { player.position = t }),
            destroy: vi.fn(),
            update: () => {},
            cacheFragment: () => {},
        }
        players.push(player)
        return player
    }),
}))

const fragments = (count: number): TimelineFragment[] =>
    Array.from({ length: count }, (_, i) => ({ index: i, startTime: i * 3, duration: 3, keyframe: true }))
const segment = (segmentId: string, startedAt: number, count: number): TimelineSegment => ({
    segmentId, kind: 'video', mimeType: 'video/mp4', startedAt, endedAt: startedAt + count * 3000, init: new Blob(['init']), fragments: fragments(count),
})
// A: 0〜9秒（3断片）、B: 9.5〜15.5秒（2断片）
const recordings = () => [segment('A', 100_000, 3), segment('B', 109_500, 2)]

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const current = () => players[players.length - 1]
const decodeError = (root: HTMLElement) => {
    const video = root.querySelector('video')!
    Object.defineProperty(video, 'error', { value: { code: 3 }, configurable: true })
    video.dispatchEvent(new Event('error'))
}
const keys = (timeline: Timeline) => timeline.fragments.map(f => `${f.segmentId}${f.index}`)

beforeEach(() => {
    players.length = 0
    vi.mocked(createReviewPlayer).mockClear()
    document.body.innerHTML = '<div id="root"></div>'
})

describe('再生できない所を飛ばす', () => {
    it('壊れた所から区間の終わりまでを外し、再生し直して次の再生できる所へ進む', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const first = current()
        first.position = 4 // A の2つ目の断片（3〜6秒）を再生中に壊れていた

        decodeError(root)

        expect(first.destroy).toHaveBeenCalled()
        const second = current()
        expect(second).not.toBe(first)
        expect(keys(second.timeline)).toEqual(['A0', 'B0', 'B1'])
        expect(second.seek).toHaveBeenLastCalledWith(3) // 外した所（録っていない間と同じ扱い）から次へ進む

        // 保存先から読み直しても、外した所は戻さない
        await view.refresh()
        expect(keys(current().timeline)).toEqual(['A0', 'B0', 'B1'])
        view.destroy()
    })

    it('何度も続く場合は飛ばし続けず、再生できなかったことを知らせる', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({
            root, mode: 'library', readFragments: async () => [],
            readTimeline: async () => Array.from({ length: 8 }, (_, i) => segment(`S${i}`, 100_000 + i * 10_000, 3)),
        })
        await flush()

        for (let i = 0; i < 5; i++) {
            current().position = i * 10 + 1
            decodeError(root)
        }
        expect(root.querySelector<HTMLElement>('.message')!.hidden).toBe(true)
        expect(createReviewPlayer).toHaveBeenCalledTimes(6)

        current().position = 51
        decodeError(root)
        expect(createReviewPlayer).toHaveBeenCalledTimes(6)
        expect(root.querySelector('.message')!.textContent).toContain('再生できませんでした')
        view.destroy()
    })
})
