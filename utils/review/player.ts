// 録画の再生（MediaSource）。プレイバックと録画一覧で使う
// 時間軸（Timeline）の再生位置のまわりの断片だけを読み込み、離れた部分は捨てる（長い録画でもメモリを使いすぎない）。
// 区間が変わる所では、その区間の初期化セグメントを読み込んでから、時間軸の位置（timestampOffset）に合わせて断片を足す。
import { planBuffer, fragmentKey, type Timeline, type PlacedFragment, type PlacedSegment } from './timeline'

// 再生位置の 30 秒先まで読み込み、30 秒より前と 90 秒より先は捨てる
const BUFFER_WINDOW = { ahead: 30, keepBehind: 30, keepAhead: 90 }
// 一度に保存先から読む断片の数
const READ_BATCH = 4
// 録画中に届いた断片を、保存先から読み直さずに使うために覚えておく数（約3分）
const LIVE_CACHE_SIZE = 60
// 読み込んだ範囲の、これより小さな隙間（映像と音声の境目のずれなど）は、録っていない間でなくても飛ばす
const SMALL_HOLE_SECONDS = 1
// 止まった位置が、読み込んだ範囲の終わりからこれだけ以内なら、その終わりで止まったとみなす（Chrome は少し手前で止まる）
const NEAR_RANGE_END_SECONDS = 1.5
// 録っていない間・止まっていないかを確かめる間隔と、止まったとみなすまでの回数（1秒）
const GAP_CHECK_MS = 500
const STUCK_CHECKS = 2
// 断片の終わりのこれだけ手前からは、その後の録っていない間と同じに扱う（映像と音声の長さの違いで読み込まれない端数）
const FRAGMENT_TAIL_SECONDS = 0.5
// 録画の形式に codecs が書かれていない場合（以前のバージョンから移した録画など）
const FALLBACK_MIME_TYPE = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
// 読み込みに一時的に失敗した時（保存先が忙しい など）に、もう一度読むまでの時間
const RETRY_DELAY_MS = 2000

type ReadFragments = (segmentId: string, indexes: number[]) => Promise<(Blob | null)[]>

// 断片の終わりの端数（その後が空いている時）に入らない、いちばん後ろの位置
const beforeTail = (fragment: PlacedFragment) => Math.max(fragment.start, fragment.end - FRAGMENT_TAIL_SECONDS)

type BufferedRange = { start: number, end: number }

// 再生が t で先へ進まない時に、飛ぶ先（飛ばないなら null）
// t を含む読み込んだ範囲の終わり（なければ t）から、次の読み込んだ範囲の始めまでの間を見る:
// - ごく小さな隙間（映像と音声の境目のずれなど）なら飛ぶ
// - その間に、まだ読み込んでいない録画の断片がなければ飛ぶ（間がどれだけ長くても）。
//   録っていない間（区間の切り替わり・壊れて外した所・消された所）や、読み込んだのに抜けた所
//   （少し重なった区間の断片を読み込んで、前に読み込んだ部分が消えた所）
// - まだ読み込んでいない断片があれば、読み込みを待つ（飛ぶと、録った場面を見落とす）
// 読み込んだ範囲の終わりより前で止まっている時は、ここでは飛ばない
// isLoaded: その断片を読み込んだか
const stuckJumpTarget = (timeline: Timeline, t: number, ranges: readonly BufferedRange[], isLoaded: (fragment: PlacedFragment) => boolean): number | null => {
    const current = ranges.find(range => range.start <= t + 0.05 && t < range.end)
    const from = current ? current.end : t
    if (from - t > NEAR_RANGE_END_SECONDS) return null
    const next = ranges.find(range => range.start > t && range.start >= from - 0.05)
    if (!next) return null
    if (next.start - from < SMALL_HOLE_SECONDS) return next.start + 0.01
    const loading = timeline.fragments.some(f => f.start < next.start - 0.05 && f.end > from + 0.05 && !isLoaded(f))
    return loading ? null : next.start + 0.01
}

