// ニコ生のページ（content script）から、拡張機能側の保存先（bridge）につなぐ
// bridge は拡張機能のページで、ニコ生のページに見えない iframe として埋め込む。
// 録画データ（Blob）は MessagePort でそのまま渡せる。
import { BRIDGE_INIT_MESSAGE, BRIDGE_TOKEN_MESSAGE, type BridgeEnvelope, type BridgeReply, type BridgeRequestOf, type BridgeRequestType, type BridgeResults } from './protocol'

// bridge とやり取りできなかった（拡張機能が更新された直後など）
// bridge が処理して失敗した場合（その名前のエラーになる）とは区別する
class BridgeUnavailableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'BridgeUnavailableError'
    }
}

type BridgeConnection = {
    call: <T extends BridgeRequestType>(request: BridgeRequestOf<T>, timeoutMs?: number) => Promise<BridgeResults[T]>
}

const CONNECT_TIMEOUT_MS = 15 * 1000
// 長い録画を1本のファイルにまとめる時などは時間がかかる
const CALL_TIMEOUT_MS = 2 * 60 * 1000

// 拡張機能が更新・削除されると、それより前から動いている content script は拡張機能の機能を使えなくなる
const isExtensionContextValid = () => {
    try {
        return !!chrome.runtime?.id
    } catch {
        return false
    }
}

const withTimeout = <T>(promise: Promise<T>, ms: number, what: string) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BridgeUnavailableError(`${what}が時間内に終わりませんでした`)), ms)
    promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
    )
})

// bridge で起きたエラーを同じ名前のエラーとして作り直す（容量不足は DOMException のまま判定できるように）
const toError = ({ name, message }: { name: string, message: string }) =>
    name === 'QuotaExceededError' ? new DOMException(message, name) : Object.assign(new Error(message), { name })

let connection: Promise<BridgeConnection> | null = null

const getBridge = (): Promise<BridgeConnection> => connection ??= connect().catch((error) => {
    connection = null
    throw error
})

const connect = async (): Promise<BridgeConnection> => {
    if (!isExtensionContextValid()) throw new BridgeUnavailableError('拡張機能が更新されたため、拡張機能側に保存できません')

    const { token } = await withTimeout(
        chrome.runtime.sendMessage({ type: BRIDGE_TOKEN_MESSAGE }) as Promise<{ token: string }>,
        CONNECT_TIMEOUT_MS, '合言葉の取得',
    )

    const iframe = document.createElement('iframe')
    iframe.src = chrome.runtime.getURL('/bridge.html')
    iframe.hidden = true
    iframe.tabIndex = -1
    iframe.setAttribute('aria-hidden', 'true')
    document.documentElement.appendChild(iframe)

    try {
        await withTimeout(new Promise(resolve => iframe.addEventListener('load', resolve, { once: true })), CONNECT_TIMEOUT_MS, 'bridge の読み込み')

        const channel = new MessageChannel()
        const ready = new Promise<void>((resolve, reject) => {
            channel.port1.onmessage = ({ data }) => data?.type === 'ready'
                ? resolve()
                : reject(new BridgeUnavailableError('bridge に接続できませんでした'))
        })
        iframe.contentWindow?.postMessage({ type: BRIDGE_INIT_MESSAGE, token }, new URL(iframe.src).origin, [channel.port2])
        await withTimeout(ready, CONNECT_TIMEOUT_MS, 'bridge への接続')
        return createConnection(channel.port1, iframe)
    } catch (error) {
        iframe.remove()
        throw error
    }
}

const createConnection = (port: MessagePort, iframe: HTMLIFrameElement): BridgeConnection => {
    let nextId = 1
    const waiting = new Map<number, { resolve: (value: unknown) => void, reject: (error: unknown) => void }>()

    port.onmessage = ({ data }: MessageEvent<BridgeReply>) => {
        const waiter = waiting.get(data.id)
        if (!waiter) return
        waiting.delete(data.id)
        if (data.ok) waiter.resolve(data.result)
        else waiter.reject(toError(data.error))
    }

    // 応答がなくなった bridge は捨てて、次の依頼でつなぎ直す
    const discard = () => {
        if (connection) connection = null
        port.close()
        iframe.remove()
    }

    return {
        call<T extends BridgeRequestType>(request: BridgeRequestOf<T>, timeoutMs = CALL_TIMEOUT_MS) {
            if (!isExtensionContextValid()) {
                discard()
                return Promise.reject(new BridgeUnavailableError('拡張機能が更新されたため、拡張機能側に保存できません'))
            }
            const id = nextId++
            return new Promise<BridgeResults[T]>((resolve, reject) => {
                const timer = setTimeout(() => {
                    waiting.delete(id)
                    discard()
                    reject(new BridgeUnavailableError('bridge から応答がありません'))
                }, timeoutMs)
                waiting.set(id, {
                    resolve: (value) => { clearTimeout(timer); resolve(value as BridgeResults[T]) },
                    reject: (error) => { clearTimeout(timer); reject(error) },
                })
                port.postMessage({ id, request } satisfies BridgeEnvelope)
            })
        },
    }
}

export { getBridge, BridgeUnavailableError, isExtensionContextValid }
export type { BridgeConnection }
