// MediaRecorder が作る MP4（fragmented MP4）を扱う
// 録画データは「再生に必要な情報（初期化セグメント: ftyp + moov）」のあとに、
// 数秒ごとの「断片（moof + mdat）」が並んだ形になっている（Chrome の MediaRecorder は、キーフレームごとに断片を区切る）。
// 断片のまま保存しておけば、録画中でも再生でき、古い断片から消していける。

type TrackInfo = { timescale: number, defaultDuration: number, defaultFlags: number, isVideo: boolean }
type Tracks = Map<number, TrackInfo>

// 断片の中の、1つのトラック（映像・音声）の情報。時刻を書き換えるために moof の中での位置も持つ
// startsWithSync: 最初のサンプルが、それだけで表示できるフレーム（キーフレーム）か
type TrackFragment = { trackId: number, tfdtOffset: number, tfdtVersion: number, baseTime: number, duration: number, startsWithSync: boolean }
type MoofInfo = { sequenceOffset: number, trackFragments: TrackFragment[] }

// keyframe: 映像がキーフレームから始まる（この断片から再生を始められる）
type FragmentTiming = { startTime: number, duration: number, keyframe: boolean } // 秒
type Fragment = FragmentTiming & { bytes: Uint8Array, moofSize: number }
type FragmentBlob = FragmentTiming & { blob: Blob, moofSize: number }

type Box = { type: string, start: number, end: number, bodyStart: number, children?: Box[] }

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf'])

const readBoxType = (bytes: Uint8Array, p: number) =>
    String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])

// ボックスの大きさ（1 のときは、続く 8 バイトが本当の大きさ）
const readBoxSize = (view: DataView, p: number) => {
    const size = view.getUint32(p)
    if (size === 1) return { size: Number(view.getBigUint64(p + 8)), headerSize: 16 }
    return { size, headerSize: 8 }
}

const readBoxes = (bytes: Uint8Array, start = 0, end = bytes.length): Box[] => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const boxes: Box[] = []
    for (let p = start; p + 8 <= end;) {
        const { size, headerSize } = readBoxSize(view, p)
        if (size < headerSize || p + size > end) throw new Error(`MP4 のボックスが壊れています: ${readBoxType(bytes, p)}`)
        const box: Box = { type: readBoxType(bytes, p), start: p, end: p + size, bodyStart: p + headerSize }
        if (CONTAINER_BOXES.has(box.type)) box.children = readBoxes(bytes, box.bodyStart, box.end)
        boxes.push(box)
        p += size
    }
    return boxes
}

const child = (box: Box | undefined, type: string) => box?.children?.find(b => b.type === type)
const children = (box: Box | undefined, type: string) => box?.children?.filter(b => b.type === type) ?? []

const concatBytes = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length)
    out.set(a)
    out.set(b, a.length)
    return out
}

// 初期化セグメントから、トラックごとの時間の単位（timescale）などを読む
const parseInit = (init: Uint8Array): Tracks => {
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength)
    const moov = readBoxes(init).find(b => b.type === 'moov')
    if (!moov) throw new Error('MP4 の初期化セグメントに moov がありません')

    const tracks: Tracks = new Map()
    for (const trak of children(moov, 'trak')) {
        const tkhd = child(trak, 'tkhd')
        const mdhd = child(child(trak, 'mdia'), 'mdhd')
        if (!tkhd || !mdhd) continue
        const hdlr = child(child(trak, 'mdia'), 'hdlr')
        const trackId = view.getUint32(tkhd.bodyStart + (init[tkhd.bodyStart] === 1 ? 20 : 12))
        const timescale = view.getUint32(mdhd.bodyStart + (init[mdhd.bodyStart] === 1 ? 20 : 12))
        const isVideo = !!hdlr && readBoxType(init, hdlr.bodyStart + 4) === 'vide' // handler_type
        tracks.set(trackId, { timescale, defaultDuration: 0, defaultFlags: 0, isVideo })
    }
    for (const trex of children(child(moov, 'mvex'), 'trex')) {
        const track = tracks.get(view.getUint32(trex.bodyStart + 4))
        if (!track) continue
        track.defaultDuration = view.getUint32(trex.bodyStart + 12)
        track.defaultFlags = view.getUint32(trex.bodyStart + 20)
    }
    return tracks
}

