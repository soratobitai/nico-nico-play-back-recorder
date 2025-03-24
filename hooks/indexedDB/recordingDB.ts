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
                    db.createObjectStore(storeName, { keyPath: "timestamp" });
                }
            });
        };
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

const saveChunk = async (storeName: string, blob: Blob, imgUrl: string | null): Promise<IDBValidKey> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readwrite")
    const store = tx.objectStore(storeName)

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

const getChunkByKey = async (storeName: string, key: IDBValidKey): Promise<{ timestamp: number, chunk: Blob, imgUrl: string | null } | undefined> => {
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


const getAllChunks = async (storeName: string): Promise<Array<{ timestamp: number; chunk: Blob, imgUrl: string | null }>> => {
    const db = await openDB()
    const tx = db.transaction(storeName, "readonly")
    const store = tx.objectStore(storeName)

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
        const deletedKeys: IDBValidKey[] = [] // 削除したキーを格納する配列

        if (usage && usage > maxStorageSize) {
            // console.warn(`ストレージ超過: ${usage} バイト使用中（上限: ${maxStorageSize} バイト）`)

            const db = await openDB()
            const tx = db.transaction(storeName, "readwrite")
            const store = tx.objectStore(storeName)

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

                        console.log(`ストレージ超過のため削除:`, cursor.key)
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

const cleanUpAllChunks = async (storeName: string): Promise<void> => {
    const db = await openDB()
    const chunks = await getAllChunks(storeName)
    const tx = db.transaction(storeName, "readwrite")
    const store = tx.objectStore(storeName)

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

export { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks }
