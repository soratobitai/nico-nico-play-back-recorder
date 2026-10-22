// 録画の保存先（拡張機能側の IndexedDB）
// 拡張機能のページ（ニコ生のページに埋め込む bridge と、録画一覧のページ）から使う。
// ニコ生のページ（content script）からは bridge を通して使う（utils/library/api.ts）。
//
// 録画は「区間（segment）」ごとに保存する。区間は1回の録画処理（MediaRecorder）で録った範囲で、
// fmp4 の区間は「初期化セグメント」と数秒ごとの「断片（fragment）」に分けて持つ。
// 断片のまま持つので、録画中でも再生でき、容量の上限を超えたら古い断片から消していける。
import { buildFmp4File, initSignature } from '../fmp4'
import { groupIntoFiles } from './programs'

const DB_NAME = 'PlaybackLibrary'
const DB_VERSION = 1
const SEGMENTS = 'segments'
const FRAGMENTS = 'fragments'

type RecordingKind = 'video' | 'comments' | 'screen'
// opaque: 断片を先頭から順につなげて再生するだけの形式（webm や、MP4 として読めなかった古い録画）
type SegmentFormat = 'fmp4' | 'opaque'

type SegmentRecord = {
    segmentId: string
    programId: string // 番組（lv〜）。以前のバージョンから移した録画は 'legacy'
    kind: RecordingKind
    format: SegmentFormat
    mimeType: string
    title: string
    userName: string
    startedAt: number // 録画を始めた時刻（ミリ秒）
    endedAt: number | null // 録画を終えた時刻。録画中は null
    init: Blob | null // fmp4 の初期化セグメント（届くまでは null）
    thumbnail: string | null // data URL
    // 番組が始まった時刻（ミリ秒。番組の経過時間を出すのに使う。以前の録画や、読めなかった時はない）
    programBeginAt?: number | null
    bytes: number // 初期化セグメントと断片の合計
    fragmentCount: number
    duration: number // 区間の長さ（秒）
    // 保存先に最後に書き込んだ時刻（ミリ秒）。一時保存から移した録画や以前のバージョンの録画は、
    // 録った時刻が古くても書き込み中なので、終えられないまま残った区間と見分けるのに使う（以前の区間にはない）
    updatedAt?: number
}

type FragmentRecord = {
    segmentId: string
    index: number
    blob: Blob
    moofSize: number // fmp4 の断片の先頭にある moof の大きさ（ファイルにまとめる時に時刻を書き換える）
    startTime: number // 区間の中での開始時刻（秒）
    duration: number
    wallClock: number // 録画した時刻（ミリ秒）。容量の上限を超えた時に古い順に消すために使う
    keyframe?: boolean // 映像がキーフレームから始まる（この断片から再生を始められる）。ない場合は始められるものとする
}

type NewSegment = Omit<SegmentRecord, 'endedAt' | 'init' | 'bytes' | 'fragmentCount' | 'duration' | 'updatedAt'>
type NewFragment = Omit<FragmentRecord, 'segmentId'>
// UI などに渡す区間の情報（大きなデータは含めない）
type SegmentSummary = Omit<SegmentRecord, 'init'>

// ---- IndexedDB の基本操作 ----

let dbPromise: Promise<IDBDatabase> | null = null

const openLibraryDB = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = () => {
            const db = request.result
            const segments = db.createObjectStore(SEGMENTS, { keyPath: 'segmentId' })
            segments.createIndex('startedAt', 'startedAt')
            segments.createIndex('programId', 'programId')
            const fragments = db.createObjectStore(FRAGMENTS, { keyPath: ['segmentId', 'index'] })
            fragments.createIndex('wallClock', 'wallClock')
        }
        request.onsuccess = () => {
            const db = request.result
            db.onversionchange = () => {
                db.close()
                dbPromise = null
            }
            db.onclose = () => {
                dbPromise = null
            }
            resolve(db)
        }
        request.onerror = () => {
            dbPromise = null
            reject(request.error)
        }
    })
    return dbPromise
}

const promisify = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
})

