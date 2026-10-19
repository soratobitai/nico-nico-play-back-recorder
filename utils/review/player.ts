// 見直しの再生（MediaSource）
// 時間軸（Timeline）の再生位置のまわりの断片だけを読み込み、離れた部分は捨てる（長い録画でもメモリを使いすぎない）。
// 区間が変わる所では、その区間の初期化セグメントを読み込んでから、時間軸の位置（timestampOffset）に合わせて断片を足す。
import { planBuffer, fragmentKey, type Timeline, type PlacedFragment, type PlacedSegment } from './timeline'

// 再生位置の 30 秒先まで読み込み、30 秒より前と 90 秒より先は捨てる
const BUFFER_WINDOW = { ahead: 30, keepBehind: 30, keepAhead: 90 }
// 一度に保存先から読む断片の数
const READ_BATCH = 4
// 録画中に届いた断片を、保存先から読み直さずに使うために覚えておく数（約3分）
const LIVE_CACHE_SIZE = 60
// 録っていない短い間（区間の切り替わり など）は飛ばして再生を続ける
const MAX_GAP_JUMP_SECONDS = 12
// 録画の形式に codecs が書かれていない場合（以前のバージョンから移した録画など）
const FALLBACK_MIME_TYPE = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'

type ReadFragments = (segmentId: string, indexes: number[]) => Promise<(Blob | null)[]>

type ReviewPlayerOptions = {
    video: HTMLVideoElement
    timeline: Timeline
    readFragments: ReadFragments
    onError?: (error: unknown) => void
}

const mimeTypeOf = (segment: PlacedSegment) =>
    /codecs/i.test(segment.mimeType) && MediaSource.isTypeSupported(segment.mimeType) ? segment.mimeType : FALLBACK_MIME_TYPE

const isQuotaExceeded = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError'

const createReviewPlayer = ({ video, timeline, readFragments, onError }: ReviewPlayerOptions) => {
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
    let dirty = false
    let running = false
    let destroyed = false

    const position = () => pendingSeek ?? video.currentTime

    // SourceBuffer の操作を1つ行い、終わるのを待つ
    const operate = (operation: (buffer: SourceBuffer) => void) => new Promise<void>((resolve, reject) => {
        const buffer = sourceBuffer!
        const done = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(new Error('見直しの動画を読み込めませんでした')) }
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
        if (currentSegmentId !== segment.segmentId) await switchSegment(segment)
        const bytes = await blob.arrayBuffer()
        try {
            await operate(buffer => buffer.appendBuffer(bytes))
        } catch (error) {
            if (!isQuotaExceeded(error)) throw error
            // 読み込める量を超えたら、再生位置より前を捨ててからもう一度
            await removeBuffered(0, Math.max(0, position() - 5))
            forget(f => f.end <= position() - 5)
            await operate(buffer => buffer.appendBuffer(bytes))
        }
        appended.add(fragmentKey(fragment))
    }

    // 断片のデータを読む（録画中に届いたものは覚えているものを使う）
    const read = async (fragments: PlacedFragment[]) => {
        const blobs = new Map<string, Blob | null>()
        const missing = new Map<string, PlacedFragment[]>()
        for (const fragment of fragments) {
            const cached = liveCache.get(fragmentKey(fragment))
            if (cached) blobs.set(fragmentKey(fragment), cached)
            else missing.set(fragment.segmentId, [...(missing.get(fragment.segmentId) ?? []), fragment])
        }
        for (const [segmentId, list] of missing) {
            const read = await readFragments(segmentId, list.map(f => f.index))
            list.forEach((fragment, i) => blobs.set(fragmentKey(fragment), read[i]))
        }
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
        const target = pendingSeek
        pendingSeek = null
        video.currentTime = target
    }

    const work = async () => {
        if (running) return
        running = true
        try {
            await opened
            while (dirty && !destroyed) {
                dirty = false
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

                for (let i = 0; i < plan.append.length && !dirty && !destroyed; i += READ_BATCH) {
                    const batch = plan.append.slice(i, i + READ_BATCH)
                    const blobs = await read(batch)
                    for (const fragment of batch) {
                        if (dirty || destroyed) break
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
            }
        } catch (error) {
            if (!destroyed) onError?.(error)
        } finally {
            running = false
            // 処理中に新しい依頼が来ていたら続ける
            if (dirty && !destroyed) void work()
        }
    }

    // 再生位置のまわりの読み込みを（必要なら）進める
    const update = () => {
        dirty = true
        void work()
    }

    // 録っていない間（区間の切り替わり・容量の上限を超えて消された部分）で止まったら、続きへ飛ぶ
    const jumpGap = () => {
        if (destroyed || video.paused || video.seeking || pendingSeek !== null) return
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
        const next = timeline.fragments[timeline.indexAt(t)]
        if (next && next.start > t && bufferedAt(next.start + 0.1)) {
            video.currentTime = next.start + 0.01
            return
        }
        // 少し先に読み込まれた部分（映像と音声の境目のずれなど）
        for (let i = 0; i < ranges.length; i++) {
            const start = ranges.start(i)
            if (start > t && start - t < MAX_GAP_JUMP_SECONDS) {
                video.currentTime = start + 0.01
                return
            }
        }
    }

    const onTimeUpdate = () => update()
    const onWaiting = () => { jumpGap(); update() }
    // 動画の情報が読み込まれたら、指定されていた再生位置へ移る（読み込みが全部終わった後に情報が届く場合もある）
    const onLoadedMetadata = () => {
        extendDuration()
        applyPendingSeek()
    }
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('seeking', onTimeUpdate)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    const gapTimer = setInterval(() => {
        applyPendingSeek()
        jumpGap()
    }, 500)

    return {
        // 再生位置（秒）
        get position() {
            return position()
        },

        seek(t: number) {
            const target = Math.min(Math.max(t, timeline.start), timeline.end)
            if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
                extendDuration()
                video.currentTime = target
            } else {
                pendingSeek = target
            }
            update()
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
            video.removeEventListener('timeupdate', onTimeUpdate)
            video.removeEventListener('seeking', onTimeUpdate)
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

export { createReviewPlayer }
export type { ReviewPlayer }
