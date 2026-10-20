import { BRIDGE_TOKEN_KEY, BRIDGE_TOKEN_MESSAGE, CLOSE_SEGMENTS_MESSAGE } from '@/utils/library/protocol'
import { closeSegments } from '@/utils/library/db'
import { OPEN_LIBRARY_MESSAGE, openLibrary } from '@/utils/library/open-library'
import { LEGACY_IMPORT_PROGRESS_MESSAGE, LEGACY_IMPORT_TAB_KEY, isLegacyImportPage } from '@/utils/library/legacy-import'

// ニコ生のページに埋め込む bridge を使ってよい相手（content script）だけに渡す合言葉
// ニコ生のページ側のスクリプトはこの service worker と話せないので、合言葉を知ることができない
// （同時に頼まれても1つにそろうよう、作っている途中の Promise を共有する）
let tokenPromise: Promise<string> | null = null

const getBridgeToken = () => tokenPromise ??= (async () => {
    const { [BRIDGE_TOKEN_KEY]: saved } = await chrome.storage.session.get(BRIDGE_TOKEN_KEY)
    if (typeof saved === 'string') return saved
    const token = crypto.randomUUID()
    await chrome.storage.session.set({ [BRIDGE_TOKEN_KEY]: token })
    return token
})()

// 取り込み用に開いたタブで、まだ取り込み用のページのまま（他のページへ移っていない）なら閉じる
const closeImportTab = async (tabId: number | undefined, url: string | undefined) => {
    const { [LEGACY_IMPORT_TAB_KEY]: importTabId } = await chrome.storage.session.get(LEGACY_IMPORT_TAB_KEY)
    if (tabId === undefined || tabId !== importTabId || !isLegacyImportPage(url)) return
    await chrome.storage.session.remove(LEGACY_IMPORT_TAB_KEY)
    await chrome.tabs.remove(tabId)
}

export default defineBackground(() => {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // タブの中の content script からの依頼にだけ答える
        if (!sender.tab) return
        if (message?.type === BRIDGE_TOKEN_MESSAGE) {
            getBridgeToken().then(token => sendResponse({ token }))
            return true
        }
        // 録画していたページが閉じられる（ページの方では、録画を終える処理を最後まで行えない）
        if (message?.type === CLOSE_SEGMENTS_MESSAGE && Array.isArray(message.segmentIds)) {
            const segmentIds = message.segmentIds.filter((id: unknown): id is string => typeof id === 'string')
            closeSegments(segmentIds).catch(error => console.error('閉じられたページの録画を確定できませんでした:', error))
            return
        }
        // 以前の録画を取り込むために録画一覧が開いたタブは、取り込み終えたら閉じる（録画一覧を閉じた後でも）
        if (message?.type === LEGACY_IMPORT_PROGRESS_MESSAGE && message.finished) {
            closeImportTab(sender.tab.id, sender.url).catch(() => {})
            return
        }
        if (message?.type === OPEN_LIBRARY_MESSAGE) {
            const programId = typeof message.programId === 'string' ? message.programId : undefined
            openLibrary(programId).catch(error => console.error('録画一覧を開けませんでした:', error))
        }
    })

    // ツールバーの拡張機能のアイコンからも開ける
    chrome.action.onClicked.addListener(() => {
        openLibrary().catch(error => console.error('録画一覧を開けませんでした:', error))
    })
})
