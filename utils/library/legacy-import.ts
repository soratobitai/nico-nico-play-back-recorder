// 以前のバージョンの録画（ニコ生のサイトデータに残っているもの）を、録画一覧から手動で取り込む
// 以前の録画はニコ生のサイトデータにあるので、録画一覧のページ（拡張機能のページ）からは読めない。
// 録画一覧が取り込み用のニコ生のページ（LEGACY_IMPORT_URL）を裏で開き、そのページの content script が
// 開いてすぐ拡張機能側の保存先へ移して、進み具合を知らせる。
//   録画一覧 → 取り込み用のタブ: LEGACY_IMPORT_START_MESSAGE（前に開いたタブで、もう一度始める）・LEGACY_IMPORT_CANCEL_MESSAGE（やめる）
//   取り込み用のタブ → 録画一覧・background: LEGACY_IMPORT_PROGRESS_MESSAGE（進み具合。終わったら finished）
import type { LegacyImportProgress, LegacyImportResult } from './migrate'

const LEGACY_IMPORT_START_MESSAGE = 'playback-legacy:start'
const LEGACY_IMPORT_CANCEL_MESSAGE = 'playback-legacy:cancel'
const LEGACY_IMPORT_PROGRESS_MESSAGE = 'playback-legacy:progress'

// 取り込むために裏で開くニコ生のページ（トップページに、取り込み用の印を付ける）
const LEGACY_IMPORT_PARAM = 'npr-import'
const LEGACY_IMPORT_URL = `https://live.nicovideo.jp/?${LEGACY_IMPORT_PARAM}=1`
// 取り込み用に開いたページか（他のページへ移ったタブでは取り込まない・閉じない）
const isLegacyImportPage = (url: string | undefined) => {
    try {
        return !!url && new URL(url).searchParams.has(LEGACY_IMPORT_PARAM)
    } catch {
        return false
    }
}
// 取り込むために開いたタブ（chrome.storage.session。録画一覧を閉じても、取り込み終えたら background が閉じる）
const LEGACY_IMPORT_TAB_KEY = 'legacyImportTabId'

type LegacyImportMessage = {
    type: typeof LEGACY_IMPORT_PROGRESS_MESSAGE
    progress: LegacyImportProgress
    // 終わった（error: 途中で失敗した。移し終えた分はそのまま残る）
    finished?: Omit<LegacyImportResult, 'remaining'> & { error?: string }
}

export {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE,
    LEGACY_IMPORT_URL, LEGACY_IMPORT_TAB_KEY, isLegacyImportPage,
}
export type { LegacyImportMessage }