// トランザクションの中で run を実行し、確定してから結果を返す（失敗したらまとめて取り消される）
const withTransaction = async <T>(
    storeNames: string[],
    mode: IDBTransactionMode,
    run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> => {
    const db = await openLibraryDB()
    const tx = db.transaction(storeNames, mode)
    const done = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
    try {
        const result = await run(tx)
        await done
        return result
    } catch (error) {
        try { tx.abort() } catch { /* 既に終わっている */ }
        await done.catch(() => {})
        throw error
    }
}

const fragmentRange = (segmentId: string) => IDBKeyRange.bound([segmentId, -Infinity], [segmentId, Infinity])

const toSummary = ({ init: _init, ...summary }: SegmentRecord): SegmentSummary => summary

class SegmentNotFoundError extends Error {
    constructor(segmentId: string) {
        super(`録画の区間が見つかりません: ${segmentId}`)
        this.name = 'SegmentNotFoundError'
    }
}

const getSegmentRecord = async (store: IDBObjectStore, segmentId: string) => {
    const segment = await promisify<SegmentRecord | undefined>(store.get(segmentId))
    if (!segment) throw new SegmentNotFoundError(segmentId)
    return segment
}

// ---- 録画中に使う操作 ----

const createSegment = (segment: NewSegment) => withTransaction([SEGMENTS], 'readwrite', async (tx) => {
    const record: SegmentRecord = { ...segment, endedAt: null, init: null, bytes: 0, fragmentCount: 0, duration: 0, updatedAt: Date.now() }
    await promisify(tx.objectStore(SEGMENTS).add(record))
})

const setSegmentInit = (segmentId: string, init: Blob) => withTransaction([SEGMENTS], 'readwrite', async (tx) => {
    const store = tx.objectStore(SEGMENTS)
    const segment = await getSegmentRecord(store, segmentId)
    segment.bytes += init.size - (segment.init?.size ?? 0)
    segment.init = init
    segment.updatedAt = Date.now()
    await promisify(store.put(segment))
})

const appendFragments = (segmentId: string, fragments: NewFragment[]) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx) => {
    const segments = tx.objectStore(SEGMENTS)
    const segment = await getSegmentRecord(segments, segmentId)
    const store = tx.objectStore(FRAGMENTS)
    for (const fragment of fragments) {
        const previous = await promisify<FragmentRecord | undefined>(store.get([segmentId, fragment.index]))
        await promisify(store.put({ ...fragment, segmentId }))
        // 同じ断片を2回受け取った場合（一時保存からの移し直しなど）は数え直さない
        if (previous) {
            segment.bytes -= previous.blob.size
        } else {
            segment.fragmentCount += 1
        }
        segment.bytes += fragment.blob.size
        segment.duration = Math.max(segment.duration, fragment.startTime + fragment.duration)
    }
    // 終えたことにした区間に続きが届いた場合（closeStaleSegments の後に一時保存から移された など）は、終わりを延ばす
    if (segment.endedAt !== null) segment.endedAt = Math.max(segment.endedAt, lastWriteOf(segment))
    segment.updatedAt = Date.now()
    await promisify(segments.put(segment))
})

// 最後に書き込まれた断片の終わりの時刻
const lastWriteOf = (segment: SegmentRecord) => segment.startedAt + segment.duration * 1000

// 録画を終えた区間を確定する。断片が1つもない区間は消して null を返す
const finishSegment = (segmentId: string, endedAt: number, mimeType?: string) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx): Promise<SegmentSummary | null> => {
    const segments = tx.objectStore(SEGMENTS)
    const segment = await promisify<SegmentRecord | undefined>(segments.get(segmentId))
    if (!segment) return null
    if (segment.fragmentCount === 0) {
        await promisify(segments.delete(segmentId))
        return null
    }
    segment.endedAt = endedAt
    if (mimeType) segment.mimeType = mimeType
    await promisify(segments.put(segment))
    return toSummary(segment)
})

// ---- 一覧・保存・削除 ----

const getSegmentFragments = (store: IDBObjectStore, segmentId: string) =>
    promisify<FragmentRecord[]>(store.getAll(fragmentRange(segmentId)))

// すべての区間（録画一覧のページで番組ごとにまとめる）。新しい順
const listAllSegments = () => withTransaction([SEGMENTS], 'readonly', async (tx) => {
    const segments = await promisify<SegmentRecord[]>(tx.objectStore(SEGMENTS).getAll())
    return segments.map(toSummary).sort((a, b) => b.startedAt - a.startedAt)
})

type DownloadFile = {
    blob: Blob
    kind: RecordingKind
    mimeType: string
    startedAt: number
    endedAt: number | null
    segmentIds: string[]
}

