// 以前のバージョンの録画（ニコ生のサイトデータに残っているもの）を調べ、取り込み用のページでは取り込む
// ニコ生のどのページでも、残っているかを数えて録画一覧に知らせる。
// 録画一覧が開いた取り込み用のページ（utils/library/legacy-import.ts の LEGACY_IMPORT_URL）では、開いてすぐ取り込む
import { summarizeLegacyRecordings, type LegacyImportProgress, type LegacySummary } from '@/utils/library/migrate'
import { importLegacy } from '@/utils/library/api'
import { isExtensionContextValid } from '@/utils/library/client'
import { LEGACY_RECORDINGS } from '@/utils/storage'
import {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE, isLegacyImportPage, type LegacyImportMessage,
} from '@/utils/library/legacy-import'

// 取り込んでいる間、進み具合が変わらなくても知らせ直す間隔（大きな録画を読んでいる間に、録画一覧が止まったとみなさないように）
const HEARTBEAT_MS = 20 * 1000
// 取り込みに失敗した後に、残りを数え直すのを待つ時間の上限（保存先を開けずに待たされても、終わったと知らせられるように）
const RECOUNT_TIMEOUT_MS = 5 * 1000

const setLegacyRecordings = async (next: LegacySummary | null) => {
    const current = await LEGACY_RECORDINGS.getValue()
    if (current?.count !== next?.count || current?.bytes !== next?.bytes) await LEGACY_RECORDINGS.setValue(next)
}

// 以前の録画が残っているかを、録画一覧に知らせる（残っていれば、録画一覧で取り込みを勧める）
const reportLegacyRecordings = async () => {
    try {
        await setLegacyRecordings(await summarizeLegacyRecordings())
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
        const importPage = isLegacyImportPage(location.href)
        let running = false
        let cancelled = false

        const startImport = () => {
            if (running || !isExtensionContextValid()) return
            running = true
            cancelled = false
            let last: LegacyImportProgress = { done: 0, total: 0, bytesDone: 0, bytesTotal: 0, title: '' }
            const heartbeat = setInterval(() => send({ type: LEGACY_IMPORT_PROGRESS_MESSAGE, progress: last }), HEARTBEAT_MS)
            importLegacy({
                onProgress: (progress) => {
                    last = progress
                    send({ type: LEGACY_IMPORT_PROGRESS_MESSAGE, progress })
                },
                isCancelled: () => cancelled,
            })
                .then(async ({ remaining, ...finished }) => {
                    // 残った数を知らせてから、終わったと知らせる（終わったと知らせると、このタブは閉じられる）
                    await setLegacyRecordings(remaining).catch(() => {})
                    return finished
                })
                .catch(async (error) => {
                    console.error('以前の録画を取り込めませんでした:', error)
                    await Promise.race([reportLegacyRecordings(), new Promise(resolve => setTimeout(resolve, RECOUNT_TIMEOUT_MS))])
                    return { migrated: last.done, cancelled: false, busy: false, error: String(error) }
                })
                .then((finished) => {
                    clearInterval(heartbeat)
                    running = false
                    send({ type: LEGACY_IMPORT_PROGRESS_MESSAGE, progress: last, finished })
                })
        }

        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type === LEGACY_IMPORT_CANCEL_MESSAGE) {
                cancelled = true
                sendResponse({ ok: true })
                return
            }
            if (message?.type !== LEGACY_IMPORT_START_MESSAGE) return
            // 取り込み用のページから他のページへ移ったタブでは取り込まない（録画一覧は、新しく開き直す）
            sendResponse({ ok: importPage })
            if (importPage) startImport()
        })

        if (importPage) startImport()
        else void reportLegacyRecordings()
    },
})
