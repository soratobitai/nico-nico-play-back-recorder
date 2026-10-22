// 以前のバージョンの録画（ニコ生のサイトデータに残っているもの）を、録画一覧から手動で取り込む
// 以前の録画はニコ生のサイトデータにあるので、録画一覧のページ（拡張機能のページ）からは読めない。
// 録画一覧に、取り込み用のニコ生のページ（LEGACY_IMPORT_URL。とても軽い robots.txt）を見えない枠で埋め込み、
// そのページの content script が拡張機能側の保存先へ移して、進み具合を知らせる（新しいタブを開かない）。
// 埋め込んだページからニコ生のサイトデータが読めない時（Chrome の決まりが変わった など）は、同じページを裏のタブで開いて取り込む。
// 取り込むたびに、録画一覧が合言葉（run。1回だけ使える）を決めて、取り込み用のページの URL の # に付ける。
// 取り込み用のページは、合言葉を background に確かめてから取り込む（URL を開いただけ・転送されただけでは取り込まない）。
// 進み具合にも合言葉を付けて返す（録画一覧は、自分が始めた取り込みの知らせだけを受け取る）。
//   録画一覧 → 取り込み用のページ: LEGACY_IMPORT_START_MESSAGE（前に開いたタブで、新しい合言葉でもう一度始める）・LEGACY_IMPORT_CANCEL_MESSAGE（やめる）
//   取り込み用のページ → 録画一覧・background: LEGACY_IMPORT_PROGRESS_MESSAGE（進み具合。終わったら finished）
//   取り込み用のページ → background: LEGACY_IMPORT_CHECK_MESSAGE（合言葉が正しいか。タブの時は、録画一覧が開いたタブかも）
// 録画一覧を開いた時は、数える用のページ（LEGACY_COUNT_URL）を埋め込んで、以前の録画が残っているかを数え直す
import type { LegacyImportProgress, LegacyImportResult } from './migrate'

const LEGACY_IMPORT_START_MESSAGE = 'playback-legacy:start'
const LEGACY_IMPORT_CANCEL_MESSAGE = 'playback-legacy:cancel'
const LEGACY_IMPORT_PROGRESS_MESSAGE = 'playback-legacy:progress'
const LEGACY_IMPORT_CHECK_MESSAGE = 'playback-legacy:check'

// 取り込み用・数える用のニコ生のページ（robots.txt に印を付ける。とても軽く、埋め込みも禁止されていない）
const LEGACY_IMPORT_PARAM = 'npr-import'
const LEGACY_COUNT_PARAM = 'npr-count'
const LEGACY_PAGE = 'https://live.nicovideo.jp/robots.txt'
const LEGACY_IMPORT_URL = `${LEGACY_PAGE}?${LEGACY_IMPORT_PARAM}=1`
const LEGACY_COUNT_URL = `${LEGACY_PAGE}?${LEGACY_COUNT_PARAM}=1`
const hasParam = (url: string | undefined, param: string) => {
    try {
        return !!url && new URL(url).searchParams.has(param)
    } catch {
        return false
    }
}
// 取り込み用のページか（他のページへ移ったタブでは取り込まない・閉じない）
const isLegacyImportPage = (url: string | undefined) => hasParam(url, LEGACY_IMPORT_PARAM)
const isLegacyCountPage = (url: string | undefined) => hasParam(url, LEGACY_COUNT_PARAM)
// 合言葉を付けた、取り込み用のページの URL・URL に付いた合言葉
const legacyImportUrl = (run: string) => `${LEGACY_IMPORT_URL}#${run}`
const legacyImportRunOf = (url: string) => {
    try {
        return decodeURIComponent(new URL(url).hash.slice(1)) || null
    } catch {
        return null
    }
}
// 取り込むために開いたタブ（埋め込めなかった時だけ。chrome.storage.session。録画一覧を閉じても、取り込み終えたら background が閉じる）
const LEGACY_IMPORT_TAB_KEY = 'legacyImportTabId'
// まだ使われていない合言葉（chrome.storage.session。content script からは読めない。取り込み用のページが確かめたら消す）
const LEGACY_IMPORT_RUN_KEY = 'legacyImportRun'

type LegacyImportMessage = {
    type: typeof LEGACY_IMPORT_PROGRESS_MESSAGE
    run: string
    progress: LegacyImportProgress
    // 終わった（error: 途中で失敗した。移し終えた分はそのまま残る）
    finished?: Omit<LegacyImportResult, 'remaining'> & { error?: string }
}

export {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE, LEGACY_IMPORT_CHECK_MESSAGE,
    LEGACY_IMPORT_URL, LEGACY_COUNT_URL, LEGACY_IMPORT_TAB_KEY, LEGACY_IMPORT_RUN_KEY,
    isLegacyImportPage, isLegacyCountPage, legacyImportUrl, legacyImportRunOf,
}
export type { LegacyImportMessage }
