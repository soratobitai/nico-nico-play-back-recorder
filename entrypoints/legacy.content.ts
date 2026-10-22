// 以前のバージョンの録画（ニコ生のサイトデータに残っているもの）を調べ、取り込み用のページでは取り込む
// ニコ生のページ（一番上）を開いた時は、残っているかを数えて録画一覧に知らせる。
// 取り込み用のページ（utils/library/legacy-import.ts の legacyImportUrl）は、録画一覧が見えない枠で埋め込む
// （埋め込めない時は、裏のタブで開く）。取り込み用の URL は誰でも開けるので、URL に付いた合言葉を background に確かめてから取り込む。
// 埋め込まれた時は、埋め込んだのがこの拡張機能の録画一覧かも確かめる
import { countLegacyRecordingsUnlessImporting, type LegacyImportProgress, type LegacySummary } from '@/utils/library/migrate'
import { importLegacy, getUsage } from '@/utils/library/api'
import { isExtensionContextValid } from '@/utils/library/client'
import { LEGACY_RECORDINGS, MAX_STORAGE_SIZE } from '@/utils/storage'
import {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE, LEGACY_IMPORT_CHECK_MESSAGE,
    LEGACY_IMPORT_HEADROOM, isLegacyImportPage, isLegacyCountPage, legacyImportRunOf, type LegacyImportMessage,
} from '@/utils/library/legacy-import'

// 取り込んでいる間、進み具合が変わらなくても知らせ直す間隔（大きな録画を読んでいる間に、録画一覧が止まったとみなさないように）
const HEARTBEAT_MS = 20 * 1000
// 取り込みに失敗した後に、残りを数え直すのを待つ時間の上限（保存先を開けずに待たされても、終わったと知らせられるように）
const RECOUNT_TIMEOUT_MS = 5 * 1000
// 合言葉を確かめ直す間隔と回数（タブで開いた時は、録画一覧がタブを開いてから、そのタブを覚える）
const CHECK_INTERVAL_MS = 500
const CHECK_ATTEMPTS = 20

