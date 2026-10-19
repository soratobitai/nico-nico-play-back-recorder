// 以前のバージョンの録画（ニコ生のサイトデータに保存していたもの）を、拡張機能側の保存先へ移す
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
const importRecording = async (call: Call, recording: LegacyRecording) => {
    const mimeType = recording.blob.type || 'video/mp4'
    const parsed = isMp4MimeType(mimeType) ? await splitFmp4Blob(recording.blob).catch(() => null) : null
    const fragments = parsed?.fragments ?? []

    const firstStart = fragments[0]?.startTime ?? 0
    const duration = fragments.length ? Math.max(...fragments.map(f => f.startTime + f.duration)) - firstStart : 0
    const startedAt = recording.startedAt ?? (recording.endedAt ?? Date.now()) - duration * 1000
    const endedAt = recording.endedAt ?? startedAt + duration * 1000
    const segmentId = crypto.randomUUID()

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
            await call({
                type: 'appendFragments',
                segmentId,
                fragments: fragments.slice(i, i + FRAGMENTS_PER_REQUEST).map((f, j) => ({
                    index: i + j, blob: f.blob, moofSize: f.moofSize, startTime: f.startTime, duration: f.duration, keyframe: f.keyframe,
                    wallClock: startedAt + (f.startTime - firstStart) * 1000,
                })),
            })
        }
    } else {
        await call({
            type: 'appendFragments',
            segmentId,
            fragments: [{ index: 0, blob: recording.blob, moofSize: 0, startTime: 0, duration, wallClock: startedAt }],
        })
    }
    await call({ type: 'finishSegment', segmentId, endedAt })
}

const migrate = async (call: Call) => {
    let migrated = 0

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
        await importRecording(call, {
            blob: new Blob(group.map(t => t.blob), { type: group[0].blob.type || 'video/mp4' }),
            title: group[0].title ?? '', userName: group[0].userName ?? '', thumbnail: null,
            startedAt: group[0].createdAt, endedAt: last.createdAt,
        })
        await deleteChunkByKeys('Temps', group.map(t => [t.sessionId, t.chunkIndex]))
        migrated++
    }

    for (const chunk of await getAllChunks('Chunks')) {
        await importRecording(call, {
            blob: chunk.blob, title: chunk.title ?? '', userName: chunk.userName ?? '',
            thumbnail: chunk.imgUrl, endedAt: chunk.createdAt,
        })
        await deleteChunkByKeys('Chunks', [[chunk.sessionId, chunk.chunkIndex]])
        migrated++
    }

    // すべて移せたら、以前の保存先を消す
    if (!activeTempsLeft) await deleteLegacyDatabase()
    return migrated
}

// 以前の録画を移す。移した数を返す（移すものがない・他のタブで移している最中なら 0）
// call は拡張機能側に直接保存するもの（一時保存に回すと、移したつもりで消してしまうため）
const migrateLegacyRecordings = async (call: Call): Promise<number> => {
    if (!(await hasLegacyDatabase())) return 0
    // 複数のタブで同時に移さない（同じ録画が2本になる）
    if (!navigator.locks) return migrate(call)
    return navigator.locks.request('playback-legacy-migration', { ifAvailable: true }, lock => lock ? migrate(call) : 0)
}

export { migrateLegacyRecordings }
