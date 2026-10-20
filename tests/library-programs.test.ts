// ライブラリのページ: 番組ごとのまとめ・まとめて保存
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { summarizePrograms, filterPrograms, groupByDay, programKeyOf, sortPrograms, recordedSeconds, thumbnailOf, filesOf } from '@/utils/library/programs'
import {
    clearAll, createSegment, setSegmentInit, appendFragments, finishSegment, buildDownloadFiles, listAllSegments, getTimelineForSegments, getInitSignatures,
    type NewSegment, type SegmentSummary,
} from '@/utils/library/db'
import { splitFmp4Blob, initSignature } from '@/utils/fmp4'

const fixture = new Blob([new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))], { type: 'video/mp4' })

const summary = (overrides: Partial<SegmentSummary>): SegmentSummary => ({
    segmentId: 'S', programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', title: 'title', userName: 'user',
    startedAt: 0, endedAt: 1000, thumbnail: null, bytes: 100, fragmentCount: 1, duration: 1, ...overrides,
})

describe('番組ごとにまとめる', () => {
    it('番組ごとに区間・種類・大きさをまとめ、最近録った番組から並べる', () => {
        const programs = summarizePrograms([
            summary({ segmentId: 'a1', programId: 'lv1', startedAt: 1000, endedAt: 2000, bytes: 10 }),
            summary({ segmentId: 'b1', programId: 'lv2', startedAt: 5000, endedAt: 6000, bytes: 30, title: 'other' }),
            summary({ segmentId: 'a2', programId: 'lv1', kind: 'comments', startedAt: 1000, endedAt: null, duration: 9, bytes: 20 }),
        ])

        expect(programs.map(p => p.key)).toEqual(['lv1', 'lv2']) // lv1 は録画中で 10 秒まで延びている
        expect(programs[0]).toMatchObject({
            startedAt: 1000, endedAt: 10_000, recording: true, kinds: ['video', 'comments'], bytes: 30,
            bytesByKind: { video: 10, comments: 20, screen: 0 },
        })
        expect(programs[0].segments.map(s => s.segmentId)).toEqual(['a1', 'a2'])
    })

    it('以前のバージョンから移した録画は、配信者とタイトルで見分ける', () => {
        expect(programKeyOf({ programId: 'legacy', title: 'T', userName: 'U' })).toBe('legacy:U:T')
        expect(programKeyOf({ programId: 'lv1', title: 'T', userName: 'U' })).toBe('lv1')
    })

    it('タイトル・配信者の言葉（すべてを含む）と種類で絞り込む', () => {
        const programs = summarizePrograms([
            summary({ segmentId: 'a', programId: 'lv1', title: '深夜の雑談', userName: 'Alice' }),
            summary({ segmentId: 'b', programId: 'lv2', title: 'ゲーム実況', userName: 'Bob', kind: 'screen' }),
        ])

        expect(filterPrograms(programs, 'alice 雑談', null).map(p => p.key)).toEqual(['lv1'])
        expect(filterPrograms(programs, '', 'screen').map(p => p.key)).toEqual(['lv2'])
        expect(filterPrograms(programs, '', null)).toHaveLength(2)
    })

    it('録った日ごとに「今日」「昨日」「日付」でまとめる', () => {
        const now = new Date(2026, 9, 19, 12)
        const at = (d: number) => new Date(2026, 9, d, 10).getTime()
        const programs = summarizePrograms([
            summary({ segmentId: 'a', programId: 'lv1', startedAt: at(19), endedAt: at(19) }),
            summary({ segmentId: 'b', programId: 'lv2', startedAt: at(18), endedAt: at(18) }),
            summary({ segmentId: 'c', programId: 'lv3', startedAt: at(17), endedAt: at(17) }),
            summary({ segmentId: 'd', programId: 'lv4', startedAt: at(17) - 1000, endedAt: at(17) - 1000 }),
        ])

        expect(groupByDay(programs, now).map(g => [g.label, g.programs.length])).toEqual([['今日', 1], ['昨日', 1], ['10月17日（土）', 2]])
    })
})