// 断片の moof から、トラックごとの開始時刻（tfdt）と長さを読む
const parseMoof = (moof: Uint8Array, tracks: Tracks): MoofInfo => {
    const view = new DataView(moof.buffer, moof.byteOffset, moof.byteLength)
    const box = readBoxes(moof).find(b => b.type === 'moof')
    const mfhd = child(box, 'mfhd')
    if (!box || !mfhd) throw new Error('MP4 の断片に moof がありません')

    const trackFragments = children(box, 'traf').map((traf): TrackFragment => {
        const tfhd = child(traf, 'tfhd')
        const tfdt = child(traf, 'tfdt')
        if (!tfhd || !tfdt) throw new Error('MP4 の断片に tfhd / tfdt がありません')

        const tfhdFlags = view.getUint32(tfhd.bodyStart) & 0xffffff
        const trackId = view.getUint32(tfhd.bodyStart + 4)
        let q = tfhd.bodyStart + 8
        if (tfhdFlags & 0x1) q += 8 // base_data_offset
        if (tfhdFlags & 0x2) q += 4 // sample_description_index
        const defaultDuration = (tfhdFlags & 0x8) ? view.getUint32(q) : (tracks.get(trackId)?.defaultDuration ?? 0)
        if (tfhdFlags & 0x8) q += 4
        if (tfhdFlags & 0x10) q += 4 // default_sample_size
        const defaultFlags = (tfhdFlags & 0x20) ? view.getUint32(q) : (tracks.get(trackId)?.defaultFlags ?? 0)

        const tfdtVersion = moof[tfdt.bodyStart]
        const baseTime = tfdtVersion === 1 ? Number(view.getBigUint64(tfdt.bodyStart + 4)) : view.getUint32(tfdt.bodyStart + 4)

        let duration = 0
        let firstSampleFlags: number | null = null
        for (const trun of children(traf, 'trun')) {
            const trunFlags = view.getUint32(trun.bodyStart) & 0xffffff
            const sampleCount = view.getUint32(trun.bodyStart + 4)
            let r = trun.bodyStart + 8
            if (trunFlags & 0x1) r += 4 // data_offset
            const firstFlags = (trunFlags & 0x4) ? view.getUint32(r) : null // first_sample_flags
            if (trunFlags & 0x4) r += 4
            const flagsOffset = 4 * [0x100, 0x200].filter(f => trunFlags & f).length // サンプルごとの sample_flags の位置
            const bytesPerSample = 4 * [0x100, 0x200, 0x400, 0x800].filter(f => trunFlags & f).length
            if (firstSampleFlags === null && sampleCount > 0) {
                firstSampleFlags = firstFlags ?? ((trunFlags & 0x400) ? view.getUint32(r + flagsOffset) : defaultFlags)
            }
            for (let i = 0; i < sampleCount; i++) {
                duration += (trunFlags & 0x100) ? view.getUint32(r) : defaultDuration
                r += bytesPerSample
            }
        }
        // sample_is_non_sync_sample が立っていなければキーフレーム
        const startsWithSync = firstSampleFlags === null || ((firstSampleFlags >> 16) & 1) === 0
        return { trackId, tfdtOffset: tfdt.bodyStart + 4, tfdtVersion, baseTime, duration, startsWithSync }
    })
    return { sequenceOffset: mfhd.bodyStart + 4, trackFragments }
}

const timescaleOf = (tracks: Tracks, trackId: number) => {
    const track = tracks.get(trackId)
    if (!track || track.timescale <= 0) throw new Error(`MP4 のトラック ${trackId} の情報がありません`)
    return track.timescale
}

// 断片の開始時刻と長さ（秒）。映像と音声で少し違うので、早い方の開始〜遅い方の終わりとする
const fragmentTiming = (info: MoofInfo, tracks: Tracks): FragmentTiming => {
    let start = Infinity
    let end = 0
    for (const t of info.trackFragments) {
        const timescale = timescaleOf(tracks, t.trackId)
        start = Math.min(start, t.baseTime / timescale)
        end = Math.max(end, (t.baseTime + t.duration) / timescale)
    }
    // 映像のトラックがない（音声だけの）断片は、どこからでも再生できる
    const keyframe = info.trackFragments.every(t => !tracks.get(t.trackId)?.isVideo || t.startsWithSync)
    if (start === Infinity) return { startTime: 0, duration: 0, keyframe }
    return { startTime: start, duration: end - start, keyframe }
}

