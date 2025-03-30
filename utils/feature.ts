import { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks, deleteDB } from "../hooks/indexedDB/recordingDB"

const getProgramData = () => {
    // ユーザー名を取得
    const userName_ = document.querySelector('[class*="_user-name_"]') as HTMLSpanElement | null
    const userName = (userName_?.textContent || '').replace(/[\\/:*?"<>|]/g, '')

    // タイトルを取得
    const title_ = document.querySelector('[class*="_program-title_"]') as HTMLSpanElement | null
    const title = (title_?.textContent || '').replace(/[\\/:*?"<>|]/g, '')
    
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
        const filename = `${chunk.userName}_${chunk.title}_${chunk.createdAt}.mp4`

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
const getScreenShotAndDownload = () => {

    let video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    if (!video) {
        console.error("Video element not found")
        return
    }
    // canvas要素を作成
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")

    // canvasのサイズをvideoのサイズに設定
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    // videoの現在のフレームをcanvasに描画
    ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)

    // 画像データを取得
    const imgUrl = canvas.toDataURL("image/png")

    // ダウンロード用の<a>タグを作成
    const a = document.createElement("a")
    a.href = imgUrl

    // ダウンロード用ファイル名を生成
    const { userName, title } = getProgramData()
    const now = Date.now()
    a.download = `${userName}_${title}_${new Date(now).toLocaleString()}.png`

    // 自動クリックでダウンロードを実行
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
}

export { getProgramData, extractFirstFrame, downloadRecordedMovie, getScreenShotAndDownload }