describe('録画一覧のページに出す形', () => {
    it('大きい順に並べられる（最近録った順はそのまま）', () => {
        const programs = summarizePrograms([
            summary({ segmentId: 'a', programId: 'lv1', startedAt: 1000, endedAt: 2000, bytes: 30 }),
            summary({ segmentId: 'b', programId: 'lv2', startedAt: 5000, endedAt: 6000, bytes: 10 }),
            summary({ segmentId: 'c', programId: 'lv3', startedAt: 3000, endedAt: 4000, bytes: 20 }),
        ])
        expect(sortPrograms(programs, 'recent').map(p => p.key)).toEqual(['lv2', 'lv3', 'lv1'])
        expect(sortPrograms(programs, 'size').map(p => p.key)).toEqual(['lv1', 'lv3', 'lv2'])
    })

    it('録った時間は、どれかの種類を録っていた時間を合わせる（同時に録った所は1回だけ。空いた所は数えない）', () => {
        expect(recordedSeconds([
            summary({ segmentId: 'a', startedAt: 0, endedAt: 60_000 }),
            summary({ segmentId: 'b', kind: 'comments', startedAt: 30_000, endedAt: 90_000 }),
            summary({ segmentId: 'c', startedAt: 3_600_000, endedAt: 3_610_000 }),
        ])).toBe(100)
    })

    it('一覧の画像は、最後に録った区間の画像', () => {
        expect(thumbnailOf([summary({ segmentId: 'a', thumbnail: 'A' }), summary({ segmentId: 'b', thumbnail: 'B' }), summary({ segmentId: 'c', thumbnail: null })])).toBe('B')
    })

    it('種類ごとに、保存した時のファイルの単位にまとめる（設定が変わった所で分ける。続けて録った区間は1つの帯）', () => {
        const segments = [
            summary({ segmentId: 'a', startedAt: 0, endedAt: 300_000 }),
            summary({ segmentId: 'b', startedAt: 300_500, endedAt: 600_000 }), // 5分ごとの区切り
            summary({ segmentId: 'c', startedAt: 600_800, endedAt: 700_000 }), // 解像度が変わった
            summary({ segmentId: 'd', startedAt: 4_000_000, endedAt: null, duration: 60 }), // ページを開き直した（同じ設定）
            summary({ segmentId: 'x', kind: 'comments', startedAt: 0, endedAt: 600_000 }),
        ]
        const signatures = new Map([['a', '720p'], ['b', '720p'], ['c', '1080p'], ['d', '1080p'], ['x', '720p']])

        const files = filesOf(segments, 'video', signatures)

        expect(files.map(f => f.segments.map(s => s.segmentId))).toEqual([['a', 'b'], ['c', 'd']])
        expect(files.map(f => f.splitBySettings)).toEqual([false, true])
        expect(files[0].blocks).toEqual([{ start: 0, end: 600_000 }])
        expect(files[1].blocks).toEqual([{ start: 600_800, end: 700_000 }, { start: 4_000_000, end: 4_060_000 }])
        expect(files[1]).toMatchObject({ recording: true, seconds: 99.2 + 60 })
    })
})

