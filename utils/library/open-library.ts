// ライブラリのページを開く
// ニコ生のページのボタンや、ツールバーの拡張機能のアイコンから開く。
// 既に開いていれば、そのページに番組を表示して前に出す（同じページを何枚も開かない）。

// content script → background: ライブラリを開いてほしい（programId の番組を表示する）
const OPEN_LIBRARY_MESSAGE = 'playback-library:open'
// background → ライブラリのページ: 開いていれば、programId の番組を表示して前に出てほしい
const SHOW_PROGRAM_MESSAGE = 'playback-library:show'

type OpenLibraryMessage = { type: typeof OPEN_LIBRARY_MESSAGE, programId?: string }
type ShowProgramMessage = { type: typeof SHOW_PROGRAM_MESSAGE, programId?: string }

const libraryUrl = (programId?: string) =>
    chrome.runtime.getURL('/library.html') + (programId ? `#${encodeURIComponent(programId)}` : '')

// background で使う
const openLibrary = async (programId?: string) => {
    try {
        const shown = await chrome.runtime.sendMessage({ type: SHOW_PROGRAM_MESSAGE, programId } satisfies ShowProgramMessage)
        if (shown) return
    } catch {
        // ライブラリのページが開いていない
    }
    await chrome.tabs.create({ url: libraryUrl(programId) })
}

// content script で使う
const requestOpenLibrary = (programId?: string) =>
    chrome.runtime.sendMessage({ type: OPEN_LIBRARY_MESSAGE, programId } satisfies OpenLibraryMessage)

export { OPEN_LIBRARY_MESSAGE, SHOW_PROGRAM_MESSAGE, openLibrary, requestOpenLibrary, libraryUrl }
export type { OpenLibraryMessage, ShowProgramMessage }
