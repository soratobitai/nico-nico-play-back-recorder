// ニコ生のページ（content script）から録画の保存先を使うための関数
// 実際の保存先は拡張機能側（bridge 経由）。録画中の書き込みは、拡張機能側に保存できない間は
// ニコ生側に一時保存して録画を続け、次にページを開いた時に移す（flushPending）。
import { getBridge, BridgeUnavailableError, isExtensionContextValid } from './client'
import { setPendingSigningKey, savePendingRequest, flushPendingRequests, clearPendingRequests } from './pending'
import { PENDING_SIGNING_KEY } from '../storage'
import { importLegacyRecordings } from './migrate'
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
// 一時保存する量の上限（容量の上限が大きくても。拡張機能が無効にされたままだと、ニコ生側に残り続けるので）
const MAX_PENDING_BYTES = 2 * 1024 * 1024 * 1024
// 一時保存を始めた回数（移している間に新しく一時保存したものがあれば、移し終えても pendingSegments を空にしない）
let pendingSaves = 0

const setPendingLimit = (bytes: number) => {
    pendingLimit = Math.min(bytes, MAX_PENDING_BYTES)
}

// 一時保存に付ける印の鍵を読む（なければ作る）。拡張機能が更新された後も一時保存できるように、ページを開いた時に呼ぶ
// 初めて開いた時に、ニコ生の複数のタブが同時に作って別々の鍵を使わないよう、ロックを取って作る
// （別の鍵で印を付けた一時保存は、他のタブで移す時に捨てられてしまう）
const readOrCreateSigningKey = async () => {
    const saved = await PENDING_SIGNING_KEY.getValue()
    if (saved) return saved
    const raw = crypto.getRandomValues(new Uint8Array(32))
    await PENDING_SIGNING_KEY.setValue(btoa(String.fromCharCode(...raw)))
    return PENDING_SIGNING_KEY.getValue()
}
const initPendingSigning = async () => {
    const encoded = navigator.locks
        ? await navigator.locks.request('playback-pending-signing-key', readOrCreateSigningKey)
        : await readOrCreateSigningKey()
    if (encoded) await setPendingSigningKey(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)))
}

const isQuotaExceeded = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError'
// 容量不足の時に、古い録画を消して空ける量の下限（書き込む量だけ空けても、すぐにまた足りなくなるため）
const MIN_FREE_ON_QUOTA_BYTES = 64 * 1024 * 1024

// このページで一時保存していて、まだ拡張機能側へ移していない区間か
// （ページを閉じる時に、background に確定を頼まない。拡張機能側では断片のない区間として消されてしまい、
//   次に一時保存を移す時に、区間が見つからずに捨てられるため）
const isPendingSegment = (segmentId: string) => pendingSegments.has(segmentId)

