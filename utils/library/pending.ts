// 拡張機能側に保存できない間（拡張機能が更新された直後など）の録画中の書き込みを、
// ニコ生側（ページの IndexedDB）に一時保存しておき、次にページを開いた時に拡張機能側へ移す
import type { BridgeRequest } from './protocol'

const DB_NAME = 'PlaybackPending'
const STORE = 'requests'

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

const savePendingRequest = (request: BridgeRequest) => run('readwrite', store => store.add(request))

// 一時保存した書き込みを、届いた順に send で送る。送れたものから消す
// 送り先とやり取りできない（isUnavailable が true の）エラーになったら、残りは次の機会に回す。
// それ以外のエラー（区間が消されていた など）は、送っても意味がないので捨てる
// 送った数と、一時保存した書き込みが残っていないか（送っている間に増えた分も送る）を返す
const flushPendingRequests = async (
    send: (request: BridgeRequest) => Promise<unknown>,
    isUnavailable: (error: unknown) => boolean,
): Promise<{ sent: number, complete: boolean }> => {
    if (!(await hasPendingDB())) return { sent: 0, complete: true }

    let sent = 0
    for (;;) {
        const keys = await run('readonly', store => store.getAllKeys())
        if (keys.length === 0) return { sent, complete: true }
        for (const key of keys) {
            const request = await run<BridgeRequest | undefined>('readonly', store => store.get(key))
            if (request) {
                try {
                    await send(request)
                    sent++
                } catch (error) {
                    if (isUnavailable(error)) return { sent, complete: false }
                    console.log('一時保存した書き込みを移せなかったため捨てます:', request.type, error)
                }
            }
            await run('readwrite', store => store.delete(key))
        }
    }
}

// 一時保存した書き込みをすべて消す（すべての録画を削除した時）
const clearPendingRequests = async () => {
    if (!(await hasPendingDB())) return
    await run('readwrite', store => store.clear())
}

export { savePendingRequest, flushPendingRequests, clearPendingRequests }