// 区間をつないで、保存するファイルにする（再エンコードしない）
// 続けて並んだ同じ種類の mp4 の区間のうち、映像・音声の設定が同じものは1本につなぐ。
// 設定が変わった所（解像度が変わった など）と、webm などの区間は別のファイルにする
const buildDownloadFiles = async (segmentIds: string[]): Promise<DownloadFile[]> => {
    const items = await withTransaction([SEGMENTS, FRAGMENTS], 'readonly', async (tx) => {
        const store = tx.objectStore(SEGMENTS)
        const loaded = await Promise.all(segmentIds.map(async (id) => {
            const segment = await promisify<SegmentRecord | undefined>(store.get(id))
            return segment && { segment, fragments: await getSegmentFragments(tx.objectStore(FRAGMENTS), id) }
        }))
        return loaded.filter((item): item is { segment: SegmentRecord, fragments: FragmentRecord[] } => !!item && item.fragments.length > 0)
    })
    items.sort((a, b) => a.segment.startedAt - b.segment.startedAt)

    // 録画一覧のページで出すファイルの単位（groupIntoFiles）と同じにまとめる
    const signatures = new Map(await Promise.all(items.map(async item => [item, await signatureOf(item.segment)] as const)))
    const groups = groupIntoFiles(items, item => ({
        kind: item.segment.kind,
        signature: signatures.get(item) ?? null,
        startedAt: item.segment.startedAt,
        endedAt: item.segment.endedAt ?? item.segment.startedAt + Math.max(...item.fragments.map(f => f.startTime + f.duration)) * 1000,
    }))

    return Promise.all(groups.map(async (group): Promise<DownloadFile> => {
        const kind = group[0].segment.kind
        const signature = signatures.get(group[0]) ?? null
        const first = group[0].segment
        const last = group[group.length - 1].segment
        const blob = signature !== null
            ? await buildFmp4File(group.map(({ segment, fragments }) => ({ init: segment.init!, fragments })))
            : new Blob(group[0].fragments.map(f => f.blob), { type: first.mimeType })
        return {
            blob, kind, mimeType: first.mimeType, startedAt: first.startedAt, endedAt: last.endedAt,
            segmentIds: group.map(({ segment }) => segment.segmentId),
        }
    }))
}

// 区間の映像・音声の設定の印（同じなら、つないで1本のファイルにできる）。mp4 の初期化セグメントがなければ null
const signatureOf = async (segment: Pick<SegmentRecord, 'format' | 'init'>) => {
    if (segment.format !== 'fmp4' || !segment.init) return null
    try {
        return initSignature(new Uint8Array(await segment.init.arrayBuffer()))
    } catch {
        return null
    }
}

// 区間ごとの映像・音声の設定の印（録画一覧のページで、保存した時のファイルの単位を出すのに使う）
const getInitSignatures = async (segmentIds: string[]) => {
    const segments = await withTransaction([SEGMENTS], 'readonly', tx => Promise.all(
        segmentIds.map(id => promisify<SegmentRecord | undefined>(tx.objectStore(SEGMENTS).get(id))),
    ))
    // 初期化セグメントを読むのは、読み出しを終えてから（待っている間に読み出しが閉じないように）
    return new Map(await Promise.all(segmentIds.map(async (id, i) => [id, segments[i] ? await signatureOf(segments[i]!) : null] as const)))
}

const deleteSegments = (segmentIds: string[]) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx) => {
    for (const segmentId of segmentIds) {
        await promisify(tx.objectStore(FRAGMENTS).delete(fragmentRange(segmentId)))
        await promisify(tx.objectStore(SEGMENTS).delete(segmentId))
    }
})

// すべての録画を消す。keepRecording なら、録画中の区間は（続きを書き込めるように）区間だけ残して中身を消す
// 残した区間の数を返す
const clearAll = ({ keepRecording = false } = {}) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx) => {
    const segments = tx.objectStore(SEGMENTS)
    const recording = keepRecording ? (await promisify<SegmentRecord[]>(segments.getAll())).filter(s => s.endedAt === null) : []
    await promisify(tx.objectStore(FRAGMENTS).clear())
    await promisify(segments.clear())
    for (const segment of recording) {
        // 最後に書き込んだ時刻（duration）は残す（終えられないまま残った区間を見分けるのに使う）
        await promisify(segments.put({ ...segment, bytes: segment.init?.size ?? 0, fragmentCount: 0 }))
    }
    return recording.length
})

// ---- プレイバック・録画一覧（区切りをつないで見る） ----

type TimelineFragment = { index: number, startTime: number, duration: number, keyframe: boolean }
type TimelineSegment = Pick<SegmentRecord, 'segmentId' | 'kind' | 'mimeType' | 'startedAt' | 'endedAt'> & {
    init: Blob
    fragments: TimelineFragment[]
}

// 番組の録画を、始めた順に区間と断片の時刻だけ返す（断片のデータは getFragmentBlobs で読む）
// 途中から再生できる mp4 の区間で、初期化セグメントが届いているものだけ
const getTimeline = (programId: string) => withTransaction([SEGMENTS, FRAGMENTS], 'readonly', async (tx) => {
    const segments = await promisify<SegmentRecord[]>(tx.objectStore(SEGMENTS).index('programId').getAll(programId))
    return toTimeline(tx, segments)
})

