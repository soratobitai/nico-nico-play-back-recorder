// 以前のバージョンの録画（ニコ生のサイトデータに保存していたもの）を、拡張機能側の保存先へ移す
// 自動では移さない（移した録画が容量の上限で消えないよう、録画一覧で上限を確かめてから、手動で取り込む）
// 1本ずつ移し、送ったとおりに保存されたのを確かめてから、以前の保存先から消す（確かめられなければ残す）
import { hasLegacyDatabase, getAllChunks, deleteChunkByKeys, deleteLegacyDatabase, closeLegacyDatabase, type ChunkRecord } from '../../hooks/indexedDB/recordingDB'
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
// MP4 として読めない録画を、分けて送る大きさ（長い録画を一度に送って、時間内に保存し終えられないことがないように）
const OPAQUE_PART_BYTES = 64 * 1024 * 1024
// 古いバージョンのスクリプトがまだ録画中かもしれない一時データには触らない
const ACTIVE_TEMPS_THRESHOLD_MS = 60 * 1000
// 複数のタブで同時に移さないためのロック（取り込んでいる間は、他のタブで数え直さない）
const MIGRATION_LOCK = 'playback-legacy-migration'
// 以前のバージョンが、録画している間（一時データを書き足している間）に持っていたロック
const legacyRecordingLock = (sessionId: string) => `recording-segment-${sessionId}`

// 移した録画が、送ったとおりには保存されていなかった（容量の上限を超えて、途中が削除された など）
class IncompleteImportError extends Error {
    constructor(segmentId: string) {
        super(`移した録画が、すべては保存されていませんでした: ${segmentId}`)
        this.name = 'IncompleteImportError'
    }
}
// 拡張機能側とやり取りできなくなった（残りも移せないので、やめる）
const isBridgeUnavailable = (error: unknown) => error instanceof Error && error.name === 'BridgeUnavailableError'
const isQuotaExceeded = (error: unknown) => error instanceof Error && error.name === 'QuotaExceededError'

const readHead = async (blob: Blob, start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer())
// webm（EBML）で始まるか
const isWebm = async (blob: Blob) => {
    const head = await readHead(blob, 0, 4)
    return head.length === 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3
}
// 録画ファイルの先頭か（録画処理を始め直すと、ファイルの先頭から書き出す）
const startsNewFile = async (blob: Blob) =>
    String.fromCharCode(...await readHead(blob, 4, 8)) === 'ftyp' || await isWebm(blob)

// 1本の録画を区間として移し、送ったとおりに保存されたかを確かめる（確かめられなければエラー）
// MP4 として読めなければ、そのまま（分けて送り、保存する時に順につなぐ）移す
// segmentId は以前の録画から決める（途中で中断して移し直す時に、途中まで移した区間を置き換えて、2本にしない）
// onSent: 送った大きさ（進み具合を出すため）
const importRecording = async (call: Call, segmentId: string, recording: LegacyRecording, onSent: (bytes: number) => void = () => {}) => {
    const { blob } = recording
    const mimeType = blob.type || (await isWebm(blob) ? 'video/webm' : 'video/mp4')
    const parsed = isMp4MimeType(mimeType) ? await splitFmp4Blob(blob).catch(() => null) : null
    // 断片が1つもない MP4（断片に分かれていない MP4 など）は、そのまま移す
    const fmp4 = parsed && parsed.fragments.length > 0 ? parsed : null
    const fragments = fmp4?.fragments ?? []

    const firstStart = fragments[0]?.startTime ?? 0
    const duration = fragments.reduce((end, f) => Math.max(end, f.startTime + f.duration), firstStart) - firstStart
    const startedAt = recording.startedAt ?? (recording.endedAt ?? Date.now()) - duration * 1000
    const endedAt = recording.endedAt ?? startedAt + duration * 1000

    await call({ type: 'deleteSegments', segmentIds: [segmentId] })
    await call({
        type: 'createSegment',
        segment: {
            segmentId, programId: 'legacy', kind: 'video', format: fmp4 ? 'fmp4' : 'opaque', mimeType,
            title: recording.title, userName: recording.userName, startedAt, thumbnail: recording.thumbnail,
        },
    })
    let expected: { count: number, bytes: number }
    if (fmp4) {
        await call({ type: 'setSegmentInit', segmentId, init: fmp4.init })
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
        expected = { count: fragments.length, bytes: fragments.reduce((sum, f) => sum + f.blob.size, fmp4.init.size) }
    } else {
        let count = 0
        for (let start = 0; start < blob.size; start += OPAQUE_PART_BYTES) {
            const part = blob.slice(start, start + OPAQUE_PART_BYTES)
            await call({
                type: 'appendFragments',
                segmentId,
                fragments: [{ index: count++, blob: part, moofSize: 0, startTime: 0, duration, wallClock: startedAt }],
            })
            onSent(part.size)
        }
        expected = { count, bytes: blob.size }
    }
    const saved = await call({ type: 'finishSegment', segmentId, endedAt })
    if (!saved || saved.fragmentCount !== expected.count || saved.bytes !== expected.bytes) throw new IncompleteImportError(segmentId)
}

