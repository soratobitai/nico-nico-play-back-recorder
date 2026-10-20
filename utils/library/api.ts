// ニコ生のページ（content script）から録画の保存先を使うための関数
// 実際の保存先は拡張機能側（bridge 経由）。録画中の書き込みは、拡張機能側に保存できない間は
// ニコ生側に一時保存して録画を続け、次にページを開いた時に移す（flushPending）。
import { getBridge, BridgeUnavailableError, isExtensionContextValid } from './client'
import { savePendingRequest, flushPendingRequests, clearPendingRequests } from './pending'
import { migrateLegacyRecordings } from './migrate'
import { WRITE_REQUEST_TYPES, type BridgeRequest, type BridgeRequestOf, type BridgeRequestType, type BridgeResults } from './protocol'
import type { NewSegment, NewFragment } from './db'

// 一時保存した区間。続きの書き込みは、一時保存した分を先に拡張機能側へ移してから直接保存する
// （移せなければ、続きも一時保存する。区間を作る依頼だけ一時保存されて、続きが拡張機能側に直接届くと、
//   区間が見つからずに捨てられてしまうため）
const pendingSegments = new Set<string>()
// このページで一時保存した量と、その上限（容量の上限の設定。拡張機能側に移した後で、超えた分は消えるため）
// 拡張機能が更新されると、このページでは拡張機能側に保存できないまま録画が続くので、上限で止める
let pendingBytes = 0
let pendingLimit = Infinity
// 一時保存を始めた回数（移している間に新しく一時保存したものがあれば、移し終えても pendingSegments を空にしない）
let pendingSaves = 0

const setPendingLimit = (bytes: number) => {
    pendingLimit = bytes
}

const segmentIdOf = (request: BridgeRequest) => {
    switch (request.type) {
        case 'createSegment': return request.segment.segmentId
        case 'setSegmentInit':
        case 'appendFragments':
        case 'finishSegment': return request.segmentId
        default: return null
    }
}

const bytesOf = (request: BridgeRequest) => {
    switch (request.type) {
        case 'setSegmentInit': return request.init.size
        case 'appendFragments': return request.fragments.reduce((sum, f) => sum + f.blob.size, 0)
        default: return 0
    }
}

const saveToPending = async <T extends BridgeRequestType>(request: BridgeRequestOf<T>): Promise<BridgeResults[T]> => {
    const bytes = bytesOf(request)
    // 拡張機能が更新された後は、上限を超える分は保存しない（容量不足として扱い、録画を止めてお知らせする）
    // （一時的に bridge が応答しなかっただけなら、次の区間から拡張機能側に戻るので止めない）
    if (bytes > 0 && pendingBytes + bytes > pendingLimit && !isExtensionContextValid()) {
        throw new DOMException('一時保存の上限を超えました', 'QuotaExceededError')
    }
    console.log('拡張機能側に保存できないため、一時保存します:', request.type)
    const segmentId = segmentIdOf(request)
    if (segmentId !== null) pendingSegments.add(segmentId)
    pendingSaves++
    await savePendingRequest(request)
    pendingBytes += bytes
    return (request.type === 'finishSegment' ? null : undefined) as BridgeResults[T]
}

const callLibrary = async <T extends BridgeRequestType>(request: BridgeRequestOf<T>): Promise<BridgeResults[T]> => {
    const isWrite = WRITE_REQUEST_TYPES.has(request.type)
    const segmentId = segmentIdOf(request)
    if (isWrite && segmentId !== null && pendingSegments.has(segmentId)) {
        // 一時保存した分をすべて移せたら（pendingSegments が空になる）、この書き込みは直接保存する
        await flushPending().catch(() => {})
        if (pendingSegments.has(segmentId)) return saveToPending(request)
    }
    try {
        const bridge = await getBridge()
        return await bridge.call(request)
    } catch (error) {
        if (error instanceof BridgeUnavailableError && isWrite) return saveToPending(request)
        throw error
    }
}

const createSegment = (segment: NewSegment) => callLibrary({ type: 'createSegment', segment })
const setSegmentInit = (segmentId: string, init: Blob) => callLibrary({ type: 'setSegmentInit', segmentId, init })
const appendFragments = (segmentId: string, fragments: NewFragment[]) => callLibrary({ type: 'appendFragments', segmentId, fragments })
const finishSegment = (segmentId: string, endedAt: number, mimeType?: string) => callLibrary({ type: 'finishSegment', segmentId, endedAt, mimeType })
const getTimeline = (programId: string) => callLibrary({ type: 'getTimeline', programId })
const getFragmentBlobs = (segmentId: string, indexes: number[]) => callLibrary({ type: 'getFragmentBlobs', segmentId, indexes })
const getUsage = () => callLibrary({ type: 'getUsage' })
const enforceLimit = (maxBytes: number) => callLibrary({ type: 'enforceLimit', maxBytes })
const freeSpace = (bytes: number) => callLibrary({ type: 'freeSpace', bytes })
const closeStaleSegments = (idleMs: number) => callLibrary({ type: 'closeStaleSegments', idleMs })
const deleteSegments = (segmentIds: string[]) => callLibrary({ type: 'deleteSegments', segmentIds })
const estimateStorage = () => callLibrary({ type: 'estimateStorage' })

// すべての録画を削除する（録画中の区間は、続きを書き込めるように中身だけ消す）。一時保存した録画のデータも消す
// 残した録画中の区間の数を返す
const clearAll = async () => {
    const kept = await callLibrary({ type: 'clearAll' })
    await clearPendingRequests()
    return kept
}

// 一時保存した書き込みを拡張機能側へ移す（同時には1つだけ。移した数を返す）
// すべて移せたら、一時保存していた区間の続きは直接保存できる
let flushing: Promise<number> | null = null
const flushPending = (): Promise<number> => flushing ??= (async () => {
    try {
        // 拡張機能が更新された後は移せない（この後も一時保存を続ける）
        if (!isExtensionContextValid()) return 0
        const savesBefore = pendingSaves
        const { sent, complete } = await flushPendingRequests(
            async (request) => (await getBridge()).call(request),
            error => error instanceof BridgeUnavailableError,
        )
        // 移している間に新しく一時保存したものは、まだ移したか分からないので、次の機会に移す
        if (complete && pendingSaves === savesBefore) {
            pendingSegments.clear()
            pendingBytes = 0
        }
        return sent
    } finally {
        flushing = null
    }
})()

// 以前のバージョンの録画（ニコ生のサイトデータに保存していたもの）を拡張機能側へ移す
// 移した録画を確実に拡張機能側に置くため、一時保存には回さずに直接送る
const migrateLegacy = () => migrateLegacyRecordings(async (request) => (await getBridge()).call(request))

export {
    createSegment, setSegmentInit, appendFragments, finishSegment,
    getTimeline, getFragmentBlobs,
    getUsage, enforceLimit, freeSpace, closeStaleSegments, deleteSegments, clearAll, estimateStorage, flushPending, migrateLegacy,
    setPendingLimit,
}