// 指定した区間について、getTimeline と同じものを返す（録画一覧のページで、番組の区間を指定して使う）
const getTimelineForSegments = (segmentIds: string[]) => withTransaction([SEGMENTS, FRAGMENTS], 'readonly', async (tx) => {
    const store = tx.objectStore(SEGMENTS)
    const segments = await Promise.all(segmentIds.map(id => promisify<SegmentRecord | undefined>(store.get(id))))
    return toTimeline(tx, segments.filter((s): s is SegmentRecord => !!s))
})

// 断片の時刻を、前の断片の続きに直す（これまでに保存した録画では、5分ごとに区切って止めた時の最後の断片を、
// その中のサンプルのない音声のトラックの時刻 0 から数えて、区間の始めから続く長い断片として保存していた。
// 時間軸の上で区間の始めに並んで、再生する位置や切り出す範囲を間違えないように）
const repairTimings = (fragments: FragmentRecord[]) => fragments.map((fragment, i) => {
    const previous = fragments[i - 1]
    if (!previous) return fragment
    const previousEnd = previous.startTime + previous.duration
    const end = fragment.startTime + fragment.duration
    if (fragment.startTime + 0.5 >= previous.startTime || end <= previousEnd) return fragment
    return { ...fragment, startTime: previousEnd, duration: end - previousEnd }
})

const toTimeline = async (tx: IDBTransaction, segments: SegmentRecord[]) => {
    const timeline: TimelineSegment[] = []
    for (const segment of segments.sort((a, b) => a.startedAt - b.startedAt)) {
        if (segment.format !== 'fmp4' || !segment.init) continue
        const fragments = repairTimings(await getSegmentFragments(tx.objectStore(FRAGMENTS), segment.segmentId))
        timeline.push({
            segmentId: segment.segmentId, kind: segment.kind, mimeType: segment.mimeType,
            startedAt: segment.startedAt, endedAt: segment.endedAt, init: segment.init,
            fragments: fragments.map(f => ({ index: f.index, startTime: f.startTime, duration: f.duration, keyframe: f.keyframe ?? true })),
        })
    }
    return timeline
}

// 断片のデータを読む。消された断片は null
const getFragmentBlobs = (segmentId: string, indexes: number[]) => withTransaction([FRAGMENTS], 'readonly', (tx) => {
    const store = tx.objectStore(FRAGMENTS)
    return Promise.all(indexes.map(async index => (await promisify<FragmentRecord | undefined>(store.get([segmentId, index])))?.blob ?? null))
})

// ---- 容量 ----

type Usage = { bytes: number, segments: number, bytesByKind: Record<RecordingKind, number> }

const usageIn = async (tx: IDBTransaction) => {
    const segments = await promisify<SegmentRecord[]>(tx.objectStore(SEGMENTS).getAll())
    const usage: Usage = { bytes: 0, segments: segments.length, bytesByKind: { video: 0, comments: 0, screen: 0 } }
    for (const segment of segments) {
        usage.bytes += segment.bytes
        usage.bytesByKind[segment.kind] += segment.bytes
    }
    return usage
}

const getUsage = () => withTransaction([SEGMENTS], 'readonly', usageIn)

// 録画中の区間は5分ごとに区切られ、数秒ごとに書き込まれるので、これだけ書き込みのない区間は録画を終えている
const STALE_SEGMENT_IDLE_MS = 5 * 60 * 1000

// 録画していたタブが閉じられるなどして、終えられないまま残った区間を確定する
// 最後の書き込み（録った時刻と、保存先に書き込んだ時刻の新しい方）から idleMs 以上たったものが対象。
// 断片が1つもなければ消す。消した区間の ID を返す
const closeStaleSegments = (idleMs: number, now = Date.now()) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx) => {
    const deletedSegmentIds: string[] = []
    for (const segment of await promisify<SegmentRecord[]>(tx.objectStore(SEGMENTS).getAll())) {
        if (segment.endedAt !== null || now - Math.max(lastWriteOf(segment), segment.updatedAt ?? 0) < idleMs) continue
        if (await closeSegmentIn(tx, segment)) deletedSegmentIds.push(segment.segmentId)
    }
    return deletedSegmentIds
})

// 録画していたページが閉じられて、確定できなかった区間を、最後に書き込んだ所で確定する
// （ページを閉じる時に、content script から background に頼まれる。確定済み・ない区間は何もしない）
const closeSegments = (segmentIds: string[]) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx) => {
    for (const segmentId of segmentIds) {
        const segment = await promisify<SegmentRecord | undefined>(tx.objectStore(SEGMENTS).get(segmentId))
        if (segment && segment.endedAt === null) await closeSegmentIn(tx, segment)
    }
})

