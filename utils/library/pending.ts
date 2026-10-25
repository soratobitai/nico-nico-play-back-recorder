// 拡張機能側に保存できない間（拡張機能が更新された直後など）の録画中の書き込みを、
// ニコ生側（ページの IndexedDB）に一時保存しておき、次にページを開いた時に拡張機能側へ移す
// 一時保存はニコ生のページの IndexedDB にあり、ページのスクリプトも読み書きできる。そこで、拡張機能だけが知っている鍵で
// 依頼に印（HMAC）を付けて保存し、印の正しい依頼だけを移す（ページのスクリプトが「すべて消す」などの依頼を
// 紛れ込ませても、拡張機能側へは送らない）。移すのは録画中の書き込みの種類だけ
import { WRITE_REQUEST_TYPES, type BridgeRequest } from './protocol'

const DB_NAME = 'PlaybackPending'
const STORE = 'requests'

type PendingRecord = { request: BridgeRequest, signature: ArrayBuffer }

let dbPromise: Promise<IDBDatabase> | null = null

const openPendingDB = (): Promise<IDBDatabase> => dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true })
    request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => {
            db.close()
            dbPromise = null
        }
        // サイトデータが消されるなどして閉じられたら、次に開き直す（開いたままの接続を使い続けて、保存に失敗し続けないように）
        db.onclose = () => {
            dbPromise = null
        }
        resolve(db)
    }
    request.onerror = () => {
        dbPromise = null
        reject(request.error)
    }
})

const run = async <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>) => {
    const db = await openPendingDB()
    return new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode)
        const request = fn(tx.objectStore(STORE))
        tx.oncomplete = () => resolve(request.result)
        tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
}

// 一時保存したことがなければ、DB を作らずに済ませる
const hasPendingDB = async () => {
    if (!indexedDB.databases) return true
    return (await indexedDB.databases()).some(db => db.name === DB_NAME)
}

// ---- 印（HMAC） ----

let signingKey: CryptoKey | null = null

