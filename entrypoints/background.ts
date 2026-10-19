import { BRIDGE_TOKEN_KEY, BRIDGE_TOKEN_MESSAGE } from '@/utils/library/protocol'
import { OPEN_LIBRARY_MESSAGE, openLibrary } from '@/utils/library/open-library'

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

export default defineBackground(() => {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // タブの中の content script からの依頼にだけ答える
        if (!sender.tab) return
        if (message?.type === BRIDGE_TOKEN_MESSAGE) {
            getBridgeToken().then(token => sendResponse({ token }))
            return true
        }
        if (message?.type === OPEN_LIBRARY_MESSAGE) {
            const programId = typeof message.programId === 'string' ? message.programId : undefined
            openLibrary(programId).catch(error => console.error('ライブラリを開けませんでした:', error))
        }
    })

    // ツールバーの拡張機能のアイコンからも開ける
    chrome.action.onClicked.addListener(() => {
        openLibrary().catch(error => console.error('ライブラリを開けませんでした:', error))
    })
})
