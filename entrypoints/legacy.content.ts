// 以前のバージョンの録画（ニコ生のサイトデータに残っているもの）を調べ、取り込み用のページでは取り込む
// ニコ生のページ（一番上）を開いた時は、残っているかを数えて録画一覧に知らせる。
// 取り込み用のページ（utils/library/legacy-import.ts の LEGACY_IMPORT_URL）は、録画一覧が見えない枠で埋め込む
// （埋め込めない時は、裏のタブで開く）。開いてすぐ取り込む。取り込み用の URL は誰でも開けるので、
// 埋め込んだのがこの拡張機能の録画一覧か・開いたのが録画一覧が開いたタブかを確かめてから取り込む
import { summarizeLegacyRecordings, type LegacyImportProgress, type LegacySummary } from '@/utils/library/migrate'
import { importLegacy } from '@/utils/library/api'
import { isExtensionContextValid } from '@/utils/library/client'
import { LEGACY_RECORDINGS } from '@/utils/storage'
import {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE, LEGACY_IMPORT_CHECK_MESSAGE,
    isLegacyImportPage, isLegacyCountPage, type LegacyImportMessage,
} from '@/utils/library/legacy-import'

// 取り込んでいる間、進み具合が変わらなくても知らせ直す間隔（大きな録画を読んでいる間に、録画一覧が止まったとみなさないように）
const HEARTBEAT_MS = 20 * 1000
// 取り込みに失敗した後に、残りを数え直すのを待つ時間の上限（保存先を開けずに待たされても、終わったと知らせられるように）
const RECOUNT_TIMEOUT_MS = 5 * 1000
// 録画一覧が開いたタブかを確かめ直す間隔と回数（録画一覧は、タブを開いてから、そのタブを覚える）
const CHECK_INTERVAL_MS = 500
const CHECK_ATTEMPTS = 20

// 録画一覧が取り込み用に開いたタブか（他のサイトのリンクなどから取り込み用の URL を開いただけでは、取り込まない）
const isRegisteredImportTab = async () => {
    for (let i = 0; i < CHECK_ATTEMPTS; i++) {
        const reply = await chrome.runtime.sendMessage({ type: LEGACY_IMPORT_CHECK_MESSAGE }).catch(() => null)
        if (reply?.ok) return true
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MS))
    }
    return false
}

// この拡張機能のページ（録画一覧）に、直接埋め込まれた枠か（他のサイト・他の拡張機能のページには、このページを埋め込めても、親を偽れない）
const isEmbeddedByThisExtension = () => {
    if (window === window.top) return false
    const ancestors = location.ancestorOrigins
    return !!ancestors && ancestors.length === 1 && ancestors[0] === new URL(chrome.runtime.getURL('/')).origin
}

const setLegacyRecordings = async (next: LegacySummary | null) => {
    const current = await LEGACY_RECORDINGS.getValue()
    if (current?.count !== next?.count || current?.bytes !== next?.bytes) await LEGACY_RECORDINGS.setValue(next)
}

// 以前の録画が残っているかを、録画一覧に知らせる（残っていれば、録画一覧で取り込みを勧める）
// keepWhenNone: 見つからなくても「ない」とは知らせない（埋め込んだ枠からは、ニコ生のサイトデータが見えないこともあるので）
const reportLegacyRecordings = async ({ keepWhenNone = false } = {}) => {
    try {
        const summary = await summarizeLegacyRecordings()
        if (summary || !keepWhenNone) await setLegacyRecordings(summary)
    } catch (error) {
        console.log('以前の録画を調べられませんでした:', error)
    }
}

const send = (message: LegacyImportMessage) => {
    try {
        chrome.runtime.sendMessage(message).catch(() => {}) // 録画一覧が閉じられていても、取り込みは続ける（タブで開いた時）
    } catch {
        // 拡張機能が更新された
    }
}

export default defineContentScript({
    matches: ['*://live.nicovideo.jp/*'],
    // 録画一覧に埋め込まれた枠でも動かす（ニコ生のページの中の枠では、何もしない）
    allFrames: true,
    main() {
        const embedded = isEmbeddedByThisExtension()
        if (window !== window.top && !embedded) return
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
                    // 残った数を知らせてから、終わったと知らせる（終わったと知らせると、取り込み用のタブは閉じられる）
                    // 埋め込んだ枠で何も見つからなかった時は、ニコ生のサイトデータが見えなかったのかもしれないので、知らせない
                    // （録画一覧が、タブで開いて取り込み直す）
                    if (!embedded || finished.migrated > 0 || remaining) await setLegacyRecordings(remaining).catch(() => {})
                    return finished
                })
                .catch(async (error) => {
                    console.error('以前の録画を取り込めませんでした:', error)
                    await Promise.race([reportLegacyRecordings({ keepWhenNone: embedded }), new Promise(resolve => setTimeout(resolve, RECOUNT_TIMEOUT_MS))])
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
            if (message?.type !== LEGACY_IMPORT_START_MESSAGE || embedded) return
            // 取り込み用のページから他のページへ移ったタブでは取り込まない（録画一覧は、新しく開き直す）
            sendResponse({ ok: importPage })
            if (importPage) startImport()
        })

        // 録画一覧に埋め込まれた枠: 取り込み用なら取り込み、数える用なら数える
        if (embedded) {
            if (importPage) startImport()
            else if (isLegacyCountPage(location.href)) void reportLegacyRecordings({ keepWhenNone: true })
            return
        }
        if (!importPage) {
            void reportLegacyRecordings()
            return
        }
        void isRegisteredImportTab().then((registered) => {
            if (registered) startImport()
            else void reportLegacyRecordings()
        })
    },
})