// 移る位置を、読み込める所に合わせる
// 録っていない間を指していたら、次に録った所へ（読み込めないので、そこへは移れない）。
// 断片の終わりぎりぎり（映像と音声の長さの違いで、読み込まれない端数）で、その後が空いている場合も同じ。
// backward（戻る操作）なら、間の前の録った所へ、間を除いて戻る（戻れずに同じ所へ移り続けないように）。
// 間の前の断片が短くても、録った時間で数えて、その前の断片までさかのぼる
const snapToRecorded = (timeline: Timeline, t: number, backward = false) => {
    const flat = timeline.fragments
    const i = timeline.indexAt(t)
    const here = flat[i]
    if (!here) return t
    const inGap = here.start > t
    if (inGap && backward && i > 0) {
        let remaining = here.start - t
        for (let j = i - 1; j >= 0; j--) {
            const fragment = flat[j]
            const length = fragment.end - fragment.start
            if (remaining <= length) return j === i - 1 ? Math.min(fragment.end - remaining, beforeTail(fragment)) : fragment.end - remaining
            remaining -= length
        }
        return flat[0].start
    }
    if (inGap) return here.start
    const next = flat[i + 1]
    if (next && here.end - t < FRAGMENT_TAIL_SECONDS && next.start > here.end + 0.05) {
        // 戻る操作なら、この断片の端数の手前へ（次の録った所へ進めると、戻れずに同じ所へ移り続ける）
        return backward ? beforeTail(here) : next.start
    }
    return t
}

type ReviewPlayerOptions = {
    video: HTMLVideoElement
    timeline: Timeline
    readFragments: ReadFragments
    // 時間軸の最後まで読み込んだら、動画の終わりにする（最後まで再生したら止まる）。
    // 録画中の番組を追いかけて見る場合は、区間の切り替わりで終わりにしないよう false にする
    endAtLast?: boolean
    // 断片（とその区間の初期化セグメント）を再生用に読み込めなかった（録画が壊れている）
    onError?: (error: unknown, fragment: PlacedFragment) => void
    // 保存先から読めなかった（少し待ってから読み直す）
    onReadError?: (error: unknown) => void
}

// 断片を読み込めなかった（どの断片かを伝える）
class AppendError extends Error {
    constructor(readonly fragment: PlacedFragment, readonly reason: unknown) {
        super('録画を読み込めませんでした')
        this.name = 'AppendError'
    }
}

const mimeTypeOf = (segment: PlacedSegment) =>
    /codecs/i.test(segment.mimeType) && MediaSource.isTypeSupported(segment.mimeType) ? segment.mimeType : FALLBACK_MIME_TYPE

const isQuotaExceeded = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError'
// 保存先とやり取りできない（拡張機能が更新された・応答がない）。録画が壊れているのではない
const isUnavailable = (error: unknown) => error instanceof Error && error.name === 'BridgeUnavailableError'
// 続けてこの回数読めなかったら、1つずつ読み直して、読めない断片を壊れているとみなす
const MAX_READ_FAILURES = 3

