// bridge（拡張機能側）で、content script からの依頼を保存先の操作につなぐ
import * as db from './db'
import type { BridgeRequest } from './protocol'

const handleBridgeRequest = (request: BridgeRequest): Promise<unknown> => {
    switch (request.type) {
        case 'createSegment': return db.createSegment(request.segment)
        case 'setSegmentInit': return db.setSegmentInit(request.segmentId, request.init)
        case 'appendFragments': return db.appendFragments(request.segmentId, request.fragments)
        case 'finishSegment': return db.finishSegment(request.segmentId, request.endedAt, request.mimeType)
        case 'getTimeline': return db.getTimeline(request.programId)
        case 'getFragmentBlobs': return db.getFragmentBlobs(request.segmentId, request.indexes)
        case 'getUsage': return db.getUsage()
        case 'enforceLimit': return db.enforceLimit(request.maxBytes)
        case 'freeSpace': return db.freeSpace(request.bytes)
        case 'closeStaleSegments': return db.closeStaleSegments(request.idleMs)
        // 録画中の区間は、録画を続けられるように中身だけ消す
        case 'clearAll': return db.clearAll({ keepRecording: true })
        case 'deleteSegments': return db.deleteSegments(request.segmentIds)
        // 拡張機能側の容量（ニコ生のページ側とは別）
        case 'estimateStorage': return navigator.storage.estimate().then(({ usage, quota }) => ({ usage, quota }))
    }
}

export { handleBridgeRequest }
