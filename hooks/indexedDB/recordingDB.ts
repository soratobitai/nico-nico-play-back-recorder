// 以前のバージョンの録画の保存先（ニコ生のサイトデータの IndexedDB）
// 今は拡張機能側に保存している（utils/library）。ここは、以前の録画を拡張機能側へ移す
// （utils/library/migrate.ts）ためだけに残している。
const DB_NAME = "RecordingDB"
const DB_VERSION = 1
const STORE_NAMES = ["Chunks", "Temps"]

// Chunks: 結合済みの録画、Temps: 録画中の（結合される前の）チャンク
type ChunkRecord = {
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    imgUrl: string | null,
    createdAt: number,
    userName: string | null,
    title: string | null
}

// 接続は使い回す（操作のたびに開くと、閉じられないまま接続が増えていく）
let dbPromise: Promise<IDBDatabase> | null = null

// create: なければ作る（テストで以前の録画を用意する時だけ）。それ以外は作らない
// （消した直後に、待たされていた読み込みで空の保存先が作り直され、以前の録画があるように見え続けないように）
const openDB = ({ create = false } = {}): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = (event) => {
            if (event.oldVersion === 0 && !create) {
                request.transaction?.abort()
                return
            }
            const db = (event.target as IDBOpenDBRequest).result;
            STORE_NAMES.forEach((storeName) => {
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName, { keyPath: ['sessionId', 'chunkIndex'] })
                }
            })
        }
        request.onsuccess = () => {
            const db = request.result
            // 他のタブなどから DB の削除・更新が要求されたら、妨げないように閉じて次回開き直す
            db.onversionchange = () => {
                db.close()
                dbPromise = null
            }
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
    return dbPromise
}

// 以前のバージョンの録画が残っているか（なければ DB を作らずに済ませる）
const hasLegacyDatabase = async () => {
    if (!indexedDB.databases) return true
    return (await indexedDB.databases()).some(db => db.name === DB_NAME)
}

// 以前のバージョンと同じ形で保存する（テストで以前の録画を用意するため）
const saveChunk = async (
    storeName: string,
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    imgUrl: string | null,
    createdAt: number | null,
    userName: string | null = null,
    title: string | null = null,
): Promise<void> => {
    const db = await openDB({ create: true })
    const tx = db.transaction(storeName, "readwrite")
    tx.objectStore(storeName).put({ sessionId, chunkIndex, blob, imgUrl, createdAt: createdAt || Date.now(), userName, title })

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"))
    })
}

// すべてのデータを createdAt の古い順で取得する
const getAllChunks = async (storeName: string): Promise<ChunkRecord[]> => {
    const db = await openDB()
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll()

    return new Promise((resolve, reject) => {
        request.onsuccess = () => {
            const chunks: ChunkRecord[] = request.result.map(data => ({
                sessionId: data.sessionId,
                chunkIndex: data.chunkIndex,
                blob: data.blob,
                imgUrl: data.imgUrl || null,
                createdAt: data.createdAt,
                userName: data.userName || null,
                title: data.title || null,
            }))
            resolve(chunks.sort((a, b) => a.createdAt - b.createdAt))
        }
        request.onerror = () => reject(request.error)
    })
}

const deleteChunkByKeys = async (storeName: string, keys: IDBValidKey[]): Promise<void> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readwrite")
    const store = tx.objectStore(storeName)
    keys.forEach(key => store.delete(key))

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"))
    })
}

// 接続を閉じる（数えただけのタブが接続を持ち続けると、他のタブで保存先を消す時に待たされるので）
const closeLegacyDatabase = async () => {
    const opened = dbPromise
    dbPromise = null
    ;(await opened?.catch(() => null))?.close()
}

// 以前のバージョンの保存先をまるごと消す
const deleteLegacyDatabase = async (): Promise<void> => {
    if (dbPromise) {
        (await dbPromise.catch(() => null))?.close()
        dbPromise = null
    }
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME)
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
        // 古いバージョンのスクリプトが開いたままのタブがあると、すぐには消せない（そのタブを閉じれば消える）。
        // 消えるのを待たずに終える（取り込みが終わらないままにならないように）
        request.onblocked = () => {
            console.log('以前の録画の保存先は、開いているタブがあるため後で消えます')
            resolve()
        }
    })
}

export {
    hasLegacyDatabase,
    saveChunk,
    getAllChunks,
    deleteChunkByKeys,
    deleteLegacyDatabase,
    closeLegacyDatabase,
}
export type { ChunkRecord }
