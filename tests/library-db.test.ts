import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
    createSegment, setSegmentInit, appendFragments, finishSegment, listAllSegments, buildDownloadFiles,
    deleteSegments, clearAll, getUsage, freeSpace, enforceLimit, closeStaleSegments, getTimeline, getFragmentBlobs,
    type NewSegment, type NewFragment,
} from '@/utils/library/db'
import { splitFmp4Blob } from '@/utils/fmp4'

const fixture = new Blob([new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))], { type: 'video/mp4' })

const segment = (segmentId: string, startedAt: number, overrides: Partial<NewSegment> = {}): NewSegment => ({
    segmentId, programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', title: 'title', userName: 'user',
    startedAt, thumbnail: null, ...overrides,
})

// size バイトの断片（中身は使わないテスト用）
const fragment = (index: number, wallClock: number, size = 100): NewFragment => ({
    index, blob: new Blob([new Uint8Array(size)]), moofSize: 0, startTime: index, duration: 1, wallClock,
})

beforeEach(async () => {
    await clearAll()
})

describe('録画中の保存', () => {
    it('区間を作り、初期化セグメントと断片を足していくと、大きさ・数・長さを数える', async () => {
        await createSegment(segment('A', 1000))
        await setSegmentInit('A', new Blob([new Uint8Array(50)]))
        await appendFragments('A', [fragment(0, 1000), fragment(1, 2000)])
        await appendFragments('A', [fragment(2, 3000)])

        const [summary] = await listAllSegments()
        expect(summary).toMatchObject({ segmentId: 'A', bytes: 350, fragmentCount: 3, duration: 3, endedAt: null })
        expect(summary).not.toHaveProperty('init')
    })

    it('同じ断片を2回受け取っても数え直さない（一時保存からの移し直しなど）', async () => {
        await createSegment(segment('A', 1000))
        await appendFragments('A', [fragment(0, 1000)])
        await appendFragments('A', [fragment(0, 1000)])

        expect((await listAllSegments())[0]).toMatchObject({ bytes: 100, fragmentCount: 1 })
    })

    it('存在しない区間に断片を足そうとすると例外になる', async () => {
        await expect(appendFragments('missing', [fragment(0, 1000)])).rejects.toMatchObject({ name: 'SegmentNotFoundError' })
    })

    it('録画を終えると確定し、断片が1つもない区間は消す', async () => {
        await createSegment(segment('A', 1000))
        await appendFragments('A', [fragment(0, 1000)])
        await createSegment(segment('empty', 2000))

        expect(await finishSegment('A', 5000, 'video/mp4;codecs=avc1')).toMatchObject({ endedAt: 5000, mimeType: 'video/mp4;codecs=avc1' })
        expect(await finishSegment('empty', 5000)).toBeNull()
        expect(await listAllSegments()).toHaveLength(1)
    })
})

describe('一覧', () => {
    it('すべての区間を新しい順に返す（初期化セグメントは含めない）', async () => {
        for (const [id, at] of [['A', 1000], ['C', 3000], ['B', 2000]] as const) await createSegment(segment(id, at))

        const segments = await listAllSegments()
        expect(segments.map(s => s.segmentId)).toEqual(['C', 'B', 'A'])
        expect(segments[0]).not.toHaveProperty('init')
    })
})

describe('保存用のファイル', () => {
    it('fmp4 の区間は、初期化セグメントと断片から 0 秒始まりの1本のファイルにする', async () => {
        const { init, fragments } = await splitFmp4Blob(fixture)
        await createSegment(segment('A', 1000))
        await setSegmentInit('A', init)
        // 古い断片が消された状態（2つ目から）
        await appendFragments('A', fragments.slice(1).map((f, i) => ({ ...f, index: i + 1, wallClock: 1000 + i })))

        const [file] = await buildDownloadFiles(['A'])
        const rebuilt = await splitFmp4Blob(file.blob)
        expect(rebuilt.fragments).toHaveLength(fragments.length - 1)
        expect(rebuilt.fragments[0].startTime).toBeCloseTo(0, 3)
        expect(file.segmentIds).toEqual(['A'])
    })

    it('opaque の区間は、断片を順につなげる', async () => {
        await createSegment(segment('W', 1000, { format: 'opaque', mimeType: 'video/webm' }))
        await appendFragments('W', [
            { ...fragment(1, 2000), blob: new Blob(['b']) },
            { ...fragment(0, 1000), blob: new Blob(['a']) },
        ])

        const [file] = await buildDownloadFiles(['W'])
        expect(await file.blob.text()).toBe('ab')
        expect(file.blob.type).toBe('video/webm')
    })
})

