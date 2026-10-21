// 見ている場面の前後を、動画で保存する（断片の単位で切り出して、1本の mp4 にする）
import { beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { splitFmp4Blob, type FragmentBlob } from '@/utils/fmp4'
import { Timeline } from '@/utils/review/timeline'
import { buildClipFile } from '@/utils/review/clip'

// MediaRecorder（Chrome）で録った約8秒の MP4
const fixture = new Blob([new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))], { type: 'video/mp4' })

let init: Blob
let fragments: FragmentBlob[]
let length: number // 録画の長さ（秒）
beforeAll(async () => {
    ({ init, fragments } = await splitFmp4Blob(fixture))
    const last = fragments[fragments.length - 1]
    length = last.startTime + last.duration - fragments[0].startTime
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
    const reads: string[] = []
    const read = async (segmentId: string, indexes: number[]) => {
        reads.push(`${segmentId}[${indexes.join(',')}]`)
        return indexes.map(index => deleted.includes(`${segmentId}:${index}`) ? null : fragments[index].blob)
    }
    return { timeline, read, reads }
}

// 保存したファイルの断片（切り出した断片と同じ中身か、mdat の大きさで確かめる）
const fragmentsOf = async (blob: Blob) => (await splitFmp4Blob(blob)).fragments
const mdatSizes = (list: FragmentBlob[]) => list.map(f => f.blob.size - f.moofSize)

describe('この場面の前後を動画で保存', () => {
    it('場面の前後にかかる断片だけを切り出し、0秒から始まる1本の mp4 にする', async () => {
        expect(fragments.length).toBeGreaterThanOrEqual(3)
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000 }])
        const middle = timeline.fragments[1]

        const file = (await buildClipFile(timeline, (middle.start + middle.end) / 2, 0.1, read))!

        const saved = await fragmentsOf(file.blob)
        expect(mdatSizes(saved)).toEqual(mdatSizes([fragments[1]]))
        expect(saved[0].startTime).toBeCloseTo(0, 1)
        expect(file.startedAt).toBe(1_000_000 + fragments[1].startTime * 1000)
        expect(file.duration).toBeCloseTo(fragments[1].duration)
    })

    it('キーフレームから始まらない断片からは、キーフレームの断片までさかのぼる', async () => {
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000, keyframes: [true, false, false] }])

        const file = (await buildClipFile(timeline, timeline.fragments[2].start + 0.02, 0.01, read))!

        expect(mdatSizes(await fragmentsOf(file.blob))).toEqual(mdatSizes(fragments.slice(0, 3)))
    })

    it('読む前に消された断片は除き、その後はキーフレームの断片から続ける', async () => {
        const keyframes = fragments.map((_, i) => i !== 2)
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000, keyframes }], ['A:1'])

        const file = (await buildClipFile(timeline, 0, 100, read))!

        expect(mdatSizes(await fragmentsOf(file.blob))).toEqual(mdatSizes([fragments[0], ...fragments.slice(3)]))
    })

    it('続けて録った区間をまたぐ時は、1本につなぐ', async () => {
        const second = 1_000_000 + Math.round(length * 1000) + 500
        const { timeline, read } = setup([{ segmentId: 'A', startedAt: 1_000_000 }, { segmentId: 'B', startedAt: second }])

        const file = (await buildClipFile(timeline, length, 100, read))!

        expect(mdatSizes(await fragmentsOf(file.blob))).toEqual(mdatSizes([...fragments, ...fragments]))
        expect(file.startedAt).toBe(1_000_000 + fragments[0].startTime * 1000)
    })

    it('区間どうしが少し重なっていても、区間の中の順番のまま並べる（時刻が戻らない）', async () => {
        // B を A の終わりの 1.8 秒前に始める（A の最後の断片より前に B の最初の断片が始まる）
        const second = 1_000_000 + Math.round((length - 1.8) * 1000)
        const { timeline, read, reads } = setup([{ segmentId: 'A', startedAt: 1_000_000 }, { segmentId: 'B', startedAt: second }])
        expect(timeline.fragments.map(f => f.segmentId).join('')).not.toBe('A'.repeat(fragments.length) + 'B'.repeat(fragments.length))

        const file = (await buildClipFile(timeline, length, 100, read))!

        expect(reads).toEqual([`A[${fragments.map((_, i) => i).join(',')}]`, `B[${fragments.map((_, i) => i).join(',')}]`])
        expect(mdatSizes(await fragmentsOf(file.blob))).toEqual(mdatSizes([...fragments, ...fragments]))
    })

    it('解像度が変わった所・録画が途切れた所より先は入れず、場面を含む1本だけを作る', async () => {
        const second = 1_000_000 + Math.round(length * 1000) + 500
        const first = fragments[0].startTime * 1000

        // 解像度が変わった（B だけ違う）: 場面が B にあれば B だけ、A にあれば A だけ
        const changed = setup([{ segmentId: 'A', startedAt: 1_000_000 }, { segmentId: 'B', startedAt: second, init: await otherResolution() }])
        const inB = (await buildClipFile(changed.timeline, length + 1, 100, changed.read))!
        expect(inB.startedAt).toBe(second + first)
        expect(mdatSizes(await fragmentsOf(inB.blob))).toEqual(mdatSizes(fragments))
        expect((await buildClipFile(changed.timeline, 1, 100, changed.read))!.startedAt).toBe(1_000_000 + first)

        // 録画が途切れた（1時間後に録り直した。時間軸では詰めて並ぶ）: 離れた時刻の場面をつながない
        const later = setup([{ segmentId: 'A', startedAt: 1_000_000 }, { segmentId: 'B', startedAt: 1_000_000 + 3_600_000 }])
        const inA = (await buildClipFile(later.timeline, 1, 100, later.read))!
        expect(inA.startedAt).toBe(1_000_000 + first)
        expect(mdatSizes(await fragmentsOf(inA.blob))).toEqual(mdatSizes(fragments))
    })

    it('録画がなければ、何も作らない', async () => {
        expect(await buildClipFile(new Timeline(), 0, 30, async () => [])).toBeNull()
    })
})
