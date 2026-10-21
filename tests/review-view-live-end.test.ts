// @vitest-environment happy-dom
// プレイバックのウィンドウ（live）: 録り終えた録画の終わりで止める・続きが届いたら続ける・録画が全部消された後
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountReviewView } from '@/utils/review/view'
import type { Timeline } from '@/utils/review/timeline'
import type { TimelineFragment, TimelineSegment } from '@/utils/library/db'
import type { LiveFeedEvent } from '@/utils/review/live-feed'

type FakePlayer = { timeline: Timeline, position: number, seek: ReturnType<typeof vi.fn>, destroy: ReturnType<typeof vi.fn> }
const players: FakePlayer[] = []
vi.mock('@/utils/review/player', () => ({
    createReviewPlayer: vi.fn(({ timeline }: { timeline: Timeline }) => {
        const player: FakePlayer & { update: () => void, cacheFragment: () => void } = {
            timeline, position: 0,
            seek: vi.fn((t: number) => { player.position = Math.min(Math.max(t, timeline.start), timeline.end) }),
            destroy: vi.fn(), update: () => {}, cacheFragment: () => {},
        }
        players.push(player)
        return player
    }),
}))

const fragments = (count: number, firstIndex = 0): TimelineFragment[] =>
    Array.from({ length: count }, (_, i) => ({ index: firstIndex + i, startTime: (firstIndex + i) * 3, duration: 3, keyframe: true }))
const segment = (segmentId: string, kind: 'video' | 'comments', startedAt: number, count: number, endedAt: number | null): TimelineSegment => ({
    segmentId, kind, mimeType: 'video/mp4', startedAt, endedAt, init: new Blob(['init']), fragments: fragments(count),
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const current = () => players[players.length - 1]

// video の再生・一時停止の代わり
const fakeVideo = (video: HTMLVideoElement) => {
    let paused = true
    Object.defineProperty(video, 'paused', { get: () => paused, configurable: true })
    Object.defineProperty(video, 'ended', { get: () => false, configurable: true })
    const play = vi.fn(async () => { if (paused) { paused = false; video.dispatchEvent(new Event('play')) } })
    video.play = play as unknown as HTMLVideoElement['play']
    video.pause = () => { if (!paused) { paused = true; video.dispatchEvent(new Event('pause')) } }
    return { play, get paused() { return paused } }
}

let now = 1_000_000
beforeEach(() => {
    players.length = 0
    now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    document.body.innerHTML = '<div id="root"></div>'
})

// 録り終えた録画（60秒）を、最後まで（behind: 終わりのこれだけ手前まで）見て止まるまで
const watchToEnd = async (stored: () => TimelineSegment[], subscribe?: (l: (event: LiveFeedEvent) => void) => () => void, behind = 0) => {
    const root = document.getElementById('root')!
    const view = mountReviewView({ root, mode: 'live', programId: 'lv1', readTimeline: async () => stored(), readFragments: async () => [], subscribe })
    const video = root.querySelector('video')!
    const v = fakeVideo(video)
    await flush()
    await flush()
    current().position = current().timeline.end - behind
    video.dispatchEvent(new Event('timeupdate'))
    now += 11_000
    video.dispatchEvent(new Event('timeupdate'))
    return { root, view, video, v }
}

describe('録り終えた録画の終わり', () => {
    it('最後まで見て続きが届かなければ止め、止めたまま戻した時は、読み直しても勝手に再生しない', async () => {
        const { root, view, v } = await watchToEnd(() => [segment('A', 'video', 900_000, 20, 960_000)])
        expect(v.paused).toBe(true)

        root.querySelector<HTMLButtonElement>('.back')!.click()
        v.play.mockClear()
        now += 30_000
        await view.refresh()
        expect(v.play).not.toHaveBeenCalled()
        view.destroy()
    })

    it('Chrome が読み込んだ範囲の終わりより少し前で止まっても、最後まで見たとして止める', async () => {
        const { view, v } = await watchToEnd(() => [segment('A', 'video', 900_000, 20, 960_000)], undefined, 0.5)
        expect(v.paused).toBe(true)
        view.destroy()
    })

    it('止まった後に続きが届いたら（録画を始め直した）、続けて再生する', async () => {
        const listeners: ((event: LiveFeedEvent) => void)[] = []
        const { view, v } = await watchToEnd(() => [segment('A', 'video', 900_000, 20, 960_000)], (l) => { listeners.push(l); return () => {} })
        expect(v.paused).toBe(true)

        const seg = { segmentId: 'B', programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', startedAt: 960_500, title: '', userName: '', thumbnail: null }
        for (const l of listeners) l({ type: 'init', segment: seg as never, init: new Blob(['init']) })
        for (const l of listeners) l({ type: 'fragments', segmentId: 'B', fragments: [0, 1].map(i => ({ index: i, blob: new Blob(['x']), moofSize: 0, startTime: i * 3, duration: 3, wallClock: 960_500 + i * 3000, keyframe: true })) })
        expect(v.paused).toBe(false)
        view.destroy()
    })
})

describe('録画が全部消された後', () => {
    it.each(['video', 'comments'] as const)('新しく録画（%s）が届いたら、そこから見始める', async (newKind) => {
        const root = document.getElementById('root')!
        const listeners: ((event: LiveFeedEvent) => void)[] = []
        let stored: TimelineSegment[] = [segment('A', 'video', 900_000, 10, 930_000)]
        const onChange = vi.fn()
        const view = mountReviewView({
            root, mode: 'live', programId: 'lv1', readTimeline: async () => stored, readFragments: async () => [], onChange,
            subscribe: (l) => { listeners.push(l); return () => {} },
        })
        fakeVideo(root.querySelector('video')!)
        await flush()
        await flush()

        // 「すべて消す」
        stored = []
        await view.refresh()
        const message = root.querySelector<HTMLElement>('.message')!
        expect(message.hidden).toBe(false)

        // 録画を始め直した
        const seg = { segmentId: 'N', programId: 'lv1', kind: newKind, format: 'fmp4', mimeType: 'video/mp4', startedAt: 1_000_000, title: '', userName: '', thumbnail: null }
        for (const l of listeners) l({ type: 'init', segment: seg as never, init: new Blob(['init']) })
        for (const l of listeners) l({ type: 'fragments', segmentId: 'N', fragments: [0, 1, 2].map(i => ({ index: i, blob: new Blob(['x']), moofSize: 0, startTime: i * 3, duration: 3, wallClock: 1_000_000 + i * 3000, keyframe: true })) })

        expect(message.hidden).toBe(true)
        expect(onChange.mock.lastCall![0].kind).toBe(newKind)
        expect(root.querySelector<HTMLButtonElement>('.play')!.disabled).toBe(false)
        view.destroy()
    })
})
