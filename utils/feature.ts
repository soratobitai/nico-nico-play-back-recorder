import { getChunkByKey } from "../hooks/indexedDB/recordingDB"

const getProgramData = () => {
    // ユーザー名を取得（ページの構造が変わって取れなくても、録画は続けられるように空にする）
    let userName_ = ''
    try {
        const ldJson = document.querySelector('script[type="application/ld+json"]')
        const name = JSON.parse(ldJson?.textContent || '{}')?.author?.name
        if (typeof name === 'string') userName_ = name
    } catch (error) {
        console.log('ユーザー名の取得に失敗しました:', error)
    }
    const userName = userName_.replace(/[\\/:*?"<>|]/g, '')

    // タイトルを取得
    let title_ = ''
    const meta = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null
    if (meta) title_ = meta.content
    const title = (title_ || '').replace(/[\\/:*?"<>|]/g, '')

    return { userName, title }
}

// 動画の最初のフレームを取得する関数
// 成功時は JPEG の dataURL、動画として読み込めない場合は ''、時間内に取得できなかった場合は null を返す
const extractFirstFrame = async (blob: Blob, timeoutMs: number = 10 * 1000): Promise<string | null> => {

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
        let settled = false
        const finish = (result: string | null) => {
            if (settled) return
            settled = true
            clearTimeout(timeoutId)
            URL.revokeObjectURL(objectURL)
            video.remove()
            resolve(result)
        }

        // イベントが発火しないまま待ち続けないようにする
        const timeoutId = setTimeout(() => {
            console.log('Timed out while capturing first frame')
            finish(null)
        }, timeoutMs)

        video.onloadeddata = () => {
            video.currentTime = 0
        }

        video.onseeked = () => {
            setTimeout(() => {  // ★ 500ms 待ってからキャプチャ
                if (settled) return
                try {
                    const canvas = document.createElement('canvas')
                    const aspectRatio = video.videoHeight / video.videoWidth
                    canvas.width = 100
                    canvas.height = Math.round(100 * aspectRatio)

                    const ctx = canvas.getContext('2d', { willReadFrequently: true })
                    if (ctx) {
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                        finish(canvas.toDataURL('image/jpeg', 0.7)) // 成功時はJPEGデータを返す
                    } else {
                        console.log('Canvas context is not available, returning default image')
                        finish(null) // 動画の問題ではないのでデフォルト画像にする
                    }
                } catch (err) {
                    console.log('Error capturing first frame:', err)
                    finish('') // エラー時は空を返す
                }
            }, 500)
        }

        video.onerror = (e) => {
            console.log('Video load error:', e)
            finish('') // エラー時は空を返す
        }
    })
}

// Blob をファイルとしてダウンロードする
const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)

    // 一時的にaタグを作成して自動クリック
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()

    // クリック直後に解放するとダウンロードが始まる前に読めなくなることがあるので、少し待ってから解放する
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000)
}

// 動画の形式からダウンロード時の拡張子を決める（webm で録画した環境以外は mp4）
const getVideoExtension = (type: string) => type.startsWith('video/webm') ? 'webm' : 'mp4'

const downloadRecordedMovie = async (key: [string, number]) => {
    try {
        const chunk = await getChunkByKey('Chunks', key)
        if (!chunk) {
            alert('動画データが見つかりませんでした')
            return
        }

        // ダウンロードファイル名を生成
        const formattedDate = formatDateForFileName(chunk.createdAt)
        const filename = `${chunk.userName || ''}_${chunk.title || ''}_${formattedDate}.${getVideoExtension(chunk.blob.type)}`

        downloadBlob(chunk.blob, filename)
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

            const { userName, title } = getProgramData()
            const timeString = formatDateForFileName(Date.now())
            downloadBlob(blob, `${userName}_${title}_${timeString}.png`)
        }, "image/png")
    } catch (err) {
        console.error("スクリーンショット処理中にエラー:", err)
    }
}

// 日時を「YYYY-MM-DD hh mm ss」の形にする（時・分・秒の区切りを timeSeparator で指定する）
const formatDateTime = (input: string | number, timeSeparator: string) => {
    const date = new Date(input)

    const pad = (n: number) => n.toString().padStart(2, '0')

    const year = date.getFullYear()
    const month = pad(date.getMonth() + 1)
    const day = pad(date.getDate())
    const hours = pad(date.getHours())
    const minutes = pad(date.getMinutes())
    const seconds = pad(date.getSeconds())

    return `${year}-${month}-${day} ${[hours, minutes, seconds].join(timeSeparator)}`
}

// ファイル名用（ファイル名に使えない「:」を含めない）: 2025-01-02 030405
const formatDateForFileName = (input: string | number) => formatDateTime(input, '')

// 表示用: 2025-01-02 03:04:05
const formatDate = (input: string | number) => formatDateTime(input, ':')




export {
    getProgramData,
    extractFirstFrame,
    getVideoExtension,
    downloadRecordedMovie,
    getScreenShotAndDownload,
    formatDateForFileName,
    formatDate
}