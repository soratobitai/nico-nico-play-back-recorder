import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createFmp4Splitter, splitFmp4Blob, buildFmp4File, parseInit, parseMoof, type Fragment } from '@/utils/fmp4'

// MediaRecorder（Chrome）で録った約8秒の MP4
const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))
const fixtureBlob = new Blob([fixture], { type: 'video/mp4' })

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

// 録画中と同じように、好きな大きさに区切って少しずつ渡す
const splitInChunks = (sizes: number[]) => {
    const splitter = createFmp4Splitter()
    const inits: Uint8Array[] = []
    const fragments: Fragment[] = []
    let p = 0
    for (let i = 0; p < fixture.length; i++) {
        const size = sizes[i % sizes.length]
        const { init, fragments: got } = splitter.push(fixture.subarray(p, p + size))
        if (init) inits.push(init)
        fragments.push(...got)
        p += size
    }
    return { inits, fragments }
}

// つないだファイルの各トラックの開始時刻（秒）を断片ごとに読む
const trackStartTimes = async (blob: Blob) => {
    const { init, fragments } = await splitFmp4Blob(blob)
    const tracks = parseInit(new Uint8Array(await init.arrayBuffer()))
    const out: { sequence: number, starts: Record<number, number> }[] = []
    for (const f of fragments) {
        const moof = new Uint8Array(await f.blob.slice(0, f.moofSize).arrayBuffer())
        const info = parseMoof(moof, tracks)
        const starts: Record<number, number> = {}
        for (const t of info.trackFragments) starts[t.trackId] = t.baseTime / tracks.get(t.trackId)!.timescale
        out.push({ sequence: new DataView(moof.buffer).getUint32(info.sequenceOffset), starts })
    }
    return out
}

describe('createFmp4Splitter（録画中のデータを分ける）', () => {
    it('どんな区切りで届いても、初期化セグメントを1回だけ出し、残りを断片に分ける', () => {
        for (const sizes of [[fixture.length], [1000], [7, 13, 4096], [36, 1216, 50000]]) {
            const { inits, fragments } = splitInChunks(sizes)

            expect(inits).toHaveLength(1)
            const initSize = inits[0].length
            expect(new TextDecoder().decode(inits[0].subarray(4, 8))).toBe('ftyp')
            // 初期化セグメントと断片をつなぐと元のデータに戻る
            expect(initSize + sum(fragments.map(f => f.bytes.length))).toBe(fixture.length)
            expect(fragments.length).toBeGreaterThanOrEqual(3)
        }
    })

    it('断片は時刻の順に並び、長さの合計が録画の長さになる', () => {
        const { fragments } = splitInChunks([3000])
        for (let i = 1; i < fragments.length; i++) {
            expect(fragments[i].startTime).toBeGreaterThan(fragments[i - 1].startTime)
        }
        expect(fragments.every(f => f.duration > 0)).toBe(true)
        expect(sum(fragments.map(f => f.duration))).toBeGreaterThan(7)
        expect(sum(fragments.map(f => f.duration))).toBeLessThan(9)
    })
})

describe('splitFmp4Blob（保存済みのファイルを分ける）', () => {
    it('録画中に分けた場合と同じ断片になる', async () => {
        const live = splitInChunks([2048]).fragments
        const { init, fragments } = await splitFmp4Blob(fixtureBlob)

        expect(fragments.map(f => f.startTime)).toEqual(live.map(f => f.startTime))
        expect(init.size + sum(fragments.map(f => f.blob.size))).toBe(fixture.length)
        expect(new Uint8Array(await fragments[1].blob.arrayBuffer())).toEqual(live[1].bytes)
    })

    it('MP4 でないデータは例外にする', async () => {
        await expect(splitFmp4Blob(new Blob(['not a video']))).rejects.toThrow()
    })
})

describe('buildFmp4File（1本のファイルにまとめる）', () => {
    it('古い断片が消された区間も、0 秒から始まるファイルにする', async () => {
        const { init, fragments } = await splitFmp4Blob(fixtureBlob)
        const remaining = fragments.slice(2)

        const file = await buildFmp4File([{ init, fragments: remaining }])
        const rebuilt = await splitFmp4Blob(file)

        expect(rebuilt.fragments[0].startTime).toBeCloseTo(0, 3)
        expect(rebuilt.fragments).toHaveLength(remaining.length)
        expect(sum(rebuilt.fragments.map(f => f.duration))).toBeCloseTo(sum(remaining.map(f => f.duration)), 3)
    })

    it('2つの区間をつなぐと、後の区間は前の区間の終わりから続き、映像と音声は同じだけずれる', async () => {
        const { init, fragments } = await splitFmp4Blob(fixtureBlob)
        const file = await buildFmp4File([{ init, fragments }, { init, fragments }])
        const joined = await trackStartTimes(file)
        const n = fragments.length

        expect(joined).toHaveLength(n * 2)
        expect(joined.map(f => f.sequence)).toEqual(joined.map((_, i) => i + 1))

        // 後の区間の各トラックのずれ（秒）が、どのトラックでも同じ（音ズレが積み重ならない）
        const shifts = Object.keys(joined[0].starts).map(id => joined[n].starts[+id] - joined[0].starts[+id])
        for (const shift of shifts) expect(shift).toBeCloseTo(shifts[0], 3)
        // ずれは前の区間の長さ（映像と音声の長い方）
        const firstEnd = Math.max(...fragments.map(f => f.startTime + f.duration)) - fragments[0].startTime
        expect(shifts[0]).toBeCloseTo(firstEnd, 3)
    })

    it('断片がなければ例外にする', async () => {
        const { init } = await splitFmp4Blob(fixtureBlob)
        await expect(buildFmp4File([{ init, fragments: [] }])).rejects.toThrow()
    })
})