const createReviewPlayer = ({ video, timeline, readFragments, endAtLast = true, onError, onReadError }: ReviewPlayerOptions) => {
    const mediaSource = new MediaSource()
    const url = URL.createObjectURL(mediaSource)
    video.src = url
    const opened = new Promise<void>(resolve => mediaSource.addEventListener('sourceopen', () => resolve(), { once: true }))

    let sourceBuffer: SourceBuffer | null = null
    let sourceMimeType: string | null = null
    let currentSegmentId: string | null = null // 最後に初期化セグメントを読み込んだ区間
    const appended = new Set<string>()
    const initCache = new Map<string, ArrayBuffer>()
    const liveCache = new Map<string, Blob>()
    // 動画の情報が読み込まれる前に指定された再生位置（読み込まれたら移る）
    let pendingSeek: number | null = null
    let dirty = false // 読み込む断片を決め直す（再生位置が進んだ・時間軸が延びた）
    let interrupted = false // 再生位置が飛んだ（読み込み中の断片を待たずに、すぐ決め直す）
    let running = false
    let destroyed = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryAt = 0 // 読み込みに失敗した時、この時刻まで読み直さない
    let readFailures = 0 // 続けて読めなかった回数

    const position = () => pendingSeek ?? video.currentTime

    // SourceBuffer の操作を1つ行い、終わるのを待つ
    const operate = (operation: (buffer: SourceBuffer) => void) => new Promise<void>((resolve, reject) => {
        const buffer = sourceBuffer!
        const done = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(new Error('録画を読み込めませんでした')) }
        const cleanup = () => {
            buffer.removeEventListener('updateend', done)
            buffer.removeEventListener('error', failed)
        }
        buffer.addEventListener('updateend', done)
        buffer.addEventListener('error', failed)
        try {
            operation(buffer)
        } catch (error) {
            cleanup()
            reject(error)
        }
    })

    const isBuffered = (from: number, to: number) => {
        const ranges = sourceBuffer?.buffered
        if (!ranges) return false
        for (let i = 0; i < ranges.length; i++) {
            if (ranges.end(i) > from && ranges.start(i) < to) return true
        }
        return false
    }

    const forget = (predicate: (fragment: PlacedFragment) => boolean) => {
        for (const fragment of timeline.fragments) {
            if (predicate(fragment)) appended.delete(fragmentKey(fragment))
        }
    }

    const removeBuffered = async (from: number, to: number) => {
        if (!sourceBuffer || !(to > from) || !isBuffered(from, to)) return
        await operate(buffer => buffer.remove(from, to))
    }

    // 区間の初期化セグメントを読み込み、その区間の断片を時間軸の位置に置けるようにする
    const switchSegment = async (segment: PlacedSegment) => {
        let init = initCache.get(segment.segmentId)
        if (!init) {
            init = await segment.init.arrayBuffer()
            initCache.set(segment.segmentId, init)
        }
        const mimeType = mimeTypeOf(segment)
        if (!sourceBuffer) {
            sourceBuffer = mediaSource.addSourceBuffer(mimeType)
            sourceBuffer.mode = 'segments'
            sourceMimeType = mimeType
        } else if (mimeType !== sourceMimeType) {
            sourceBuffer.changeType(mimeType)
            sourceMimeType = mimeType
        }
        await operate(buffer => buffer.appendBuffer(init))
        sourceBuffer.timestampOffset = segment.offset!
        currentSegmentId = segment.segmentId
    }

    const appendFragment = async (fragment: PlacedFragment, blob: Blob) => {
        const segment = timeline.segment(fragment.segmentId)
        if (!segment || segment.offset === null) return
        try {
            // 読めないデータ（保存先のファイルが失われた など）も、壊れた録画として扱う
            const bytes = await blob.arrayBuffer()
            if (currentSegmentId !== segment.segmentId) await switchSegment(segment)
            try {
                await operate(buffer => buffer.appendBuffer(bytes))
            } catch (error) {
                if (!isQuotaExceeded(error)) throw error
                // 読み込める量を超えたら、再生位置より前を捨ててからもう一度
                await removeBuffered(0, Math.max(0, position() - 5))
                forget(f => f.end <= position() - 5)
                await operate(buffer => buffer.appendBuffer(bytes))
            }
        } catch (error) {
            // 容量不足（捨てても足りない）は、録画が壊れているのではないので、少し待ってから読み直す
            if (isQuotaExceeded(error)) throw error
            throw new AppendError(fragment, error)
        }
        appended.add(fragmentKey(fragment))
    }

    // 時間軸の最後まで読み込んで、録画中の区間もなければ、動画の終わりにする（最後まで再生したら止まるように）
    const endIfComplete = () => {
        if (!endAtLast || mediaSource.readyState !== 'open' || !sourceBuffer || sourceBuffer.updating) return
        const flat = timeline.fragments
        const last = flat[flat.length - 1]
        if (!last || !appended.has(fragmentKey(last))) return
        if (timeline.placedSegments.some(s => s.endedAt === null)) return
        mediaSource.endOfStream()
    }

    // 断片のデータを読む（録画中に届いたものは覚えているものを使う）
    // 続けて読めない場合は、1つずつ読み直して、読めない断片を壊れた録画として知らせる（その断片のせいで、まわりも読めなくならないように）
    const read = async (fragments: PlacedFragment[]) => {
        const blobs = new Map<string, Blob | null>()
        const missing = new Map<string, PlacedFragment[]>()
        for (const fragment of fragments) {
            const cached = liveCache.get(fragmentKey(fragment))
            if (cached) blobs.set(fragmentKey(fragment), cached)
            else missing.set(fragment.segmentId, [...(missing.get(fragment.segmentId) ?? []), fragment])
        }
        for (const [segmentId, list] of missing) {
            try {
                const read = await readFragments(segmentId, list.map(f => f.index))
                list.forEach((fragment, i) => blobs.set(fragmentKey(fragment), read[i]))
            } catch (error) {
                if (isUnavailable(error) || ++readFailures < MAX_READ_FAILURES) throw error
                for (const fragment of list) {
                    try {
                        blobs.set(fragmentKey(fragment), (await readFragments(segmentId, [fragment.index]))[0])
                    } catch (fragmentError) {
                        if (isUnavailable(fragmentError)) throw fragmentError
                        throw new AppendError(fragment, fragmentError)
                    }
                }
            }
        }
        readFailures = 0
        return blobs
    }

    // 時間軸の長さに合わせて、動画の長さを延ばす（その位置まで移動できるように）
    const extendDuration = () => {
        if (mediaSource.readyState !== 'open' || sourceBuffer?.updating) return
        const end = timeline.end
        if (end > 0 && !(mediaSource.duration >= end)) mediaSource.duration = end
    }

    const applyPendingSeek = () => {
        if (pendingSeek === null || video.readyState < HTMLMediaElement.HAVE_METADATA) return
        // 動画の長さがその位置まで延びてから移る（延ばせない間は、次の機会にもう一度）
        if (!(mediaSource.duration >= pendingSeek)) extendDuration()
        if (!(mediaSource.duration >= pendingSeek)) return
        const target = snapToRecorded(timeline, pendingSeek)
        pendingSeek = null
        video.currentTime = target
    }

    const work = async () => {
        // 読み込みに失敗した後は、少し待ってから（再生中の timeupdate のたびに読み直さない）
        if (running || Date.now() < retryAt) return
        running = true
        let failed = false
        try {
            await opened
            while (dirty && !destroyed) {
                dirty = false
                interrupted = false
                extendDuration()
                const plan = planBuffer(timeline, position(), appended, BUFFER_WINDOW)

                if (plan.removeBefore !== null) {
                    const before = plan.removeBefore
                    await removeBuffered(0, before)
                    forget(f => f.start < before)
                }
                if (plan.removeFrom !== null && mediaSource.duration > plan.removeFrom) {
                    const from = plan.removeFrom
                    await removeBuffered(from, mediaSource.duration)
                    forget(f => f.start >= from)
                }

                // 再生が進んだだけ（timeupdate）なら、読んでいる断片は読み込んでから決め直す
                // （読み込みが遅い時に、読んだそばから捨て続けて再生が止まらないように）
                for (let i = 0; i < plan.append.length && !interrupted && !destroyed; i += READ_BATCH) {
                    const batch = plan.append.slice(i, i + READ_BATCH)
                    const blobs = await read(batch)
                    for (const fragment of batch) {
                        if (interrupted || destroyed) break
                        const blob = blobs.get(fragmentKey(fragment))
                        if (!blob) {
                            // 容量の上限を超えて消された断片
                            timeline.removeFragment(fragment.segmentId, fragment.index)
                            continue
                        }
                        await appendFragment(fragment, blob)
                        extendDuration()
                        applyPendingSeek()
                    }
                }
                endIfComplete()
            }
        } catch (error) {
            failed = true
            if (destroyed) {
                // 何もしない
            } else if (error instanceof AppendError) {
                onError?.(error.reason, error.fragment)
            } else {
                // 保存先から読めなかった・容量不足など（録画が壊れているのではない）は、少し待ってから読み直す
                console.warn('録画を読み込めませんでした。少し待ってから読み直します:', error)
                onReadError?.(error)
                retryAt = Date.now() + RETRY_DELAY_MS
                clearTimeout(retryTimer)
                retryTimer = setTimeout(update, RETRY_DELAY_MS)
            }
        } finally {
            running = false
            // 処理中に新しい依頼が来ていたら続ける（失敗した時は、待ってから読み直す）
            if (dirty && !destroyed && !failed) void work()
        }
    }

    // 再生位置のまわりの読み込みを（必要なら）進める
    const update = () => {
        dirty = true
        void work()
    }

    // 再生位置が飛んだ（読み込み中の断片を待たずに決め直す）
    const restart = () => {
        interrupted = true
        update()
    }

    const isAppended = (fragment: PlacedFragment) => appended.has(fragmentKey(fragment))
    const bufferedRanges = (): BufferedRange[] => {
        const ranges = video.buffered
        return Array.from({ length: ranges.length }, (_, i) => ({ start: ranges.start(i), end: ranges.end(i) }))
    }

    // 録っていない間（区間の切り替わり・容量の上限を超えて消された部分）で止まったら、続きへ飛ぶ
    // 録っていない間へ移ろうとしている（移り終わらない）場合も、次に録った所へ移る
    const jumpGap = () => {
        if (destroyed || pendingSeek !== null) return
        if (video.paused && !video.seeking) return
        const t = video.currentTime
        const ranges = video.buffered
        const bufferedAt = (time: number) => {
            for (let i = 0; i < ranges.length; i++) {
                if (ranges.start(i) <= time + 0.05 && time < ranges.end(i) - 0.1) return true
            }
            return false
        }
        if (bufferedAt(t)) return // 続きが読み込まれている

        // 時間軸の上で、今の位置より後にある次の断片（読み込み済みなら飛ぶ）
        const next = snapToRecorded(timeline, t)
        if (next > t && bufferedAt(next + 0.1)) {
            video.currentTime = next + 0.01
            return
        }
        // 移っている途中なら、読み込みを待つ（その位置の断片を読み込んでいる）
        if (video.seeking) return
        // 録っていない間の先や、映像と音声の境目のずれなどの小さな隙間の先が読み込まれていれば、そこへ
        const target = stuckJumpTarget(timeline, t, bufferedRanges(), isAppended)
        if (target !== null) video.currentTime = target
    }

    // 再生しているのに位置が進まない時は、録っていない間の先（または小さな隙間の先）へ飛ぶ
    // （区間の切り替わりの隙間の手前では、読み込んだ範囲の終わりより少し前で止まり、
    //   jumpGap からは「まだ読み込まれた所にいる」と見えて飛ばないことがある）
    // 飛ぶ先がまだ読み込まれていなければ、数え続けて、読み込まれたら飛ぶ
    let lastPosition = -1
    let stuckChecks = 0
    const jumpIfStuck = () => {
        if (destroyed || video.paused || video.seeking || pendingSeek !== null) {
            lastPosition = -1
            stuckChecks = 0
            return
        }
        const t = video.currentTime
        if (Math.abs(t - lastPosition) > 0.01) {
            lastPosition = t
            stuckChecks = 0
            return
        }
        if (++stuckChecks < STUCK_CHECKS) return
        const target = stuckJumpTarget(timeline, t, bufferedRanges(), isAppended)
        if (target === null) return
        stuckChecks = 0
        video.currentTime = target
    }

    const onTimeUpdate = () => update()
    const onSeeking = () => restart()
    const onWaiting = () => { jumpGap(); update() }
    // 動画の情報が読み込まれたら、指定されていた再生位置へ移る（読み込みが全部終わった後に情報が届く場合もある）
    const onLoadedMetadata = () => {
        extendDuration()
        applyPendingSeek()
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    const gapTimer = setInterval(() => {
        applyPendingSeek()
        jumpGap()
        jumpIfStuck()
    }, GAP_CHECK_MS)

    return {
        // 再生位置（秒）
        get position() {
            return position()
        },

        // backward: 戻る操作（録っていない間に当たったら、間の前へ戻る）
        seek(t: number, { backward = false } = {}) {
            const target = snapToRecorded(timeline, Math.min(Math.max(t, timeline.start), timeline.end), backward)
            if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
                extendDuration()
                video.currentTime = target
            } else {
                pendingSeek = target
            }
            restart()
        },

        // 時間軸が延びた・変わった
        update,

        // 録画中に届いた断片を覚えておく
        cacheFragment(segmentId: string, index: number, blob: Blob) {
            liveCache.set(fragmentKey({ segmentId, index }), blob)
            while (liveCache.size > LIVE_CACHE_SIZE) liveCache.delete(liveCache.keys().next().value!)
        },

        destroy() {
            destroyed = true
            clearInterval(gapTimer)
            clearTimeout(retryTimer)
            video.removeEventListener('timeupdate', onTimeUpdate)
            video.removeEventListener('seeking', onSeeking)
            video.removeEventListener('waiting', onWaiting)
            video.removeEventListener('loadedmetadata', onLoadedMetadata)
            video.pause()
            video.removeAttribute('src')
            video.load()
            URL.revokeObjectURL(url)
        },
    }
}

type ReviewPlayer = ReturnType<typeof createReviewPlayer>

export { createReviewPlayer, snapToRecorded, stuckJumpTarget }
export type { ReviewPlayer }
