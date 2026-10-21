// 見ている場面の前後を切り出して、mp4 のファイルにする（再エンコードしない）
// 保存先の断片（数秒ごと）の単位で切るので、前後は断片の境目まで少し長くなる。
// 途中から切り出す時は、キーフレームから始まる断片までさかのぼる（そこからでないと再生できないため）。
// 映像・音声の設定が変わった所（解像度が変わった など）は、つなぐと再生できないので、ファイルを分ける
import { buildFmp4File, initSignature, moofSizeOf } from '../fmp4'
import type { PlacedFragment, PlacedSegment, Timeline } from './timeline'

type ClipFile = {
    blob: Blob
    startedAt: number // 最初の場面を録った時刻（ミリ秒）
    duration: number // 秒
}

type ReadFragments = (segmentId: string, indexes: number[]) => Promise<(Blob | null)[]>

type RunFragment = Pick<PlacedFragment, 'segmentId' | 'index' | 'keyframe' | 'startTime' | 'duration'>

// 続けて再生できるまとまり（同じ区間の、間の抜けていない断片）に分ける
// 続きでない所からは、キーフレームから始まる断片からしか再生できないので、それまでの断片は除く
const splitRuns = <T extends RunFragment>(fragments: T[]) => {
    const runs: T[][] = []
    let run: T[] = []
    for (const fragment of fragments) {
        const last = run[run.length - 1]
        if (last && last.segmentId === fragment.segmentId && last.index === fragment.index - 1) {
            run.push(fragment)
            continue
        }
        if (run.length > 0) runs.push(run)
        run = fragment.keyframe ? [fragment] : []
    }
    if (run.length > 0) runs.push(run)
    return runs
}

const signatureOf = async (init: Blob) => {
    try {
        return initSignature(new Uint8Array(await init.arrayBuffer()))
    } catch {
        return null
    }
}

// 時間軸の from〜to（秒）を切り出す。切り出せる録画がなければ空
const buildClipFiles = async (timeline: Timeline, from: number, to: number, readFragments: ReadFragments): Promise<ClipFile[]> => {
    const flat = timeline.fragments
    let first = timeline.indexAt(from)
    if (first < 0) return []
    while (first > 0 && !flat[first].keyframe && flat[first - 1].segmentId === flat[first].segmentId && flat[first - 1].index === flat[first].index - 1) first--
    const picked: PlacedFragment[] = []
    for (let i = first; i < flat.length && flat[i].start < to; i++) picked.push(flat[i])
    // 読んでいる間に時間軸が変わっても（消された・読み直した）、選んだ時の区間を使う
    const segments = new Map<string, PlacedSegment>()
    for (const fragment of picked) {
        const segment = timeline.segment(fragment.segmentId)
        if (segment) segments.set(segment.segmentId, segment)
    }

    // 断片のデータを読む（読む前に消された断片は除いて、続けて再生できるように分け直す）
    const loaded: (PlacedFragment & { blob: Blob })[] = []
    for (const run of splitRuns(picked.filter(f => segments.has(f.segmentId)))) {
        const blobs = await readFragments(run[0].segmentId, run.map(f => f.index))
        run.forEach((fragment, i) => {
            const blob = blobs[i]
            if (blob) loaded.push({ ...fragment, blob })
        })
    }

    // 設定が同じで続けて並んだまとまりは、1本のファイルにつなぐ
    const signatures = new Map<string, string | null>()
    for (const segment of segments.values()) signatures.set(segment.segmentId, await signatureOf(segment.init))
    const groups: (PlacedFragment & { blob: Blob })[][][] = []
    let previous: string | null = null
    for (const run of splitRuns(loaded)) {
        const signature = signatures.get(run[0].segmentId) ?? null
        const group = groups[groups.length - 1]
        if (group && signature !== null && signature === previous) group.push(run)
        else groups.push([run])
        previous = signature
    }

    const files: ClipFile[] = []
    for (const group of groups) {
        const parts = await Promise.all(group.map(async run => ({
            init: segments.get(run[0].segmentId)!.init,
            fragments: await Promise.all(run.map(async f => ({ blob: f.blob, moofSize: await moofSizeOf(f.blob) }))),
        })))
        const head = group[0][0]
        files.push({
            blob: await buildFmp4File(parts),
            startedAt: segments.get(head.segmentId)!.startedAt + head.startTime * 1000,
            // 断片の長さは映像と音声の早い方の始め〜遅い方の終わりなので、足し合わせずに、まとまりの始めから終わりまでで数える
            duration: group.reduce((sum, run) => sum + run[run.length - 1].startTime + run[run.length - 1].duration - run[0].startTime, 0),
        })
    }
    return files
}

export { buildClipFiles, splitRuns }
export type { ClipFile }
