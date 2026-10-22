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

// fixture の断片の、音声のトラックをサンプルのない空のもの（時刻 0）にする
// （Chrome の MediaRecorder は、5分ごとに区切って止めた時の最後の断片をこうすることがある）
const withEmptyAudio = (bytes: Uint8Array, audioTrackId: number) => {
    const out = bytes.slice()
    const view = new DataView(out.buffer)
    const type = (p: number) => String.fromCharCode(...out.subarray(p + 4, p + 8))
    const moofEnd = view.getUint32(0)
    for (let p = 8; p < moofEnd;) {
        const size = view.getUint32(p)
        if (type(p) === 'traf') {
            let track = -1
            for (let q = p + 8; q < p + size;) {
                const s = view.getUint32(q)
                if (type(q) === 'tfhd') track = view.getUint32(q + 12)
                if (track === audioTrackId && type(q) === 'tfdt') {
                    if (out[q + 8] === 1) view.setBigUint64(q + 12, 0n)
                    else view.setUint32(q + 12, 0)
                }
                if (track === audioTrackId && type(q) === 'trun') view.setUint32(q + 12, 0) // sample_count
                q += s
            }
        }
        p += size
    }
    return out
}

describe('サンプルのない音声のトラック（時刻 0）がある断片', () => {
    const load = async () => {
        const { init, fragments } = await splitFmp4Blob(fixtureBlob)
        const tracks = parseInit(new Uint8Array(await init.arrayBuffer()))
        const audio = [...tracks].find(([, track]) => !track.isVideo)![0]
        const last = fragments[fragments.length - 1]
        const emptied = new Blob([withEmptyAudio(new Uint8Array(await last.blob.arrayBuffer()), audio)])
        return { init, fragments, tracks, audio, last, emptied }
    }

    it('断片の時刻は、サンプルのあるトラックで数える（区間の始めからの長い断片にしない）', async () => {
        const { init, fragments, last, emptied } = await load()
        const file = new Blob([init, ...fragments.slice(0, -1).map(f => f.blob), emptied])

        const parsed = (await splitFmp4Blob(file)).fragments

        expect(parsed[parsed.length - 1].startTime).toBeGreaterThan(fragments[fragments.length - 2].startTime)
        expect(parsed[parsed.length - 1].startTime).toBeCloseTo(last.startTime, 1)
    })

    it('途中から切り出してつなぐ時も、0 秒から始まり、空のトラックの時刻も前へ戻らない', async () => {
        const { init, fragments, tracks, audio, last, emptied } = await load()
        const parts = [{ init, fragments: [...fragments.slice(1, -1), { blob: emptied, moofSize: last.moofSize }] }]

        const file = await buildFmp4File(parts)

        const saved = await trackStartTimes(file)
        expect(Math.min(...Object.values(saved[0].starts))).toBeCloseTo(0, 1)
        const lastStarts = saved[saved.length - 1].starts
        const video = [...tracks].find(([, track]) => track.isVideo)![0]
        expect(lastStarts[audio]).toBeCloseTo(lastStarts[video], 1)
    })
})

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

    it('映像がキーフレームから始まる断片かを見分ける（MediaRecorder はキーフレームごとに断片を区切る）', () => {
        const { inits, fragments } = splitInChunks([fixture.length])
        expect(fragments.every(f => f.keyframe)).toBe(true)

        // 2つ目の断片の映像の最初のサンプルを、キーフレームでないことにする
        const bytes = fixture.slice()
        const moofStart = inits[0].length + fragments[0].bytes.length
        const view = new DataView(bytes.buffer)
        let changed = 0
        for (let p = moofStart; p < moofStart + fragments[1].moofSize - 4; p++) {
            if (String.fromCharCode(...bytes.subarray(p, p + 4)) !== 'trun') continue
            const flags = view.getUint32(p + 4) & 0xffffff
            if (!(flags & 0x4)) continue // 映像の trun だけが first_sample_flags を持つ
            const firstFlags = p + 4 + 8 + (flags & 0x1 ? 4 : 0)
            view.setUint32(firstFlags, view.getUint32(firstFlags) | 0x10000) // sample_is_non_sync_sample
            changed++
        }
        expect(changed).toBe(1)

        const splitter = createFmp4Splitter()
        const result = splitter.push(bytes).fragments
        expect(result.map(f => f.keyframe)).toEqual([true, false, true])
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