// 録画中に届くデータを、初期化セグメントと断片に分ける（届く区切りは自由でよい）
const createFmp4Splitter = () => {
    let pending: Uint8Array = new Uint8Array(0)
    let initParts: Uint8Array[] = []
    let tracks: Tracks | null = null
    let moof: Uint8Array | null = null

    return {
        push(chunk: Uint8Array): { init: Uint8Array | null, fragments: Fragment[] } {
            pending = pending.length ? concatBytes(pending, chunk) : chunk
            const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength)
            let init: Uint8Array | null = null
            const fragments: Fragment[] = []

            let p = 0
            while (p + 8 <= pending.length) {
                // 大きさが 64 ビットで書かれたボックスは、ヘッダーが 16 バイト届くまで待つ
                if (view.getUint32(p) === 1 && p + 16 > pending.length) break
                const { size, headerSize } = readBoxSize(view, p)
                if (size < headerSize) throw new Error(`MP4 のボックスが壊れています: ${readBoxType(pending, p)}`)
                if (p + size > pending.length) break // 続きが届くのを待つ

                const type = readBoxType(pending, p)
                const box = pending.slice(p, p + size)
                if (!tracks) {
                    // moov が届くまでが初期化セグメント
                    initParts.push(box)
                    if (type === 'moov') {
                        init = initParts.reduce(concatBytes)
                        initParts = []
                        tracks = parseInit(init)
                    }
                } else if (type === 'moof') {
                    moof = box
                } else if (type === 'mdat' && moof) {
                    fragments.push({ bytes: concatBytes(moof, box), moofSize: moof.length, ...fragmentTiming(parseMoof(moof, tracks), tracks) })
                    moof = null
                }
                p += size
            }
            pending = pending.slice(p)
            return { init, fragments }
        },
    }
}

// 保存済みの録画ファイルを、初期化セグメントと断片に分ける（ファイル全体はメモリに読み込まない）
const splitFmp4Blob = async (blob: Blob): Promise<{ init: Blob, fragments: FragmentBlob[] }> => {
    let initEnd = 0
    let tracks: Tracks | null = null
    let moof: { start: number, bytes: Uint8Array } | null = null
    const fragments: FragmentBlob[] = []

    for (let p = 0; p + 8 <= blob.size;) {
        const header = new Uint8Array(await blob.slice(p, p + 16).arrayBuffer())
        const { size, headerSize } = readBoxSize(new DataView(header.buffer), 0)
        const type = readBoxType(header, 0)
        if (size < headerSize || p + size > blob.size) throw new Error(`MP4 のボックスが壊れています: ${type}`)

        if (type === 'moov') {
            initEnd = p + size
            tracks = parseInit(new Uint8Array(await blob.slice(0, initEnd).arrayBuffer()))
        } else if (type === 'moof') {
            moof = { start: p, bytes: new Uint8Array(await blob.slice(p, p + size).arrayBuffer()) }
        } else if (type === 'mdat' && moof && tracks) {
            fragments.push({
                blob: blob.slice(moof.start, p + size),
                moofSize: moof.bytes.length,
                ...fragmentTiming(parseMoof(moof.bytes, tracks), tracks),
            })
            moof = null
        }
        p += size
    }
    if (!tracks) throw new Error('MP4 の初期化セグメントがありません')
    return { init: blob.slice(0, initEnd), fragments }
}

// 断片（moof + mdat）の、先頭の moof の大きさ（保存先から読んだ断片を、ファイルにまとめる時に使う）
const moofSizeOf = async (fragment: Blob) => {
    const header = new Uint8Array(await fragment.slice(0, 16).arrayBuffer())
    if (header.length < 8 || readBoxType(header, 0) !== 'moof') throw new Error('MP4 の断片に moof がありません')
    return readBoxSize(new DataView(header.buffer), 0).size
}

type Fmp4Segment = { init: Blob, fragments: { blob: Blob, moofSize: number }[] }

