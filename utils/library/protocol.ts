// ニコ生のページ（content script）と、拡張機能側の保存先（bridge）とのやり取りの決まり
import type { NewSegment, NewFragment, SegmentSummary, Usage, TimelineSegment } from './db'

type BridgeRequest =
    | { type: 'createSegment', segment: NewSegment }
    | { type: 'setSegmentInit', segmentId: string, init: Blob }
    | { type: 'appendFragments', segmentId: string, fragments: NewFragment[] }
    | { type: 'finishSegment', segmentId: string, endedAt: number, mimeType?: string }
    | { type: 'getTimeline', programId: string }
    | { type: 'getFragmentBlobs', segmentId: string, indexes: number[] }
    | { type: 'getUsage' }
    | { type: 'enforceLimit', maxBytes: number }
    | { type: 'freeSpace', bytes: number }
    | { type: 'closeStaleSegments', idleMs: number }
    | { type: 'clearAll' }
    | { type: 'deleteSegments', segmentIds: string[] }
    | { type: 'estimateStorage' }

type DeletedSpace = { freed: number, deletedSegmentIds: string[] }

type BridgeResults = {
    createSegment: void
    setSegmentInit: void
    appendFragments: void
    finishSegment: SegmentSummary | null
    getTimeline: TimelineSegment[]
    getFragmentBlobs: (Blob | null)[]
    getUsage: Usage
    enforceLimit: DeletedSpace
    freeSpace: DeletedSpace
    closeStaleSegments: string[]
    clearAll: number // 残した録画中の区間の数
    deleteSegments: void
    estimateStorage: { usage?: number, quota?: number }
}

type BridgeRequestType = BridgeRequest['type']
type BridgeRequestOf<T extends BridgeRequestType> = Extract<BridgeRequest, { type: T }>

// 録画中の書き込み（拡張機能側に保存できない間は、ニコ生側に一時保存してあとで移す）
// 録り始めてすぐの区間を残さずに消す依頼も含める（その区間を一時保存していたら、移した後に消えるように）
const WRITE_REQUEST_TYPES: ReadonlySet<BridgeRequestType> = new Set(['createSegment', 'setSegmentInit', 'appendFragments', 'finishSegment', 'deleteSegments'])

// content script → background: ページを閉じる時に、まだ確定していない区間を確定してもらう
const CLOSE_SEGMENTS_MESSAGE = 'playback:close-segments'

// content script → background: bridge を使うための合言葉をもらう
const BRIDGE_TOKEN_MESSAGE = 'playback-bridge:token'
// 合言葉を置く場所（chrome.storage.session。拡張機能のページと background だけが読める）
const BRIDGE_TOKEN_KEY = 'bridgeToken'
// content script → bridge: 合言葉と、以後のやり取りに使う MessagePort を渡す
const BRIDGE_INIT_MESSAGE = 'playback-bridge:init'

type BridgeEnvelope = { id: number, request: BridgeRequest }
type BridgeReply =
    | { id: number, ok: true, result: unknown }
    | { id: number, ok: false, error: { name: string, message: string } }

export { WRITE_REQUEST_TYPES, CLOSE_SEGMENTS_MESSAGE, BRIDGE_TOKEN_MESSAGE, BRIDGE_TOKEN_KEY, BRIDGE_INIT_MESSAGE }
export type { BridgeRequest, BridgeResults, BridgeRequestType, BridgeRequestOf, BridgeEnvelope, BridgeReply, DeletedSpace }