// 印に使う鍵を設定する（拡張機能の保存領域に置いた鍵。拡張機能が更新された後も一時保存できるように、ページを開いた時に読んでおく）
const setPendingSigningKey = async (raw: Uint8Array) => {
    signingKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

const toHex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')

// 印を付ける中身（Blob は中身のハッシュにする。オブジェクトはキーの順にそろえる）
// 種類ごとに印を付けて、Blob と同じ形のオブジェクトなど、別の種類の値と同じ中身にならないようにする。数でない数（NaN など）は印を付けない
// （この形を変えると、更新する前に一時保存した分を、更新した後に移せなくなる）
const canonical = async (value: unknown): Promise<unknown> => {
    if (value instanceof Blob) return ['blob', toHex(await crypto.subtle.digest('SHA-256', await value.arrayBuffer())), value.size, value.type]
    if (Array.isArray(value)) return ['array', await Promise.all(value.map(canonical))]
    if (value && typeof value === 'object') {
        const entries: unknown[] = []
        for (const key of Object.keys(value).sort()) entries.push([key, await canonical((value as Record<string, unknown>)[key])])
        return ['object', entries]
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('数でない値には印を付けません')
    return value
}

// 録画の書き込みとして正しい形か（データは Blob で、数は数。印が正しくても、形のおかしい依頼は送らない）
const isFiniteNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
const isWellFormed = (request: BridgeRequest) => {
    switch (request.type) {
        case 'setSegmentInit': return typeof request.segmentId === 'string' && request.init instanceof Blob
        case 'appendFragments':
            return typeof request.segmentId === 'string' && Array.isArray(request.fragments) && request.fragments.every(f =>
                !!f && f.blob instanceof Blob && [f.index, f.moofSize, f.startTime, f.duration, f.wallClock].every(isFiniteNumber))
        case 'createSegment': return !!request.segment && typeof request.segment.segmentId === 'string' && isFiniteNumber(request.segment.startedAt)
        case 'finishSegment': return typeof request.segmentId === 'string' && isFiniteNumber(request.endedAt)
        case 'deleteSegments': return Array.isArray(request.segmentIds) && request.segmentIds.every(id => typeof id === 'string')
        default: return false
    }
}
const signedBytes = async (request: BridgeRequest) => new TextEncoder().encode(JSON.stringify(await canonical(request)))

// 拡張機能が書いた依頼なら、その依頼（録画中の書き込みの種類で、印が正しい）。そうでなければ null
const genuineRequest = async (record: unknown): Promise<BridgeRequest | null> => {
    if (!signingKey || !record || typeof record !== 'object') return null
    const { request, signature } = record as Partial<PendingRecord>
    if (!request || typeof request !== 'object' || !WRITE_REQUEST_TYPES.has(request.type) || !(signature instanceof ArrayBuffer)) return null
    try {
        if (!isWellFormed(request)) return null
        return await crypto.subtle.verify('HMAC', signingKey, signature, await signedBytes(request)) ? request : null
    } catch {
        return null
    }
}

// 一時保存する（鍵がなければ、移せない依頼になるので保存しない）
const savePendingRequest = async (request: BridgeRequest) => {
    if (!signingKey) throw new Error('一時保存の鍵がありません')
    const signature = await crypto.subtle.sign('HMAC', signingKey, await signedBytes(request))
    const record: PendingRecord = { request, signature }
    await run('readwrite', store => store.add(record))
}

type FlushOptions = {
    send: (request: BridgeRequest) => Promise<unknown>
    // 送っても意味がないので捨ててよいエラー（区間が消されていた・同じ区間をもう作ってあった など）
    isDiscardable: (error: unknown) => boolean
}

// 一時保存した書き込みを、届いた順に send で送る。送れたものから消す
// 捨ててよいエラーなら捨てて続ける。それ以外（拡張機能側とやり取りできない・容量不足 など）は、残りを次の機会に回す
// 印の正しくない依頼（ページのスクリプトが入れたもの）は、送らずに捨てる。鍵がなければ移さない
// 送った数と、一時保存した書き込みが残っていないか（送っている間に増えた分も送る）を返す
const flushPendingRequests = async ({ send, isDiscardable }: FlushOptions): Promise<{ sent: number, complete: boolean }> => {
    if (!(await hasPendingDB())) return { sent: 0, complete: true }
    if (!signingKey) return { sent: 0, complete: false }

    let sent = 0
    for (;;) {
        const keys = await run('readonly', store => store.getAllKeys())
        if (keys.length === 0) return { sent, complete: true }
        for (const key of keys) {
            const record = await run<unknown>('readonly', store => store.get(key))
            const request = await genuineRequest(record)
            if (request) {
                try {
                    await send(request)
                    sent++
                } catch (error) {
                    if (!isDiscardable(error)) return { sent, complete: false }
                    console.log('一時保存した書き込みを移せなかったため捨てます:', request.type, error)
                }
            } else if (record !== undefined) {
                console.log('拡張機能が書いたものではない一時保存の依頼を捨てます')
            }
            await run('readwrite', store => store.delete(key))
        }
    }
}

// 一時保存した録画のデータを消す（すべての録画を削除した時）
// 区間を作る・確定する依頼などは残す（録画中の区間を一時保存していた場合に、続きを保存できるように。
// 終えた区間は、断片がないので移す時に消える）
const clearPendingRequests = async () => {
    if (!(await hasPendingDB())) return
    const db = await openPendingDB()
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        const request = tx.objectStore(STORE).openCursor()
        request.onsuccess = () => {
            const cursor = request.result
            if (!cursor) return
            if ((cursor.value as Partial<PendingRecord> | undefined)?.request?.type === 'appendFragments') cursor.delete()
            cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'))
    })
}

export { setPendingSigningKey, savePendingRequest, flushPendingRequests, clearPendingRequests }
