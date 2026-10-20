// 以前のバージョンの録画（ニコ生のサイトデータに残っているもの）を調べ、録画一覧から頼まれたら取り込む
// ニコ生のどのページでも動く（録画一覧は、取り込むためにトップページを裏で開く）
import { summarizeLegacyRecordings, type LegacyImportProgress } from '@/utils/library/migrate'
import { importLegacy } from '@/utils/library/api'
import { isExtensionContextValid } from '@/utils/library/client'
import { LEGACY_RECORDINGS } from '@/utils/storage'
import {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE, type LegacyImportMessage,
} from '@/utils/library/legacy-import'

// 以前の録画が残っているかを、録画一覧に知らせる（残っていれば、録画一覧で取り込みを勧める）
const reportLegacyRecordings = async () => {
    try {
        const summary = await summarizeLegacyRecordings()
        const next = summary && summary.count > 0 ? summary : null
        const current = await LEGACY_RECORDINGS.getValue()
        if (current?.count !== next?.count || current?.bytes !== next?.bytes) await LEGACY_RECORDINGS.setValue(next)
    } catch (error) {
        console.log('以前の録画を調べられませんでした:', error)
    }
}

const send = (message: LegacyImportMessage) => {
    try {
        chrome.runtime.sendMessage(message).catch(() => {}) // 録画一覧が閉じられていても、取り込みは続ける
    } catch {
        // 拡張機能が更新された
    }
}

export default defineContentScript({
    matches: ['*://live.nicovideo.jp/*'],
    main() {
        void reportLegacyRecordings()

        let running = false
        let cancelled = false
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type === LEGACY_IMPORT_CANCEL_MESSAGE) {
                cancelled = true
                sendResponse({ ok: true })
                return
            }
            if (message?.type !== LEGACY_IMPORT_START_MESSAGE) return
            sendResponse({ ok: true })
            if (running || !isExtensionContextValid()) return
            running = true
            cancelled = false
            let last: LegacyImportProgress = { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, title: '' }
            importLegacy({
                onProgress: (progress) => {
                    last = progress
                    send({ type: LEGACY_IMPORT_PROGRESS_MESSAGE, progress })
                },
                isCancelled: () => cancelled,
            })
                .catch((error) => {
                    console.error('以前の録画を取り込めませんでした:', error)
                    return { migrated: last.done, cancelled: false, busy: false, error: String(error) }
                })
                .then(async (finished) => {
                    // 残った数を知らせてから、終わったと知らせる（終わったと知らせると、このタブは閉じられる）
                    await reportLegacyRecordings()
                    running = false
                    send({ type: LEGACY_IMPORT_PROGRESS_MESSAGE, progress: last, finished })
                })
        })
    },
})