// 区間（初期化セグメント＋断片）をつないで、1本の MP4 ファイルにする（再エンコードしない）
// 各区間の時刻を、前の区間の終わりから続くように書き換える。映像と音声は同じ時刻からつなぐ
// （トラックごとに自分の終わりへつなぐと、区間ごとの長さの差が積み重なって音ズレする）。
// 区間は同じ映像・音声の設定で録られていること（初期化セグメントは最初の区間のものを使う）
const buildFmp4File = async (segments: Fmp4Segment[]): Promise<Blob> => {
    const nonEmpty = segments.filter(s => s.fragments.length > 0)
    if (nonEmpty.length === 0) throw new Error('録画の断片がありません')

    const parts: BlobPart[] = [nonEmpty[0].init]
    let offsetSeconds = 0 // これまでの区間の長さ
    let sequence = 1

    for (const segment of nonEmpty) {
        const tracks = parseInit(new Uint8Array(await segment.init.arrayBuffer()))
        const moofs = await Promise.all(segment.fragments.map(async f => new Uint8Array(await f.blob.slice(0, f.moofSize).arrayBuffer())))
        const infos = moofs.map(moof => parseMoof(moof, tracks))

        // この区間の始まり（どのトラックでも最も早い時刻）を、これまでの区間の終わりにそろえる
        // （古い断片が消されて途中から始まる区間も、0 秒から始まるファイルになる）
        const startSeconds = Math.min(...infos.flatMap(info => info.trackFragments.map(t => t.baseTime / timescaleOf(tracks, t.trackId))))
        let endSeconds = offsetSeconds

        segment.fragments.forEach((fragment, i) => {
            const moof = moofs[i].slice()
            const view = new DataView(moof.buffer)
            view.setUint32(infos[i].sequenceOffset, sequence++)
            for (const t of infos[i].trackFragments) {
                const timescale = timescaleOf(tracks, t.trackId)
                const value = t.baseTime + Math.round((offsetSeconds - startSeconds) * timescale)
                if (t.tfdtVersion === 1) {
                    view.setBigUint64(t.tfdtOffset, BigInt(value))
                } else {
                    if (value > 0xffffffff) throw new Error('録画が長すぎて1本のファイルにまとめられません')
                    view.setUint32(t.tfdtOffset, value)
                }
                endSeconds = Math.max(endSeconds, (value + t.duration) / timescale)
            }
            parts.push(moof, fragment.blob.slice(fragment.moofSize))
        })
        offsetSeconds = endSeconds
    }
    return new Blob(parts, { type: 'video/mp4' })
}

// 初期化セグメントの、つなげるかどうかを決める部分（トラックの番号・種類・時間の単位・映像と音声の設定）
// 同じなら、別々に録った区間でも1本のファイルにつなげる（解像度などが違うと、つないだ所から再生できない）。
// 作った日時などは録画ごとに違うので含めない
const initSignature = (init: Uint8Array): string => {
    const view = new DataView(init.buffer, init.byteOffset, init.byteLength)
    const moov = readBoxes(init).find(b => b.type === 'moov')
    if (!moov) throw new Error('MP4 の初期化セグメントに moov がありません')
    return children(moov, 'trak').map((trak) => {
        const tkhd = child(trak, 'tkhd')
        const mdia = child(trak, 'mdia')
        const mdhd = child(mdia, 'mdhd')
        const hdlr = child(mdia, 'hdlr')
        const stsd = child(child(child(mdia, 'minf'), 'stbl'), 'stsd')
        const trackId = tkhd ? view.getUint32(tkhd.bodyStart + (init[tkhd.bodyStart] === 1 ? 20 : 12)) : 0
        const timescale = mdhd ? view.getUint32(mdhd.bodyStart + (init[mdhd.bodyStart] === 1 ? 20 : 12)) : 0
        const handler = hdlr ? readBoxType(init, hdlr.bodyStart + 4) : ''
        const description = stsd ? Array.from(init.subarray(stsd.start, stsd.end)).join(',') : ''
        return `${trackId}/${handler}/${timescale}/${description}`
    }).join('|')
}

const isMp4MimeType = (mimeType: string) => mimeType.toLowerCase().startsWith('video/mp4')

export { createFmp4Splitter, splitFmp4Blob, buildFmp4File, moofSizeOf, parseInit, parseMoof, initSignature, isMp4MimeType }
export type { Fragment, FragmentBlob, Fmp4Segment }
