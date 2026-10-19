// 録画したデータを保存先へ書き込む（createSegmentWriter）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createSegmentWriter } from '@/utils/recording'
import { removeSegmentItems } from '@/utils/ui'
import * as library from '@/utils/library/api'
import type { NewFragment, NewSegment } from '@/utils/library/db'
import { subscribeLiveFeed, type LiveFeedEvent } from '@/utils/review/live-feed'

vi.mock('@/utils/ui', () => ({
    removeSegmentItems: vi.fn(),
    setRecordingStatus: vi.fn(),
    getTimeString: () => '00:00',
}))
vi.mock('@/services/api', () => ({ checkLiveStatus: vi.fn(async () => 'ON_AIR') }))
vi.mock('@/utils/library/api', () => ({
    createSegment: vi.fn(async () => {}),
    setSegmentInit: vi.fn(async () => {}),
    appendFragments: vi.fn(async () => {}),
    finishSegment: vi.fn(async () => null),
    freeSpace: vi.fn(async () => ({ freed: 0, deletedSegmentIds: [] })),
}))

const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))

const segment = (format: NewSegment['format'], mimeType: string): NewSegment => ({
    segmentId: 'S', programId: 'lv1', kind: 'video', format, mimeType, title: 'title', userName: 'user',
    startedAt: 1_000_000, thumbnail: null,
})
const appended = () => vi.mocked(library.appendFragments).mock.calls.flatMap(([, fragments]) => fragments as NewFragment[])
const quotaExceeded = () => new DOMException('quota', 'QuotaExceededError')

beforeEach(() => {
    vi.clearAllMocks()
})

describe('mp4 の書き込み', () => {
    // MediaRecorder と同じく、最初は ftyp だけ、あとは好きな大きさで届く
    const writeFixture = async (writer: ReturnType<typeof createSegmentWriter>) => {
        const sizes = [36, 7000, 3333, 25000]
        for (let p = 0, i = 0; p < fixture.length; p += sizes[i++ % sizes.length]) {
            await writer.write(new Blob([fixture.subarray(p, p + sizes[i % sizes.length])]))
        }
    }

    it('初期化セグメントを1回だけ保存し、断片に通し番号と録画開始からの時刻を付けて保存する', async () => {
        const writer = createSegmentWriter(segment('fmp4', 'video/mp4'))
        await writer.start()
        await writeFixture(writer)

        expect(library.setSegmentInit).toHaveBeenCalledTimes(1)
        const init = vi.mocked(library.setSegmentInit).mock.calls[0][1] as Blob
        const fragments = appended()
        expect(fragments.map(f => f.index)).toEqual(fragments.map((_, i) => i))
        for (const f of fragments) expect(f.wallClock).toBe(1_000_000 + f.startTime * 1000)
        // 初期化セグメントと断片で、届いたデータを過不足なく保存している
        expect(init.size + fragments.reduce((sum, f) => sum + f.blob.size, 0)).toBe(fixture.length)
    })

    it('保存したら、見直しのウィンドウへ初期化セグメントと断片を知らせる', async () => {
        const events: LiveFeedEvent[] = []
        const unsubscribe = subscribeLiveFeed(event => events.push(event))
        const writer = createSegmentWriter(segment('fmp4', 'video/mp4'))

        await writeFixture(writer)
        await writer.finish(2_000_000)
        unsubscribe()

        expect(events.filter(e => e.type === 'init')).toHaveLength(1)
        const fragments = events.flatMap(e => e.type === 'fragments' ? e.fragments : [])
        expect(fragments.map(f => f.index)).toEqual(appended().map(f => f.index))
        expect(fragments.every(f => f.keyframe)).toBe(true)
        expect(events[events.length - 1]).toEqual({ type: 'finish', segmentId: 'S', endedAt: 2_000_000 })
    })

    it('保存できなかった断片は知らせない', async () => {
        vi.mocked(library.appendFragments).mockRejectedValueOnce(new Error('failed'))
        const events: LiveFeedEvent[] = []
        const unsubscribe = subscribeLiveFeed(event => events.push(event))
        const writer = createSegmentWriter(segment('fmp4', 'video/mp4'))

        await expect(writeFixture(writer)).rejects.toThrow('failed')
        unsubscribe()

        expect(events.filter(e => e.type === 'fragments')).toHaveLength(0)
    })

    it('容量不足なら古い録画を消し、一覧からも外してから同じ断片をもう一度保存する', async () => {
        vi.mocked(library.appendFragments).mockRejectedValueOnce(quotaExceeded())
        vi.mocked(library.freeSpace).mockResolvedValueOnce({ freed: 500, deletedSegmentIds: ['old'] })
        const writer = createSegmentWriter(segment('fmp4', 'video/mp4'))

        await writeFixture(writer)

        const calls = vi.mocked(library.appendFragments).mock.calls
        expect(calls[1]).toEqual(calls[0])
        expect(removeSegmentItems).toHaveBeenCalledWith(['old'])
    })

    it('容量不足で消せる録画もなければ、エラーにする', async () => {
        vi.mocked(library.appendFragments).mockRejectedValueOnce(quotaExceeded())
        const writer = createSegmentWriter(segment('fmp4', 'video/mp4'))

        await expect(writeFixture(writer)).rejects.toThrow('quota')
    })
})

describe('webm などの書き込み', () => {
    it('届いたデータをそのまま1つずつ、通し番号を付けて保存する', async () => {
        const writer = createSegmentWriter(segment('opaque', 'video/webm'))
        const chunks = [new Blob(['a']), new Blob(['b']), new Blob(['c'])]

        for (const chunk of chunks) await writer.write(chunk)

        expect(library.setSegmentInit).not.toHaveBeenCalled()
        expect(appended().map(f => [f.index, f.blob])).toEqual(chunks.map((chunk, i) => [i, chunk]))
    })
})