describe('見直し用の読み出し', () => {
    it('番組の mp4 の区間を始めた順に、断片の時刻だけ返す（初期化セグメントのない区間・webm・他の番組は除く）', async () => {
        await createSegment(segment('B', 2000))
        await setSegmentInit('B', new Blob(['init']))
        await appendFragments('B', [{ ...fragment(0, 2000), keyframe: false }, fragment(1, 3000)])
        await createSegment(segment('A', 1000))
        await setSegmentInit('A', new Blob(['init']))
        await createSegment(segment('N', 3000)) // 初期化セグメントがまだ届いていない
        await createSegment(segment('W', 4000, { format: 'opaque' }))
        await createSegment(segment('O', 5000, { programId: 'lv2' }))
        await setSegmentInit('O', new Blob(['init']))

        const timeline = await getTimeline('lv1')

        expect(timeline.map(s => s.segmentId)).toEqual(['A', 'B'])
        // 以前のデータ（keyframe がない）は、どこからでも再生できるものとする
        expect(timeline[1].fragments).toEqual([
            { index: 0, startTime: 0, duration: 1, keyframe: false },
            { index: 1, startTime: 1, duration: 1, keyframe: true },
        ])
        expect(await timeline[1].init.text()).toBe('init')
    })

    it('断片のデータを読み、消された断片は null にする', async () => {
        await createSegment(segment('A', 1000))
        await appendFragments('A', [{ ...fragment(0, 1000), blob: new Blob(['a']) }, { ...fragment(2, 3000), blob: new Blob(['c']) }])

        const blobs = await getFragmentBlobs('A', [0, 1, 2])

        expect(await Promise.all(blobs.map(b => b?.text() ?? null))).toEqual(['a', null, 'c'])
    })
})

describe('削除と容量', () => {
    beforeEach(async () => {
        // 古い順に A（終了済み・3断片）、B（終了済み・webm）、C（録画中・2断片）
        await createSegment(segment('A', 1000))
        await appendFragments('A', [fragment(0, 1000), fragment(1, 2000), fragment(2, 3000)])
        await finishSegment('A', 4000)
        await createSegment(segment('B', 5000, { format: 'opaque', kind: 'comments' }))
        await appendFragments('B', [fragment(0, 5000), fragment(1, 6000)])
        await finishSegment('B', 7000)
        await createSegment(segment('C', 8000, { kind: 'screen' }))
        await appendFragments('C', [fragment(0, 8000), fragment(1, 9000)])
    })

    it('使用量を種類ごとに数える', async () => {
        expect(await getUsage()).toEqual({ bytes: 700, segments: 3, bytesByKind: { video: 300, comments: 200, screen: 200 } })
    })

    it('古い断片から消し、断片がなくなった区間は消す', async () => {
        const result = await freeSpace(250)

        expect(result).toEqual({ freed: 300, deletedSegmentIds: ['A'] })
        expect((await listAllSegments()).map(s => s.segmentId)).toEqual(['C', 'B'])
    })

    it('途中から再生できない webm の区間は、区間ごと消す', async () => {
        const result = await freeSpace(350)

        expect(result.deletedSegmentIds).toEqual(['A', 'B'])
        expect(result.freed).toBe(500)
    })

    it('録画中の区間は、断片を全部消しても区間は残す（続きが届くので）', async () => {
        await freeSpace(10_000)

        const remaining = await listAllSegments()
        expect(remaining.map(s => s.segmentId)).toEqual(['C'])
        expect(remaining[0]).toMatchObject({ fragmentCount: 0, bytes: 0 })
    })

    it('録画中の webm の区間は、書き込み中なので消さない', async () => {
        await createSegment(segment('D', 500, { format: 'opaque' }))
        await appendFragments('D', [fragment(0, 500)]) // A より古い断片

        await freeSpace(10_000)

        expect((await listAllSegments()).find(s => s.segmentId === 'D')?.fragmentCount).toBe(1)
    })

    it('上限を超えた分だけ消す（超えていなければ何もしない）', async () => {
        expect(await enforceLimit(1000)).toEqual({ freed: 0, deletedSegmentIds: [] })
        // 700 → 500 なので、古い断片を 200 バイト分だけ消す（A は断片が1つ残る）
        expect(await enforceLimit(500)).toEqual({ freed: 200, deletedSegmentIds: [] })
        expect((await getUsage()).bytes).toBe(500)
        expect((await listAllSegments()).find(s => s.segmentId === 'A')?.fragmentCount).toBe(1)
    })

    it('区間を指定して消すと、断片も消える', async () => {
        await deleteSegments(['A', 'C'])

        expect((await listAllSegments()).map(s => s.segmentId)).toEqual(['B'])
        expect((await getUsage()).bytes).toBe(200)
        expect(await buildDownloadFiles(['A'])).toEqual([])
    })
})

describe('終えられないまま残った区間', () => {
    // 録画中の C は 8000 に始まり、2秒分の断片がある（最後の書き込みは 10000）
    beforeEach(async () => {
        await createSegment(segment('C', 8000))
        await appendFragments('C', [fragment(0, 8000), fragment(1, 9000)])
    })

    it('最後の書き込みから idleMs 以上たったら、最後の書き込みの時刻で確定する', async () => {
        await closeStaleSegments(60_000, 10_000 + 59_999)
        expect((await listAllSegments())[0].endedAt).toBeNull()

        await closeStaleSegments(60_000, 10_000 + 60_000)
        expect((await listAllSegments())[0].endedAt).toBe(10_000)
    })

    it('断片が1つもない区間は消す', async () => {
        await createSegment(segment('E', 20_000))

        expect(await closeStaleSegments(1000, 30_000)).toEqual(['E'])
        expect((await listAllSegments()).map(s => s.segmentId)).toEqual(['C'])
    })

    it('確定した後に続きの断片が届いたら（一時保存から移された など）、終わりを延ばす', async () => {
        await closeStaleSegments(1000, 30_000)

        await appendFragments('C', [fragment(5, 13_000)]) // 5〜6秒の断片

        expect((await listAllSegments())[0].endedAt).toBe(14_000)
    })
})
