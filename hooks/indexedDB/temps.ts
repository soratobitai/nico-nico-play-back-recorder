const DB_NAME = "RecordingDB"
const DB_VERSION = 2
const STORE_NAME = "Temps"

const openDB = (): Promise<IDBDatabase> => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)
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

const saveTemp = async (blob: Blob) => {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)

    return new Promise((resolve, reject) => {
        const request = store.put({
            timestamp: Date.now(),
            temp: blob
        })

        request.onsuccess = () => {
            console.log("temp saved successfully with key:", request.result)
        }

        request.onerror = () => {
            console.error("Failed to save temp:", request.error)
            reject(request.error)
        }

        tx.onabort = () => {
            console.error("Transaction aborted")
            reject(new Error("Transaction aborted"))
        }
    })
}

const cleanUpAllTemps = async (): Promise<void> => {
    const db = await openDB()
    const temps = await getAllTemps()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)

    for (const item of temps) {
        const deleteRequest = store.delete(item.timestamp)

        deleteRequest.onsuccess = () => {
            console.log(`Deleted temp with timestamp: ${item.timestamp}`)
        }

        deleteRequest.onerror = () => {
            console.error(`Failed to delete temp: ${deleteRequest.error}`)
        }
    }
}

const deleteTempByKeys = async (keys: IDBValidKey[]): Promise<void> => {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readwrite")
    const store = tx.objectStore(STORE_NAME)

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


const getAllTemps = async (): Promise<Array<{ timestamp: number; temp: Blob }>> => {
    const db = await openDB()
    const tx = db.transaction(STORE_NAME, "readonly")
    const store = tx.objectStore(STORE_NAME)

    return new Promise((resolve, reject) => {
        const temps: Array<{ timestamp: number; temp: Blob }> = []
        const request = store.openCursor()

        request.onsuccess = (event) => {
            const cursor = (event.target as IDBRequest).result
            if (cursor) {
                // console.log("Found temp:", cursor.value)
                temps.push(cursor.value)
                cursor.continue()
            } else {
                // console.log("All temps retrieved:", temps)
                resolve(temps)
            }
        };

        request.onerror = () => reject(request.error)
    })
}

export { saveTemp, deleteTempByKeys, getAllTemps, cleanUpAllTemps }
