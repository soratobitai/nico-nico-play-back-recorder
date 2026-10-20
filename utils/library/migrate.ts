// 以前のバージョンの録画（ニコ生のサイトデータに保存していたもの）を、拡張機能側の保存先へ移す
// 自動では移さない（移した録画が容量の上限で消えないよう、録画一覧で上限を確かめてから、手動で取り込む）
import { hasLegacyDatabase, getAllChunks, deleteChunkByKeys, deleteLegacyDatabase, type ChunkRecord } from '../../hooks/indexedDB/recordingDB'
import { splitFmp4Blob, isMp4MimeType } from '../fmp4'
import type { BridgeRequestOf, BridgeRequestType, BridgeResults } from './protocol'

type Call = <T extends BridgeRequestType>(request: BridgeRequestOf<T>) => Promise<BridgeResults[T]>

type LegacyRecording = {
    blob: Blob
    title: string
    userName: string
    thumbnail: string | null
    startedAt?: number
    endedAt?: number
}

// 1回の依頼で送る断片の数（大きくなりすぎないように）
const FRAGMENTS_PER_REQUEST = 30
// 古いバージョンのスクリプトがまだ録画中かもしれない一時データには触らない
const ACTIVE_TEMPS_THRESHOLD_MS = 60 * 1000

// 1本の録画を区間として移す。MP4 として読めなければ、そのまま1つの断片として移す
// segmentId は以前の録画から決める（途中で中断して移し直す時に、途中まで移した区間を置き換えて、2本にしない）
// onSent: 送った大きさ（進み具合を出すため）
const importRecording = async (call: Call, segmentId: string, recording: LegacyRecording, onSent: (bytes: number) => void = () => {}) => {
    const mimeType = recording.blob.type || 'video/mp4'
    const parsed = isMp4MimeType(mimeType) ? await splitFmp4Blob(recording.blob).catch(() => null) : null
    const fragments = parsed?.fragments ?? []

    const firstStart = fragments[0]?.startTime ?? 0
    const duration = fragments.length ? Math.max(...fragments.map(f => f.startTime + f.duration)) - firstStart : 0
    const startedAt = recording.startedAt ?? (recording.endedAt ?? Date.now()) - duration * 1000
    const endedAt = recording.endedAt ?? startedAt + duration * 1000

    await call({ type: 'deleteSegments', segmentIds: [segmentId] })
    await call({
        type: 'createSegment',
        segment: {
            segmentId, programId: 'legacy', kind: 'video', format: parsed ? 'fmp4' : 'opaque', mimeType,
            title: recording.title, userName: recording.userName, startedAt, thumbnail: recording.thumbnail,
        },
    })
    if (parsed) {
        await call({ type: 'setSegmentInit', segmentId, init: parsed.init })
        for (let i = 0; i < fragments.length; i += FRAGMENTS_PER_REQUEST) {
            const batch = fragments.slice(i, i + FRAGMENTS_PER_REQUEST)
            await call({
                type: 'appendFragments',
                segmentId,
                fragments: batch.map((f, j) => ({
                    index: i + j, blob: f.blob, moofSize: f.moofSize, startTime: f.startTime, duration: f.duration, keyframe: f.keyframe,
                    wallClock: startedAt + (f.startTime - firstStart) * 1000,
                })),
            })
            onSent(batch.reduce((sum, f) => sum + f.blob.size, 0))
        }
    } else {
        await call({
            type: 'appendFragments',
            segmentId,
            fragments: [{ index: 0, blob: recording.blob, moofSize: 0, startTime: 0, duration, wallClock: startedAt }],
        })
        onSent(recording.blob.size)
    }
    await call({ type: 'finishSegment', segmentId, endedAt })
}

// 移す録画（1本ずつ）。移し終えたら、以前の保存先から消す（remove）
type LegacyItem = { segmentId: string, recording: LegacyRecording, bytes: number, remove: () => Promise<void> }

