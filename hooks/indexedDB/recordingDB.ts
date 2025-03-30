const DB_NAME = "RecordingDB"
const DB_VERSION = 1
const STORE_NAMES = ["Chunks", "Temps"]

const openDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            STORE_NAMES.forEach((storeName) => {
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName, { keyPath: ['sessionId', 'chunkIndex'] })
                }
            })
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

const saveChunk = async (
    storeName: string,
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    imgUrl: string | null,
    createdAt: number | null,
    userName: string | null = null,
    title: string | null = null,
    ): Promise<[string, number]> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readwrite")
    const store = tx.objectStore(storeName)

    return new Promise((resolve, reject) => {
        const data = {
            sessionId,
            chunkIndex,
            blob,
            imgUrl,
            createdAt: createdAt || Date.now(),
            userName,
            title,
        }

        const request = store.put(data)

        request.onsuccess = () => {
            const key: [string, number] = [sessionId, chunkIndex]  // 🔹 明示的に key をセット
            console.log("Chunk saved successfully with key:", key)
            resolve(key)
        }

        request.onerror = () => {
            console.error("Failed to save chunk:", request.error)
            reject(request.error)
        }

        tx.onabort = () => {
            console.error("Transaction aborted")
            reject(new Error("Transaction aborted"))
        }
    })
}


const getChunkByKey = async (
    storeName: string,
    key: IDBValidKey
): Promise<{
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    imgUrl: string | null,
    createdAt: number,
    userName: string | null,
    title: string | null
} | undefined> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readonly")
    const store = tx.objectStore(storeName)

    return new Promise((resolve, reject) => {
        const request = store.get(key)

        request.onsuccess = () => {
            if (request.result) {
                // console.log("Chunk retrieved:", request.result)
                resolve(request.result)
            } else {
                console.log("No chunk found for key:", key)
                resolve(undefined)
            }
        }

        request.onerror = () => {
            console.error("Failed to retrieve chunk:", request.error)
            reject(request.error)
        }
    })
}

const getAllChunks = async (
    storeName: string
): Promise<Array<{
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    imgUrl: string | null,
    createdAt: number,
    userName: string | null,
    title: string | null
}>> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readonly")
    const store = tx.objectStore(storeName)

    return new Promise((resolve, reject) => {
        const chunks: Array<{
            sessionId: string,
            chunkIndex: number,
            blob: Blob,
            imgUrl: string | null,
            createdAt: number,
            userName: string | null,
            title: string | null }> = []
        const request = store.openCursor()

        request.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result
            if (cursor) {
                const [sessionId, chunkIndex] = cursor.key as [string, number]  // キーを取得
                const data = cursor.value

                chunks.push({
                    sessionId,
                    chunkIndex,
                    blob: data.blob,
                    imgUrl: data.imgUrl || null,
                    createdAt: data.createdAt,
                    userName: data.userName || null,
                    title: data.title || null,
                })

                cursor.continue()
            } else {
                // すべてのデータを取得した後に createdAt でソート
                chunks.sort((a, b) => a.createdAt - b.createdAt)
                resolve(chunks)
            }
        }

        request.onerror = () => reject(request.error)
    })
}

const deleteChunkByKeys = async (storeName: string, keys: IDBValidKey[]): Promise<void> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readwrite")
    const store = tx.objectStore(storeName)

    return new Promise((resolve, reject) => {
        let remaining = keys.length

        if (remaining === 0) {
            resolve()
            return
        }

        keys.forEach(key => {
            const request = store.delete(key)

            request.onsuccess = () => {
                remaining--
                if (remaining === 0) {
                    resolve()
                }
            }

            request.onerror = () => {
                console.error("Failed to delete temp for key:", key, request.error)
                reject(request.error)
            }
        })
    })
}

const cleanUpOldChunks = async (storeName: string, maxStorageSize: number): Promise<IDBValidKey[]> => {
    try {
        const { usage } = await navigator.storage.estimate()
        const deletedKeys: IDBValidKey[] = []

        if (usage && usage > maxStorageSize) {
            console.log(`ストレージ超過: ${usage} バイト使用中（上限: ${maxStorageSize} バイト）`)

            const chunks = await getAllChunks(storeName) // getAllChunksを使って全データを取得
            let totalSize = usage

            for (const chunk of chunks) {
                if (totalSize <= maxStorageSize) break // 削除が不要になったら終了

                // データサイズを計算して減算
                if (chunk.blob instanceof Blob) {
                    totalSize -= chunk.blob.size
                } else {
                    totalSize -= new Blob([JSON.stringify(chunk)]).size
                }

                const key = [chunk.sessionId, chunk.chunkIndex] as [string, number]  // 複合キーを取得
                // console.log(`ストレージ超過のため削除:`, key)
                deletedKeys.push(key) // 複合キーを保存
            }

            await deleteChunkByKeys(storeName, deletedKeys) // 既存の削除関数を利用

            return deletedKeys
        } else {
            console.log("ストレージ容量超過はありません")
            return []
        }
    } catch (error) {
        console.error("ストレージ管理エラー:", error)
        return []
    }
}

const cleanUpAllChunks = async (storeName: string): Promise<void> => {
    const db = await openDB()
    const chunks = await getAllChunks(storeName)
    const tx = db.transaction(storeName, "readwrite")
    const store = tx.objectStore(storeName)

    for (const chunk of chunks) {
        const deleteRequest = store.delete([chunk.sessionId, chunk.chunkIndex])

        deleteRequest.onsuccess = () => {
            // console.log(`Deleted chunk: ${[chunk.sessionId, chunk.chunkIndex]}`)
        }

        deleteRequest.onerror = () => {
            console.error(`Failed to delete chunk: ${deleteRequest.error}`)
        }
    }
}

const deleteDB = (dbName: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName)

        request.onsuccess = () => {
            console.log(`Database ${dbName} deleted successfully.`)
            resolve()
        }

        request.onerror = () => {
            console.error(`Failed to delete database ${dbName}:`, request.error)
            reject(request.error)
        }

        request.onblocked = () => {
            console.log(`Database deletion is blocked. Close all connections to the database.`)
        }
    })
}


export { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks, deleteDB }
