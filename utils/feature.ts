import { getChunkByKey } from "../hooks/indexedDB/recordingDB"

const getProgramData = () => {
    // ユーザー名を取得
    const ldJson = document.querySelector('script[type="application/ld+json"]')
    const data = JSON.parse(ldJson!.textContent!)
    const userName_ = data.author?.name
    const userName = (userName_ || '').replace(/[\\/:*?"<>|]/g, '')

    // タイトルを取得
    let title_ = ''
    const meta = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null
    if (meta) title_ = meta.content
    const title = (title_ || '').replace(/[\\/:*?"<>|]/g, '')

    return { userName, title }
}

// 動画の最初のフレームを取得する関数
const extractFirstFrame = async (blob: Blob) => {

    if (!blob.type.startsWith('video/')) {
        console.log(`Invalid blob type: ${blob.type}, returning default image`)
        return ''
    }

    const video = document.createElement('video')
    const objectURL = URL.createObjectURL(blob)
    video.preload = "auto"
    video.src = objectURL
    video.muted = true
    video.playsInline = true

    return new Promise((resolve) => {
        const cleanUp = () => {
            URL.revokeObjectURL(objectURL)
            video.remove()
        }

        video.onloadeddata = () => {
            video.currentTime = 0
        }

        video.onseeked = () => {
            setTimeout(() => {  // ★ 500ms 待ってからキャプチャ
                try {
                    const canvas = document.createElement('canvas')
                    const aspectRatio = video.videoHeight / video.videoWidth
                    canvas.width = 100
                    canvas.height = Math.round(100 * aspectRatio)

                    const ctx = canvas.getContext('2d', { willReadFrequently: true })
                    if (ctx) {
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                        resolve(canvas.toDataURL('image/jpeg', 0.7)) // 成功時はJPEGデータを返す
                    } else {
                        console.log('Canvas context is not available, returning default image')
                        resolve('') // エラー時は空を返す
                    }
                } catch (err) {
                    console.log('Error capturing first frame:', err)
                    resolve('') // エラー時は空を返す
                } finally {
                    cleanUp()
                }
            }, 500)
        }

        video.onerror = (e) => {
            console.log('Video load error:', e)
            cleanUp()
            resolve('') // エラー時は空を返す
        }
    })
}

const downloadRecordedMovie = async (key: [string, number]) => {
    try {
        const chunk = await getChunkByKey('Chunks', key)
        if (!chunk) {
            alert('動画データが見つかりませんでした')
            return
        }

        const url = URL.createObjectURL(chunk.blob)

        // ダウンロードファイル名を生成
        const formattedDate = formatDateForFileName(chunk.createdAt)
        const filename = `${chunk.userName} ${chunk.title || ''} ${formattedDate}.mp4`

        // 一時的にaタグを作成して自動クリック
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)

        // メモリ解放
        URL.revokeObjectURL(url)
    } catch (error) {
        console.error('ダウンロード中にエラーが発生しました:', error)
        alert('ダウンロードに失敗しました')
    }
}

// 動画のスクリーンショットを取得してダウンロードする関数
const getScreenShotAndDownload = async () => {
    const video = document.querySelector("video") as HTMLVideoElement
    if (!video) return
    if (video.readyState < 2) return // 動画が準備完了していない場合は何もしない

    try {
        const canvas = document.createElement("canvas")
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("Canvas 2D context not available")

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

        // toBlobの使用（非同期でUIフリーズ回避）
        canvas.toBlob((blob) => {
            if (!blob) return

            const a = document.createElement("a")
            const url = URL.createObjectURL(blob)

            const { userName, title } = getProgramData()
            const timeString = formatDateForFileName(Date.now())
            a.download = `${userName} ${title} ${timeString}.png`
            a.href = url
            a.click()

            URL.revokeObjectURL(url)
        }, "image/png")
    } catch (err) {
        console.error("スクリーンショット処理中にエラー:", err)
    }
}

const formatDateForFileName = (input: string | number) => {
    const date = new Date(input)

    const pad = (n: number) => n.toString().padStart(2, '0')

    const year = date.getFullYear()
    const month = pad(date.getMonth() + 1)
    const day = pad(date.getDate())
    const hours = pad(date.getHours())
    const minutes = pad(date.getMinutes())
    const seconds = pad(date.getSeconds())

    return `${year}-${month}-${day} ${hours}${minutes}${seconds}`
}

const formatDate = (input: string | number) => {
    const date = new Date(input)

    const pad = (n: number) => n.toString().padStart(2, '0')

    const year = date.getFullYear()
    const month = pad(date.getMonth() + 1)
    const day = pad(date.getDate())
    const hours = pad(date.getHours())
    const minutes = pad(date.getMinutes())
    const seconds = pad(date.getSeconds())

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}




export {
    getProgramData,
    extractFirstFrame,
    downloadRecordedMovie,
    getScreenShotAndDownload,
    formatDateForFileName,
    formatDate
}