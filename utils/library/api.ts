// ニコ生のページ（content script）から録画の保存先を使うための関数
// 実際の保存先は拡張機能側（bridge 経由）。録画中の書き込みは、拡張機能側に保存できない間は
// ニコ生側に一時保存して録画を続け、次にページを開いた時に移す（flushPending）。
import { getBridge, BridgeUnavailableError } from './client'
import { savePendingRequest, flushPendingRequests } from './pending'
import { migrateLegacyRecordings } from './migrate'
import { WRITE_REQUEST_TYPES, type BridgeRequestOf, type BridgeRequestType, type BridgeResults } from './protocol'
import type { NewSegment, NewFragment } from './db'

const callLibrary = async <T extends BridgeRequestType>(request: BridgeRequestOf<T>): Promise<BridgeResults[T]> => {
    try {
        const bridge = await getBridge()
        return await bridge.call(request)
    } catch (error) {
        if (error instanceof BridgeUnavailableError && WRITE_REQUEST_TYPES.has(request.type)) {
            console.log('拡張機能側に保存できないため、一時保存します:', request.type)
            await savePendingRequest(request)
            return (request.type === 'finishSegment' ? null : undefined) as BridgeResults[T]
        }
        throw error
    }
}

const createSegment = (segment: NewSegment) => callLibrary({ type: 'createSegment', segment })
const setSegmentInit = (segmentId: string, init: Blob) => callLibrary({ type: 'setSegmentInit', segmentId, init })
const appendFragments = (segmentId: string, fragments: NewFragment[]) => callLibrary({ type: 'appendFragments', segmentId, fragments })
const finishSegment = (segmentId: string, endedAt: number, mimeType?: string) => callLibrary({ type: 'finishSegment', segmentId, endedAt, mimeType })
const listSegments = (limit: number, before?: number) => callLibrary({ type: 'listSegments', limit, before })
const countSegments = () => callLibrary({ type: 'countSegments' })
const getSegmentFile = (segmentId: string) => callLibrary({ type: 'getSegmentFile', segmentId })
const deleteSegments = (segmentIds: string[]) => callLibrary({ type: 'deleteSegments', segmentIds })
const getUsage = () => callLibrary({ type: 'getUsage' })
const enforceLimit = (maxBytes: number) => callLibrary({ type: 'enforceLimit', maxBytes })
const freeSpace = (bytes: number) => callLibrary({ type: 'freeSpace', bytes })
const closeStaleSegments = (idleMs: number) => callLibrary({ type: 'closeStaleSegments', idleMs })
const clearAll = () => callLibrary({ type: 'clearAll' })
const estimateStorage = () => callLibrary({ type: 'estimateStorage' })

// 一時保存した書き込みを拡張機能側へ移す
const flushPending = () => flushPendingRequests(
    async (request) => (await getBridge()).call(request),
    error => error instanceof BridgeUnavailableError,
)

// 以前のバージョンの録画（ニコ生のサイトデータに保存していたもの）を拡張機能側へ移す
// 移した録画を確実に拡張機能側に置くため、一時保存には回さずに直接送る
const migrateLegacy = () => migrateLegacyRecordings(async (request) => (await getBridge()).call(request))

export {
    createSegment, setSegmentInit, appendFragments, finishSegment,
    listSegments, countSegments, getSegmentFile, deleteSegments,
    getUsage, enforceLimit, freeSpace, closeStaleSegments, clearAll, estimateStorage, flushPending, migrateLegacy,
}
