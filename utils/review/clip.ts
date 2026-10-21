// 見ている場面の前後を切り出して、1本の mp4 にする（再エンコードしない）
// 保存先の断片（数秒ごと）の単位で切るので、前後は断片の境目まで少し長くなる。
// 途中から切り出す時は、キーフレームから始まる断片までさかのぼる（そこからでないと再生できないため）。
// 映像・音声の設定が変わった所（解像度が変わった など）と、録画が途切れた所（ページを開き直した など）より先は入れない
// （つなぐと再生できない・離れた時刻の場面が続いて見えるため）。1回で1本だけ作る
// （続けて何本もダウンロードすると、2本目から Chrome に止められるため）
import { buildFmp4File, initSignature, moofSizeOf } from '../fmp4'
import { MAX_CONTINUOUS_GAP_SECONDS, type PlacedFragment, type PlacedSegment, type Timeline } from './timeline'

type ClipFile = {
    blob: Blob
    startedAt: number // 最初の場面を録った時刻（ミリ秒）
    duration: number // 秒
}

type ReadFragments = (segmentId: string, indexes: number[]) => Promise<(Blob | null)[]>

type RunFragment = Pick<PlacedFragment, 'segmentId' | 'index' | 'keyframe'>
type LoadedFragment = PlacedFragment & { blob: Blob }

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

// 時間軸の at（秒）の前後 seconds 秒を切り出す。切り出せる録画がなければ null
const buildClipFile = async (timeline: Timeline, at: number, seconds: number, readFragments: ReadFragments): Promise<ClipFile | null> => {
    const from = at - seconds
    const to = at + seconds
    // 区間ごとに、範囲にかかる断片を区間の中の順に選ぶ（区間どうしが少し重なっていても、混ぜない）
    // 最初の断片がキーフレームから始まらなければ、同じ区間の続けて録った断片の中で、キーフレームまでさかのぼる
    // （読んでいる間に時間軸が変わっても（消された・読み直した）、選んだ時の区間を使う）
    const segments = new Map<string, PlacedSegment>()
    const picked: PlacedFragment[] = []
    for (const segment of timeline.placedSegments) {
        const fragments = segment.fragments
        let first = fragments.findIndex(f => f.end > from && f.start < to)
        if (first < 0) continue
        let last = first
        while (last + 1 < fragments.length && fragments[last + 1].start < to) last++
        while (first > 0 && !fragments[first].keyframe && fragments[first - 1].index === fragments[first].index - 1) first--
        segments.set(segment.segmentId, segment)
        picked.push(...fragments.slice(first, last + 1))
    }

    // 断片のデータを読む（読む前に消された断片は除いて、続けて再生できるように分け直す）
    const loaded: LoadedFragment[] = []
    for (const run of splitRuns(picked)) {
        const blobs = await readFragments(run[0].segmentId, run.map(f => f.index))
        run.forEach((fragment, i) => {
            const blob = blobs[i]
            if (blob) loaded.push({ ...fragment, blob })
        })
    }
    const runs = splitRuns(loaded)
    if (runs.length === 0) return null

    // 1本につなげる所（設定が同じで、録った時刻が続いている）ごとにまとめる
    const signatures = new Map<string, string | null>()
    for (const segment of segments.values()) signatures.set(segment.segmentId, await signatureOf(segment.init))
    const wallStart = (f: LoadedFragment) => segments.get(f.segmentId)!.startedAt + f.startTime * 1000
    const groups: LoadedFragment[][][] = []
    for (const run of runs) {
        const group = groups[groups.length - 1]
        const previous = group?.[group.length - 1]
        const tail = previous?.[previous.length - 1]
        const signature = signatures.get(run[0].segmentId) ?? null
        const joinable = !!previous && !!tail && signature !== null && signature === signatures.get(previous[0].segmentId)
            && wallStart(run[0]) - (wallStart(tail) + tail.duration * 1000) <= MAX_CONTINUOUS_GAP_SECONDS * 1000
        if (joinable) group.push(run)
        else groups.push([run])
    }
    // 場面を含むまとまり（場面が抜けた所にあれば、その次のまとまり）
    const endOf = (group: LoadedFragment[][]) => { const run = group[group.length - 1]; return run[run.length - 1].end }
    const group = groups.find(g => at < endOf(g)) ?? groups[groups.length - 1]

    const parts = await Promise.all(group.map(async run => ({
        init: segments.get(run[0].segmentId)!.init,
        fragments: await Promise.all(run.map(async f => ({ blob: f.blob, moofSize: await moofSizeOf(f.blob) }))),
    })))
    return {
        blob: await buildFmp4File(parts),
        startedAt: wallStart(group[0][0]),
        // 断片の長さは映像と音声の早い方の始め〜遅い方の終わりなので、足し合わせずに、まとまりの始めから終わりまでで数える
        duration: group.reduce((sum, run) => sum + run[run.length - 1].startTime + run[run.length - 1].duration - run[0].startTime, 0),
    }
}

export { buildClipFile, splitRuns }
export type { ClipFile }