// 移す録画（1本ずつ）。移し終えたら、以前の保存先から消す（remove）
type LegacyItem = { segmentId: string, recording: LegacyRecording, bytes: number, remove: () => Promise<void> }

// 一時データを、録画処理を始め直したところ（ファイルの先頭から始まる一時データ）で分ける
// （以前のバージョンの中には、タブごとに同じ録画の番号を使い続けたものがあり、別の録画の一時データが混ざることがある）
const splitTempsRuns = async (group: ChunkRecord[]) => {
    const runs: ChunkRecord[][] = []
    for (const temp of group) {
        if (runs.length === 0 || await startsNewFile(temp.blob)) runs.push([temp])
        else runs[runs.length - 1].push(temp)
    }
    return runs
}

const hasData = (record: ChunkRecord) => record.blob instanceof Blob && record.blob.size > 0

// 以前の保存先にある録画を、移す単位に並べる（中身のない記録は入れない。以前の保存先を消す時に一緒に消える）
// 古いバージョンがまだ録画中かもしれない一時データは入れない（activeTempsLeft。以前の保存先も残す）
const planLegacyItems = async () => {
    const items: LegacyItem[] = []
    const held = new Set(((await navigator.locks?.query?.())?.held ?? []).map(lock => lock.name))
    const now = Date.now()

    // 結合されないまま残った一時データは、録画処理ごとにつないで1本として移す
    const groups = new Map<string, ChunkRecord[]>()
    for (const temp of await getAllChunks('Temps')) {
        if (hasData(temp)) groups.set(temp.sessionId, [...(groups.get(temp.sessionId) ?? []), temp])
    }
    let activeTempsLeft = false
    for (const group of groups.values()) {
        group.sort((a, b) => a.chunkIndex - b.chunkIndex)
        const last = group[group.length - 1]
        // 最近書き足された（時刻が先のものは、PC の時計がずれていたものとして古いとみなす）・録画している印がある
        const recent = last.createdAt <= now && now - last.createdAt < ACTIVE_TEMPS_THRESHOLD_MS
        if (recent || held.has(legacyRecordingLock(last.sessionId))) {
            activeTempsLeft = true
            continue
        }
        for (const run of await splitTempsRuns(group)) {
            const blob = new Blob(run.map(t => t.blob), { type: run[0].blob.type })
            items.push({
                // 古いバージョンの録画処理が長く止まってから続きを録った場合、続きは別の録画として移す（最初の番号で見分ける）
                segmentId: `legacy-temps-${run[0].sessionId}-${run[0].chunkIndex}`,
                recording: {
                    blob, title: run[0].title ?? '', userName: run[0].userName ?? '', thumbnail: null,
                    startedAt: run[0].createdAt, endedAt: run[run.length - 1].createdAt,
                },
                bytes: blob.size,
                remove: () => deleteChunkByKeys('Temps', run.map(t => [t.sessionId, t.chunkIndex])),
            })
        }
    }

    for (const chunk of await getAllChunks('Chunks')) {
        if (!hasData(chunk)) continue
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

type LegacySummary = { count: number, bytes: number }
const summarize = (items: LegacyItem[]): LegacySummary | null =>
    items.length > 0 ? { count: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0) } : null

// 以前の保存先にある録画の数と大きさ（なければ null）。数えたら接続を閉じる
// （ニコ生のどのタブでも数えるので、接続を持ち続けると、取り込んだ後に保存先を消す時に待たされる）
const summarizeLegacyRecordings = async (): Promise<LegacySummary | null> => {
    if (!(await hasLegacyDatabase())) return null
    try {
        return summarize((await planLegacyItems()).items)
    } finally {
        await closeLegacyDatabase()
    }
}

// どこかのタブで取り込んでいる最中か
const isImporting = async () => !!(await navigator.locks?.query?.())?.held?.some(lock => lock.name === MIGRATION_LOCK)

// 取り込んでいない時だけ数える（取り込んでいる間に数えると、取り込み終えた後に古い数で上書きしてしまうので）。
// 取り込んでいて数えなかった時は undefined
const countLegacyRecordingsUnlessImporting = async (): Promise<LegacySummary | null | undefined> => {
    if (await isImporting()) return undefined
    const summary = await summarizeLegacyRecordings()
    return await isImporting() ? undefined : summary
}

type LegacyImportProgress = {
    done: number // 移し終えた（移せなかったものも含む）本数
    total: number
    bytesDone: number
    bytesTotal: number
    title: string // 移している録画
}
type LegacyImportOptions = {
    onProgress?: (progress: LegacyImportProgress) => void
    // やめるように言われた（移している1本を移し終えてから、やめる）
    isCancelled?: () => boolean
    // この大きさの録画を、容量の上限を超えずに移せるか（移せなければ、残りは移さずに以前の保存先に残す）
    canFit?: (bytes: number) => Promise<boolean>
    // 1本移すたびに、以前の保存先に残っている録画（移せなかったものも含む）
    onRemaining?: (remaining: LegacySummary | null) => void
}
// failed: 移せなかった（以前の保存先に残した）本数。full: 容量の上限に達したので、残りを移さなかった
// remaining: 取り込まずに残った録画（取り込み終えた後に数え直したもの。なければ null）
type LegacyImportResult = { migrated: number, failed: number, cancelled: boolean, full: boolean, busy: boolean, remaining: LegacySummary | null }

const migrate = async (call: Call, { onProgress, isCancelled, canFit, onRemaining }: LegacyImportOptions): Promise<LegacyImportResult> => {
    const { items, activeTempsLeft } = await planLegacyItems()
    const progress: LegacyImportProgress = {
        done: 0, total: items.length, bytesDone: 0, bytesTotal: items.reduce((sum, item) => sum + item.bytes, 0), title: '',
    }
    onProgress?.({ ...progress })
    let migrated = 0
    const failed: LegacyItem[] = []
    let cancelled = false
    let full = false
    for (const [i, item] of items.entries()) {
        if (isCancelled?.()) {
            cancelled = true
            break
        }
        if (canFit && !(await canFit(item.bytes))) {
            full = true
            break
        }
        progress.title = item.recording.title
        onProgress?.({ ...progress })
        const before = progress.bytesDone
        try {
            await importRecording(call, item.segmentId, item.recording, (bytes) => {
                progress.bytesDone = Math.min(before + item.bytes, progress.bytesDone + bytes)
                onProgress?.({ ...progress })
            })
            await item.remove()
            migrated++
        } catch (error) {
            if (isBridgeUnavailable(error)) throw error
            // 移せなかった録画は以前の保存先に残し、途中まで移した分は消す（もう一度取り込むと、移し直す）
            await call({ type: 'deleteSegments', segmentIds: [item.segmentId] }).catch(() => {})
            if (isQuotaExceeded(error)) {
                full = true
                break
            }
            console.error('以前の録画を1本移せませんでした（以前の保存先に残します）:', error)
            failed.push(item)
        }
        progress.done++
        progress.bytesDone = before + item.bytes
        onProgress?.({ ...progress })
        onRemaining?.(summarize([...failed, ...items.slice(i + 1)]))
    }

    // 残っているものを数え直す（取り込んでいる間に、古いバージョンが書き足した録画も残す）。
    // 何も残っていなければ、以前の保存先を消す（消した後に開き直すと、他のタブの接続で待たされることがあるので、残りはここで返す）
    const left = await planLegacyItems()
    const remaining = summarize(left.items)
    if (!cancelled && !full && !remaining && !left.activeTempsLeft && !activeTempsLeft) await deleteLegacyDatabase()
    else await closeLegacyDatabase()
    return { migrated, failed: failed.length, cancelled, full, busy: false, remaining }
}

// 以前の録画を移す。移すものがなければ何もしない。他のタブで移している最中なら busy
// call は拡張機能側に直接保存するもの（一時保存に回すと、移したつもりで消してしまうため）
const importLegacyRecordings = async (call: Call, options: LegacyImportOptions = {}): Promise<LegacyImportResult> => {
    const none = { migrated: 0, failed: 0, cancelled: false, full: false, busy: false, remaining: null }
    if (!(await hasLegacyDatabase())) return none
    // 複数のタブで同時に移さない（同じ録画が2本になる）
    if (!navigator.locks) return migrate(call, options)
    return navigator.locks.request(MIGRATION_LOCK, { ifAvailable: true },
        lock => lock ? migrate(call, options) : { ...none, busy: true })
}

// 以前の録画を移して、移した数を返す
const migrateLegacyRecordings = async (call: Call, options: LegacyImportOptions = {}) => (await importLegacyRecordings(call, options)).migrated

export { migrateLegacyRecordings, importLegacyRecordings, summarizeLegacyRecordings, countLegacyRecordingsUnlessImporting }
export type { LegacyImportProgress, LegacyImportResult, LegacySummary }