// 録画一覧が頼んだ取り込みか（URL に付いた合言葉を background に確かめる。合言葉は1回しか使えない）
const isRequestedRun = async (run: string) => {
    for (let i = 0; i < CHECK_ATTEMPTS; i++) {
        const reply = await chrome.runtime.sendMessage({ type: LEGACY_IMPORT_CHECK_MESSAGE, run }).catch(() => null)
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
// どこかで取り込んでいる間は数えない（取り込む方が、1本移すたびに知らせる）
// keepWhenNone: 見つからなくても「ない」とは知らせない（埋め込んだ枠からは、ニコ生のサイトデータが見えないこともあるので）
const reportLegacyRecordings = async ({ keepWhenNone = false } = {}) => {
    try {
        const summary = await countLegacyRecordingsUnlessImporting()
        if (summary === undefined) return
        if (summary || !keepWhenNone) await setLegacyRecordings(summary)
    } catch (error) {
        console.log('以前の録画を調べられませんでした:', error)
    }
}

// 容量の上限まで、録画を続ける分の空き（LEGACY_IMPORT_HEADROOM）を残して移せるか
// （上限いっぱいまで移すと、次の録画で、移した録画が古い順に削除されてしまうので、入らない録画は以前の保存先に残す）
const canFit = async (bytes: number) => {
    const [usage, limit] = await Promise.all([getUsage(), MAX_STORAGE_SIZE.getValue()])
    return usage.bytes + bytes + LEGACY_IMPORT_HEADROOM <= limit
}

export default defineContentScript({
    matches: ['*://live.nicovideo.jp/*'],
    // 録画一覧に埋め込まれた枠でも動かす（ニコ生のページの中の枠では、何もしない）
    allFrames: true,
    main() {
        // シークレットウィンドウには以前の録画はない（数えると、通常のウィンドウの録画の数を消してしまう）
        if (chrome.extension?.inIncognitoContext) return
        const embedded = isEmbeddedByThisExtension()
        if (window !== window.top && !embedded) return
        const importPage = isLegacyImportPage(location.href)
        let running = false
        let cancelled = false
        // 今の取り込みの合言葉（録画一覧は、この合言葉の付いた知らせだけを受け取る。前に開いたタブでもう一度始める時は変わる）
        let run = ''

        const send = (progress: LegacyImportProgress, finished?: LegacyImportMessage['finished']) => {
            const message: LegacyImportMessage = { type: LEGACY_IMPORT_PROGRESS_MESSAGE, run, progress, finished }
            try {
                chrome.runtime.sendMessage(message).catch(() => {}) // 録画一覧が閉じられていても、取り込みは続ける（タブで開いた時）
            } catch {
                // 拡張機能が更新された
            }
        }

        const startImport = () => {
            if (running || !isExtensionContextValid()) return
            running = true
            cancelled = false
            let last: LegacyImportProgress = { done: 0, migrated: 0, failed: 0, total: 0, bytesDone: 0, bytesTotal: 0, title: '' }
            // 始めたことをすぐに知らせる（以前の録画を調べるのに時間がかかっても、録画一覧が始まらなかったとみなさないように）
            send(last)
            const heartbeat = setInterval(() => send(last), HEARTBEAT_MS)
            importLegacy({
                onProgress: (progress) => {
                    last = progress
                    send(progress)
                },
                isCancelled: () => cancelled,
                canFit,
                // 1本移すたびと取り込み終えた時に、残りを知らせる（途中で止まっても、録画一覧に出る数と、上限を上げる大きさが合うように）
                onRemaining: (remaining) => void setLegacyRecordings(remaining).catch(() => {}),
            })
                .then(async ({ remaining, ...finished }) => {
                    // 以前の録画がなかった時は、ないと知らせてから、終わったと知らせる（終わったと知らせると、取り込み用のタブは閉じられる）。
                    // あった時は、取り込みが残りを知らせている。他のタブで取り込んでいた時は、そちらが知らせる。
                    // 埋め込んだ枠で何も見つからなかった時は、ニコ生のサイトデータが見えなかったのかもしれないので、知らせない
                    // （録画一覧が、タブで開いて取り込み直す）
                    const found = finished.migrated > 0 || finished.failed > 0 || !!remaining
                    if (!finished.busy && !embedded && !found) await setLegacyRecordings(null).catch(() => {})
                    return finished
                })
                .catch(async (error) => {
                    console.error('以前の録画を取り込めませんでした:', error)
                    await Promise.race([reportLegacyRecordings({ keepWhenNone: embedded }), new Promise(resolve => setTimeout(resolve, RECOUNT_TIMEOUT_MS))])
                    return {
                        migrated: last.migrated, failed: last.failed, cancelled: false, full: false, diskFull: false, busy: false, error: String(error),
                    }
                })
                .then((finished) => {
                    clearInterval(heartbeat)
                    running = false
                    send(last, finished)
                })
        }

        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type === LEGACY_IMPORT_CANCEL_MESSAGE) {
                cancelled = true
                // 取り込み用のページのままか（始まらなかったタブを、録画一覧が閉じてよいか）
                sendResponse({ ok: true, importPage })
                return
            }
            if (message?.type !== LEGACY_IMPORT_START_MESSAGE || embedded) return
            // 取り込み用のページから他のページへ移ったタブでは取り込まない（録画一覧は、新しく開き直す）
            sendResponse({ ok: importPage })
            if (!importPage || typeof message.run !== 'string') return
            // 取り込んでいる最中なら、新しい合言葉で知らせ続ける（録画一覧を開き直した時など）
            run = message.run
            startImport()
        })

        // 録画一覧に埋め込まれた枠: 取り込み用なら合言葉を確かめて取り込み、数える用なら数える
        if (embedded) {
            const requested = importPage ? legacyImportRunOf(location.href) : null
            if (requested) {
                void isRequestedRun(requested).then((ok) => {
                    if (!ok || running) return
                    run = requested
                    startImport()
                })
            } else if (isLegacyCountPage(location.href)) {
                void reportLegacyRecordings({ keepWhenNone: true })
            }
            return
        }
        const requested = importPage ? legacyImportRunOf(location.href) : null
        if (!requested) {
            void reportLegacyRecordings()
            return
        }
        void isRequestedRun(requested).then((ok) => {
            if (!ok) return void reportLegacyRecordings()
            // 確かめている間に、録画一覧が新しい合言葉で始めていたら、そちらで続ける
            if (running) return
            run = requested
            startImport()
        })
    },
})
