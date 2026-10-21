// 見ている場面の前後を、動画で保存する（断片の単位で切り出して、1本の mp4 にする）
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { splitFmp4Blob, type FragmentBlob } from '@/utils/fmp4'
import { Timeline } from '@/utils/review/timeline'
import { buildClipFiles } from '@/utils/review/clip'

// MediaRecorder（Chrome）で録った約8秒の MP4
const fixture = new Blob([new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))], { type: 'video/mp4' })

let init: Blob
let fragments: FragmentBlob[]
beforeAll(async () => {
    ({ init, fragments } = await splitFmp4Blob(fixture))
})

// 解像度だけ違う初期化セグメント（つなげない録画）
const otherResolution = async () => {
    const bytes = new Uint8Array(await init.arrayBuffer())
    const text = (i: number) => String.fromCharCode(...bytes.subarray(i, i + 4))
    let i = 0
    while (text(i) !== 'stsd') i++
    while (text(i) !== 'avc1') i++
    new DataView(bytes.buffer).setUint16(i + 28, 640)
    return new Blob([bytes])
}

type Recorded = { segmentId: string, startedAt: number, init?: Blob, keyframes?: boolean[] }
const setup = (recorded: Recorded[], deleted: string[] = []) => {
    const timeline = new Timeline()
    timeline.sync(recorded.map(({ segmentId, startedAt, init: segmentInit, keyframes }) => ({
        segmentId, kind: 'video', mimeType: 'video/mp4', startedAt, endedAt: startedAt + 10_000, init: segmentInit ?? init,
        fragments: fragments.map((f, index) => ({ index, startTime: f.startTime, duration: f.duration, keyframe: keyframes?.[index] ?? f.keyframe })),
    })))
    const read = async (segmentId: string, indexes: number[]) =>
        indexes.map(index => deleted.includes(`${segmentId}:${index}`) ? null : fragments[index].blob)
    return { timeline, read }
}

// 保存したファイルの断片（切り出した断片と同じ中身か、mdat の大きさで確かめる）
const fragmentsOf = async (blob: Blob) => (await splitFmp4Blob(blob)).fragments
const mdatSizes = (list: FragmentBlob[]) => list.map(f => f.blob.size - f.moofSize)

describe('この場面の前後を動画で保存', () => {
    it('場面の前後にかかる断片だけを切り出し、0秒から始まる1本の mp4 にする', async () => {
        expect(fragments.length).toBeGreaterThanOrEqual(3)
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000 }])
        const middle = timeline.fragments[1]
        const t = (middle.start + middle.end) / 2

        const [file, ...rest] = await buildClipFiles(timeline, t - 0.1, t + 0.1, read)

        expect(rest).toHaveLength(0)
        const saved = await fragmentsOf(file.blob)
        expect(mdatSizes(saved)).toEqual(mdatSizes([fragments[1]]))
        expect(saved[0].startTime).toBeCloseTo(0, 1)
        expect(file.startedAt).toBe(1_000_000 + fragments[1].startTime * 1000)
        expect(file.duration).toBeCloseTo(fragments[1].duration)
    })

    it('キーフレームから始まらない断片からは、キーフレームの断片までさかのぼる', async () => {
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000, keyframes: [true, false, false] }])
        const t = timeline.fragments[2].start + 0.01

        const [file] = await buildClipFiles(timeline, t, t + 0.01, read)

        expect(mdatSizes(await fragmentsOf(file.blob))).toEqual(mdatSizes(fragments.slice(0, 3)))
    })

    it('読む前に消された断片は除き、その後はキーフレームの断片から続ける', async () => {
        const keyframes = fragments.map((_, i) => i !== 2)
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000, keyframes }], ['A:1'])

        const [file, ...rest] = await buildClipFiles(timeline, 0, timeline.end, read)

        expect(rest).toHaveLength(0)
        expect(mdatSizes(await fragmentsOf(file.blob))).toEqual(mdatSizes([fragments[0], ...fragments.slice(3)]))
    })

    it('続けて録った区間をまたぐ時は1本につなぎ、解像度が変わった所ではファイルを分ける', async () => {
        const length = fragments[fragments.length - 1].startTime + fragments[fragments.length - 1].duration - fragments[0].startTime
        const second = 1_000_000 + Math.round(length * 1000) + 500
        const same = setup([{ segmentId: 'A', startedAt: 1_000_000 }, { segmentId: 'B', startedAt: second }])

        const joined = await buildClipFiles(same.timeline, 0, same.timeline.end, same.read)
        expect(joined).toHaveLength(1)
        expect(mdatSizes(await fragmentsOf(joined[0].blob))).toEqual(mdatSizes([...fragments, ...fragments]))

        const changed = setup([{ segmentId: 'A', startedAt: 1_000_000 }, { segmentId: 'B', startedAt: second, init: await otherResolution() }])
        const split = await buildClipFiles(changed.timeline, 0, changed.timeline.end, changed.read)
        expect(split.map(f => f.startedAt)).toEqual([1_000_000 + fragments[0].startTime * 1000, second + fragments[0].startTime * 1000])
    })

    it('録画がなければ、何も作らない', async () => {
        expect(await buildClipFiles(new Timeline(), 0, 60, async () => [])).toEqual([])
    })
})