// 以前の保存先にある録画を、移す単位に並べる
// 古いバージョンがまだ録画中かもしれない一時データは入れない（activeTempsLeft。以前の保存先も残す）
const planLegacyItems = async () => {
    const items: LegacyItem[] = []

    // 結合されないまま残った一時データは、録画処理ごとにつないで1本として移す
    const groups = new Map<string, ChunkRecord[]>()
    for (const temp of await getAllChunks('Temps')) {
        groups.set(temp.sessionId, [...(groups.get(temp.sessionId) ?? []), temp])
    }
    let activeTempsLeft = false
    for (const group of groups.values()) {
        group.sort((a, b) => a.chunkIndex - b.chunkIndex)
        const last = group[group.length - 1]
        if (Date.now() - last.createdAt < ACTIVE_TEMPS_THRESHOLD_MS) {
            activeTempsLeft = true
            continue
        }
        const blob = new Blob(group.map(t => t.blob), { type: group[0].blob.type || 'video/mp4' })
        items.push({
            // 古いバージョンの録画処理が長く止まってから続きを録った場合、続きは別の録画として移す（最初の番号で見分ける）
            segmentId: `legacy-temps-${group[0].sessionId}-${group[0].chunkIndex}`,
            recording: {
                blob, title: group[0].title ?? '', userName: group[0].userName ?? '', thumbnail: null,
                startedAt: group[0].createdAt, endedAt: last.createdAt,
            },
            bytes: blob.size,
            remove: () => deleteChunkByKeys('Temps', group.map(t => [t.sessionId, t.chunkIndex])),
        })
    }

    for (const chunk of await getAllChunks('Chunks')) {
        items.push({
            segmentId: `legacy-${chunk.sessionId}-${chunk.chunkIndex}`,
            recording: {
                blob: chunk.blob, title: chunk.title ?? '', userName: chunk.userName ?? '',
                thumbnail: chunk.imgUrl, endedAt: chunk.createdAt,
            },
            bytes: chunk.blob.size,
            remove: () => deleteChunkByKeys('Chunks', [[chunk.sessionId, chunk.chunkIndex]]),
        })
    }
    return { items, activeTempsLeft }
}

// 以前の保存先にある録画の数と大きさ（以前の保存先がなければ null）
const summarizeLegacyRecordings = async (): Promise<{ count: number, bytes: number } | null> => {
    if (!(await hasLegacyDatabase())) return null
    const { items } = await planLegacyItems()
    return { count: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0) }
}

type LegacyImportProgress = {
    done: number // 移し終えた本数
    total: number
    bytesDone: number
    bytesTotal: number
    title: string // 移している録画
}
type LegacyImportOptions = {
    onProgress?: (progress: LegacyImportProgress) => void
    // やめるように言われた（移している1本を移し終えてから、やめる）
    isCancelled?: () => boolean
}
type LegacyImportResult = { migrated: number, cancelled: boolean, busy: boolean }

const migrate = async (call: Call, { onProgress, isCancelled }: LegacyImportOptions): Promise<LegacyImportResult> => {
    const { items, activeTempsLeft } = await planLegacyItems()
    const progress: LegacyImportProgress = {
        done: 0, total: items.length, bytesDone: 0, bytesTotal: items.reduce((sum, item) => sum + item.bytes, 0), title: '',
    }
    onProgress?.({ ...progress })
    for (const item of items) {
        if (isCancelled?.()) return { migrated: progress.done, cancelled: true, busy: false }
        progress.title = item.recording.title
        onProgress?.({ ...progress })
        const before = progress.bytesDone
        await importRecording(call, item.segmentId, item.recording, (bytes) => {
            progress.bytesDone = Math.min(before + item.bytes, progress.bytesDone + bytes)
            onProgress?.({ ...progress })
        })
        await item.remove()
        progress.done++
        progress.bytesDone = before + item.bytes
        onProgress?.({ ...progress })
    }

    // すべて移せたら、以前の保存先を消す
    if (!activeTempsLeft) await deleteLegacyDatabase()
    return { migrated: progress.done, cancelled: false, busy: false }
}

// 以前の録画を移す。移すものがなければ何もしない。他のタブで移している最中なら busy
// call は拡張機能側に直接保存するもの（一時保存に回すと、移したつもりで消してしまうため）
const importLegacyRecordings = async (call: Call, options: LegacyImportOptions = {}): Promise<LegacyImportResult> => {
    if (!(await hasLegacyDatabase())) return { migrated: 0, cancelled: false, busy: false }
    // 複数のタブで同時に移さない（同じ録画が2本になる）
    if (!navigator.locks) return migrate(call, options)
    return navigator.locks.request('playback-legacy-migration', { ifAvailable: true },
        lock => lock ? migrate(call, options) : { migrated: 0, cancelled: false, busy: true })
}

// 以前の録画を移して、移した数を返す
const migrateLegacyRecordings = async (call: Call, options: LegacyImportOptions = {}) => (await importLegacyRecordings(call, options)).migrated

export { migrateLegacyRecordings, importLegacyRecordings, summarizeLegacyRecordings }
export type { LegacyImportProgress, LegacyImportResult }
