const DB_NAME = "RecordingDB"
const STORE_NAME = "Chunks"

const openDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBRequest).result as IDBDatabase
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "timestamp" })
            }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

const saveTempChunk = async (blob: Blob) => {
    const db = await openDB()
    const tx = db.transaction('Temps', "readwrite")
    const store = tx.objectStore('Temps')

    return new Promise((resolve, reject) => {
        const request = store.put({
            timestamp: Date.now(),
            chunk: blob
        })

        request.onsuccess = () => {
            // console.log("Chunk saved successfully with key:", request.result)
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

const saveChunk = async (blob: Blob, imgUrl: string): Promise<IDBValidKey> => {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)

    return new Promise((resolve, reject) => {
        const request = store.put({
            timestamp: Date.now(),
            chunk: blob,
            imgUrl: imgUrl
        })

        request.onsuccess = () => {
            console.log("Chunk saved successfully with key:", request.result)
            resolve(request.result) // 保存されたキーを返す
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

const cleanUp = async (): Promise<void> => {
    const db = await openDB()
    const chunks = await getAllChunks()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)

    for (const item of chunks) {
        const deleteRequest = store.delete(item.timestamp)

        deleteRequest.onsuccess = () => {
            console.log(`Deleted chunk with timestamp: ${item.timestamp}`)
        }

        deleteRequest.onerror = () => {
            console.error(`Failed to delete chunk: ${deleteRequest.error}`)
        }
    }
}

const getChunkByKey = async (key: IDBValidKey): Promise<{ timestamp: number, chunk: Blob, imgUrl: string } | undefined> => {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readonly")
    const store = tx.objectStore(STORE_NAME)

    return new Promise((resolve, reject) => {
        const request = store.get(key)

        request.onsuccess = () => {
            if (request.result) {
                // console.log("Chunk retrieved:", request.result)
                resolve(request.result)
            } else {
                console.warn("No chunk found for key:", key)
                resolve(undefined)
            }
        }

        request.onerror = () => {
            console.error("Failed to retrieve chunk:", request.error)
            reject(request.error)
        }
    })
}


const getAllChunks = async (): Promise<Array<{ timestamp: number; chunk: Blob, imgUrl: string }>> => {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readonly")
    const store = tx.objectStore(STORE_NAME)

    return new Promise((resolve, reject) => {
        const chunks: Array<{ timestamp: number; chunk: Blob, imgUrl: string }> = []
        const request = store.openCursor()

        request.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result
            if (cursor) {
                // console.log("Found chunk:", cursor.value)
                chunks.push(cursor.value)
                cursor.continue()
            } else {
                // console.log("All chunks retrieved:", chunks)
                resolve(chunks)
            }
        };

        request.onerror = () => reject(request.error)
    })
}

const cleanUpOldData = async (maxStorageSize: number): Promise<IDBValidKey[]> => {
    try {
        const { usage } = await navigator.storage.estimate()
        const deletedKeys: IDBValidKey[] = [] // 削除したキーを格納する配列

        if (usage && usage > maxStorageSize) {
            // console.warn(`ストレージ超過: ${usage} バイト使用中（上限: ${maxStorageSize} バイト）`)

            const db = await openDB()
            const tx = db.transaction(STORE_NAME, "readwrite")
            const store = tx.objectStore(STORE_NAME)

            return new Promise<IDBValidKey[]>((resolve, reject) => { // 型を明示
                let totalSize = usage
                const request = store.openCursor()

                request.onsuccess = (event) => {
                    const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result
                    if (cursor && totalSize > maxStorageSize) {
                        const value = cursor.value

                        if (value.chunk instanceof Blob) {
                            totalSize -= value.chunk.size // Blob のサイズ分を減算
                        } else {
                            totalSize -= new Blob([JSON.stringify(value)]).size
                        }

                        // console.log(`削除:`, cursor.key)
                        deletedKeys.push(cursor.key) // 削除したキーを保存
                        cursor.delete() // 古いデータから削除
                        cursor.continue() // 次のデータへ
                    } else {
                        resolve(deletedKeys) // 削除処理が完了したらキーを返す
                    }
                }

                request.onerror = () => {
                    console.error("IndexedDB のクリーンアップ中にエラーが発生しました:", request.error)
                    reject(request.error)
                }
            })
        } else {
            // console.log("ストレージは問題なし。削除不要。")
            return Promise.resolve([]) // Promise を返すことで型を統一
        }
    } catch (error) {
        console.error("ストレージ管理エラー:", error)
        return Promise.resolve([]) // 例外時も Promise を返して型を統一
    }
}

export { saveChunk, saveTempChunk, getChunkByKey, getAllChunks, cleanUp, cleanUpOldData }