describe('まとめて保存（buildDownloadFiles）', () => {
    const segment = (segmentId: string, startedAt: number, overrides: Partial<NewSegment> = {}): NewSegment => ({
        segmentId, programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', title: 'title', userName: 'user',
        startedAt, thumbnail: null, ...overrides,
    })
    let init: Blob
    let fragments: Awaited<ReturnType<typeof splitFmp4Blob>>['fragments']

    // 録画の区間を作る（fixture の初期化セグメントと断片を使う）
    const record = async (seg: NewSegment, initBlob = init) => {
        await createSegment(seg)
        await setSegmentInit(seg.segmentId, initBlob)
        await appendFragments(seg.segmentId, fragments.map((f, i) => ({ ...f, index: i, wallClock: seg.startedAt + i })))
        await finishSegment(seg.segmentId, seg.startedAt + 8000)
    }

    // 解像度が違う録画の初期化セグメント（avc1 の幅を書き換える）
    const otherResolution = async () => {
        const bytes = new Uint8Array(await init.arrayBuffer())
        const text = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4))
        let i = 0
        while (text(i) !== 'stsd') i++
        while (text(i) !== 'avc1') i++
        new DataView(bytes.buffer).setUint16(i + 28, 640)
        return new Blob([bytes])
    }

    beforeEach(async () => {
        await clearAll()
        ;({ init, fragments } = await splitFmp4Blob(fixture))
    })

    it('同じ設定で続けて録った区間は、1本のファイルにつなぐ', async () => {
        await record(segment('A', 1000))
        await record(segment('B', 9000))

        const files = await buildDownloadFiles(['B', 'A'])

        expect(files).toHaveLength(1)
        expect(files[0]).toMatchObject({ kind: 'video', startedAt: 1000, segmentIds: ['A', 'B'] })
        expect((await splitFmp4Blob(files[0].blob)).fragments).toHaveLength(fragments.length * 2)
    })

    it('解像度が変わった所・種類が違う区間・webm の区間は、別のファイルにする', async () => {
        await record(segment('A', 1000))
        await record(segment('B', 9000), await otherResolution())
        await record(segment('C', 17000, { kind: 'comments' }))
        await createSegment(segment('W', 25000, { format: 'opaque', mimeType: 'video/webm' }))
        await appendFragments('W', [{ index: 0, blob: new Blob(['webm']), moofSize: 0, startTime: 0, duration: 1, wallClock: 25000 }])

        const files = await buildDownloadFiles(['A', 'B', 'C', 'W'])

        expect(files.map(f => f.segmentIds)).toEqual([['A'], ['B'], ['C'], ['W']])
        expect(files.map(f => f.kind)).toEqual(['video', 'video', 'comments', 'video'])
        expect(await files[3].blob.text()).toBe('webm')
    })

    it('断片が1つもない区間は含めない', async () => {
        await record(segment('A', 1000))
        await createSegment(segment('E', 9000))

        expect((await buildDownloadFiles(['A', 'E'])).map(f => f.segmentIds)).toEqual([['A']])
    })

    it('区間ごとの設定の印を読める（初期化セグメントのない区間・ない区間は null）', async () => {
        await record(segment('A', 1000))
        await record(segment('B', 9000), await otherResolution())
        await createSegment(segment('E', 17000))

        const signatures = await getInitSignatures(['A', 'B', 'E', 'missing'])

        expect(signatures.get('A')).toBe(initSignature(new Uint8Array(await init.arrayBuffer())))
        expect(signatures.get('B')).not.toBe(signatures.get('A'))
        expect([signatures.get('E'), signatures.get('missing')]).toEqual([null, null])
    })

    it('初期化セグメントのつなげるかどうかの印は、作った日時などに左右されず、解像度の違いでは変わる', async () => {
        const same = initSignature(new Uint8Array(await init.arrayBuffer()))
        expect(initSignature(new Uint8Array(await init.arrayBuffer()))).toBe(same)
        expect(initSignature(new Uint8Array(await (await otherResolution()).arrayBuffer()))).not.toBe(same)
    })

    it('ライブラリのページ用に、全区間と、指定した区間の時間軸を読める', async () => {
        await record(segment('A', 1000))
        await record(segment('B', 9000, { programId: 'lv2' }))

        expect((await listAllSegments()).map(s => s.segmentId)).toEqual(['B', 'A'])
        expect((await getTimelineForSegments(['A', 'missing'])).map(s => s.segmentId)).toEqual(['A'])
    })
})
