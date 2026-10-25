// 録画一覧のページを開く
// ニコ生のページのボタンや、ツールバーの拡張機能のアイコンから開く。
// 既に開いていれば、そのページに番組を表示して前に出す（同じページを何枚も開かない）。

// content script → background: 録画一覧を開いてほしい（programId の番組を表示する）
const OPEN_LIBRARY_MESSAGE = 'playback-library:open'
// background → 録画一覧のページ: 開いていれば、programId の番組を表示して前に出てほしい
const SHOW_PROGRAM_MESSAGE = 'playback-library:show'

type OpenLibraryMessage = { type: typeof OPEN_LIBRARY_MESSAGE, programId?: string }
type ShowProgramMessage = { type: typeof SHOW_PROGRAM_MESSAGE, programId?: string }

const libraryUrl = (programId?: string) =>
    chrome.runtime.getURL('/library.html') + (programId ? `#${encodeURIComponent(programId)}` : '')

// 開いたばかりで、まだ番組を表示する知らせを受け取れない録画一覧を、開き直さずに前に出す時間
const JUST_OPENED_MS = 10 * 1000

// 開いている途中の頼み（続けて頼まれても、録画一覧を何枚も開かない）と、最後に開いた録画一覧
let opening: Promise<void> | null = null
let opened: { tabId: number, at: number } | null = null

// background で使う
const openLibrary = (programId?: string) => opening ??= (async () => {
    try {
        try {
            const shown = await chrome.runtime.sendMessage({ type: SHOW_PROGRAM_MESSAGE, programId } satisfies ShowProgramMessage)
            if (shown) return
        } catch {
            // 録画一覧のページが開いていない
        }
        if (opened && Date.now() - opened.at < JUST_OPENED_MS) {
            const shown = await chrome.tabs.update(opened.tabId, { active: true }).then(() => true, () => false)
            if (shown) return
        }
        const tab = await chrome.tabs.create({ url: libraryUrl(programId) })
        if (tab?.id !== undefined) opened = { tabId: tab.id, at: Date.now() }
    } finally {
        opening = null
    }
})()

// content script で使う
const requestOpenLibrary = (programId?: string) =>
    chrome.runtime.sendMessage({ type: OPEN_LIBRARY_MESSAGE, programId } satisfies OpenLibraryMessage)

export { OPEN_LIBRARY_MESSAGE, SHOW_PROGRAM_MESSAGE, openLibrary, requestOpenLibrary, libraryUrl }
export type { OpenLibraryMessage, ShowProgramMessage }