// 区間を最後に書き込んだ所で確定する。断片が1つもなければ消す（消したら true）
const closeSegmentIn = async (tx: IDBTransaction, segment: SegmentRecord) => {
    if (segment.fragmentCount <= 0) {
        await promisify(tx.objectStore(FRAGMENTS).delete(fragmentRange(segment.segmentId)))
        await promisify(tx.objectStore(SEGMENTS).delete(segment.segmentId))
        return true
    }
    segment.endedAt = lastWriteOf(segment)
    await promisify(tx.objectStore(SEGMENTS).put(segment))
    return false
}

// 録った時刻の古い断片から、合計 bytesToFree バイト以上を消す
// 断片がなくなった区間は消す（録画中の区間は、続きの断片が届くので残す）。
// opaque の区間は途中から再生できないので、区間ごと消す（録画中のものは書き込み中なので消さない）。
// 区間ごと消えた区間の ID を返す
const freeSpace = (bytesToFree: number) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', tx => freeSpaceIn(tx, bytesToFree))

const freeSpaceIn = async (tx: IDBTransaction, bytesToFree: number) => {
    const segmentStore = tx.objectStore(SEGMENTS)
    const fragmentStore = tx.objectStore(FRAGMENTS)
    const touched = new Map<string, SegmentRecord | null>() // null: 区間ごと消した
    let freed = 0

    const request = fragmentStore.index('wallClock').openCursor()
    await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error)
        request.onsuccess = async () => {
            const cursor = request.result
            if (!cursor || freed >= bytesToFree) return resolve()
            try {
                const fragment = cursor.value as FragmentRecord
                let segment = touched.get(fragment.segmentId)
                if (segment === undefined) {
                    segment = await promisify<SegmentRecord | undefined>(segmentStore.get(fragment.segmentId)) ?? null
                    touched.set(fragment.segmentId, segment)
                }
                if (segment === null) {
                    // 区間ごと消した区間の残りの断片
                    await promisify(fragmentStore.delete([fragment.segmentId, fragment.index]))
                } else if (segment.format === 'opaque') {
                    if (segment.endedAt === null) return cursor.continue()
                    freed += segment.bytes
                    await promisify(fragmentStore.delete(fragmentRange(segment.segmentId)))
                    await promisify(segmentStore.delete(segment.segmentId))
                    touched.set(segment.segmentId, null)
                } else {
                    await promisify(fragmentStore.delete([fragment.segmentId, fragment.index]))
                    freed += fragment.blob.size
                    segment.bytes -= fragment.blob.size
                    segment.fragmentCount -= 1
                }
                cursor.continue()
            } catch (error) {
                reject(error)
            }
        }
    })

    const deletedSegmentIds: string[] = []
    for (const [segmentId, segment] of touched) {
        if (segment === null) {
            deletedSegmentIds.push(segmentId)
        } else if (segment.fragmentCount <= 0 && segment.endedAt !== null) {
            await promisify(segmentStore.delete(segmentId))
            deletedSegmentIds.push(segmentId)
        } else {
            await promisify(segmentStore.put(segment))
        }
    }
    return { freed, deletedSegmentIds }
}

// 合計が maxBytes を超えていたら、超えた分だけ古い断片から消す
// （合計を数えるのと消すのを同じトランザクションで行う。複数のタブが同時に消すと、消しすぎるため）
const enforceLimit = (maxBytes: number) => withTransaction([SEGMENTS, FRAGMENTS], 'readwrite', async (tx) => {
    const { bytes } = await usageIn(tx)
    if (bytes <= maxBytes) return { freed: 0, deletedSegmentIds: [] as string[] }
    return freeSpaceIn(tx, bytes - maxBytes)
})

export {
    openLibraryDB,
    createSegment,
    setSegmentInit,
    appendFragments,
    finishSegment,
    deleteSegments,
    getTimeline,
    getTimelineForSegments,
    getFragmentBlobs,
    listAllSegments,
    buildDownloadFiles,
    getInitSignatures,
    clearAll,
    getUsage,
    closeStaleSegments,
    closeSegments,
    STALE_SEGMENT_IDLE_MS,
    freeSpace,
    enforceLimit,
    SegmentNotFoundError,
}
export type { RecordingKind, SegmentFormat, SegmentRecord, FragmentRecord, NewSegment, NewFragment, SegmentSummary, Usage, TimelineSegment, TimelineFragment, DownloadFile }
