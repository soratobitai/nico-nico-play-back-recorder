// ニコ生のページに埋め込まれ、content script からの依頼で拡張機能側の保存先を読み書きする
// （録画を拡張機能側に保存するため。ニコ生のサイトデータに保存すると、拡張機能を消しても残り、
//   サイトデータを消すと録画も消えてしまう）
import { BRIDGE_INIT_MESSAGE, BRIDGE_TOKEN_KEY, type BridgeEnvelope, type BridgeReply } from '@/utils/library/protocol'
import { handleBridgeRequest } from '@/utils/library/handler'

window.addEventListener('message', async (event) => {
    const port = event.ports[0]
    if (event.data?.type !== BRIDGE_INIT_MESSAGE || !port) return

    // 合言葉が一致しない相手（ニコ生のページ側のスクリプトなど）には応答しない
    const { [BRIDGE_TOKEN_KEY]: token } = await chrome.storage.session.get(BRIDGE_TOKEN_KEY)
    if (typeof token !== 'string' || event.data.token !== token) {
        port.postMessage({ type: 'rejected' })
        port.close()
        return
    }

    port.onmessage = async ({ data }: MessageEvent<BridgeEnvelope>) => {
        let reply: BridgeReply
        try {
            reply = { id: data.id, ok: true, result: await handleBridgeRequest(data.request) }
        } catch (error) {
            const { name, message } = error instanceof Error || error instanceof DOMException
                ? error
                : { name: 'Error', message: String(error) }
            reply = { id: data.id, ok: false, error: { name, message } }
        }
        port.postMessage(reply)
    }
    port.postMessage({ type: 'ready' })
})