const segmentIdsOf = (request: BridgeRequest): string[] => {
    switch (request.type) {
        case 'createSegment': return [request.segment.segmentId]
        case 'setSegmentInit':
        case 'appendFragments':
        case 'finishSegment': return [request.segmentId]
        case 'deleteSegments': return request.segmentIds
        default: return []
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
    for (const segmentId of segmentIdsOf(request)) pendingSegments.add(segmentId)
    pendingSaves++
    await savePendingRequest(request)
    pendingBytes += bytes
    return (request.type === 'finishSegment' ? null : undefined) as BridgeResults[T]
}

const callLibrary = async <T extends BridgeRequestType>(request: BridgeRequestOf<T>): Promise<BridgeResults[T]> => {
    const isWrite = WRITE_REQUEST_TYPES.has(request.type)
    const isPending = () => segmentIdsOf(request).some(segmentId => pendingSegments.has(segmentId))
    if (isWrite && isPending()) {
        // 一時保存した分をすべて移せたら（pendingSegments が空になる）、この書き込みは直接保存する
        await flushPending().catch(() => {})
        if (isPending()) return saveToPending(request)
    }
    try {
        const bridge = await getBridge()
        const result = await bridge.call(request)
        // 拡張機能側に保存できるようになったら、このページで一時保存した分を移す
        // （一時保存した区間に続きの書き込みがなくても、例えば一時保存した「区間を消す依頼」が次にページを開くまで残らないように）
        if (pendingSegments.size > 0) void flushPending().catch(() => {})
        return result
    } catch (error) {
        if (error instanceof BridgeUnavailableError && isWrite) return saveToPending(request)
        throw error
    }
}

const createSegment = (segment: NewSegment) => callLibrary({ type: 'createSegment', segment })
const setSegmentInit = (segmentId: string, init: Blob) => callLibrary({ type: 'setSegmentInit', segmentId, init })
// 受け取った時刻を付ける（一時保存して後で移しても、受け取った時刻のまま。録画一覧で録画中かを決める）
const appendFragments = (segmentId: string, fragments: NewFragment[]) => callLibrary({ type: 'appendFragments', segmentId, fragments, recordedAt: Date.now() })
const finishSegment = (segmentId: string, endedAt: number, mimeType?: string) => callLibrary({ type: 'finishSegment', segmentId, endedAt, mimeType })
const getTimeline = (programId: string) => callLibrary({ type: 'getTimeline', programId })
const getTimelineForSegments = (segmentIds: string[]) => callLibrary({ type: 'getTimelineForSegments', segmentIds })
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

// 一時保存した書き込みを拡張機能側へ移す（同時には1つだけ）。移した数と、残さず移し切れたか（complete）を返す
// （他のタブが移している間・拡張機能側に保存できない間は、移し切れていない）
// すべて移せたら、一時保存していた区間の続きは直接保存できる
let flushing: Promise<{ sent: number, complete: boolean }> | null = null
const flushPending = (): Promise<{ sent: number, complete: boolean }> => flushing ??= (async () => {
    try {
        // 拡張機能が更新された後は移せない（この後も一時保存を続ける）
        if (!isExtensionContextValid()) return { sent: 0, complete: false }
        const savesBefore = pendingSaves
        // 容量不足なら、古い録画を消してから1回だけ送り直す（それでも足りなければ、残りは次の機会に回す）
        const send = async (request: BridgeRequest) => {
            const bridge = await getBridge()
            try {
                return await bridge.call(request)
            } catch (error) {
                if (!isQuotaExceeded(error)) throw error
                const { freed } = await bridge.call({ type: 'freeSpace', bytes: Math.max(bytesOf(request), MIN_FREE_ON_QUOTA_BYTES) })
                if (freed === 0) throw error
                return await bridge.call(request)
            }
        }
        // 捨てるのは、送っても意味がない時だけ（区間が消されていた・同じ区間をもう作ってあった）
        const replay = () => flushPendingRequests({
            send,
            isDiscardable: error => error instanceof Error && (error.name === 'SegmentNotFoundError' || error.name === 'ConstraintError'),
        })
        // 一時保存した分はニコ生のタブで共有しているので、複数のタブで同時に移さない
        // （同じ書き込みを2つのタブが送ると順番が崩れ、例えば消した区間を作り直してしまう）。
        // 他のタブが移している間は、そのタブに任せる（移し終えるまで、このタブの書き込みも一時保存に続ける）
        const { sent, complete } = navigator.locks
            ? await navigator.locks.request('playback-pending-flush', { ifAvailable: true }, lock => lock ? replay() : { sent: 0, complete: false })
            : await replay()
        // 移している間に新しく一時保存したものは、まだ移したか分からないので、次の機会に移す
        if (complete && pendingSaves === savesBefore) {
            pendingSegments.clear()
            pendingBytes = 0
        }
        return { sent, complete }
    } finally {
        flushing = null
    }
})()

// 以前のバージョンの録画（ニコ生のサイトデータに保存していたもの）を拡張機能側へ移す（録画一覧から頼まれた時）
// 移した録画を確実に拡張機能側に置くため、一時保存には回さずに直接送る
const importLegacy = (options?: Parameters<typeof importLegacyRecordings>[1]) =>
    importLegacyRecordings(async (request) => (await getBridge()).call(request), options)

export {
    isPendingSegment,
    createSegment, setSegmentInit, appendFragments, finishSegment,
    getTimeline, getTimelineForSegments, getFragmentBlobs,
    getUsage, enforceLimit, freeSpace, closeStaleSegments, deleteSegments, clearAll, estimateStorage, flushPending, importLegacy,
    setPendingLimit, initPendingSigning,
}
