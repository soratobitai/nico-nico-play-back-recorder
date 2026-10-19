import { getSegmentFile } from "./library/api"

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

// ライブ映像の今のコマを、録画リスト用の小さなサムネイル（JPEG の data URL）にする
// 映像がまだ表示されていない場合は null（デフォルトの画像で表示される）
const captureThumbnail = (video: HTMLVideoElement | null, width = 160): string | null => {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
    try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = Math.round(width * video.videoHeight / video.videoWidth)
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL('image/jpeg', 0.7)
    } catch (error) {
        console.log('サムネイルを作れませんでした:', error)
        return null
    }
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

// 録画（区間）を1本のファイルにしてダウンロードする
const downloadSegment = async (segmentId: string) => {
    try {
        const { blob, segment } = await getSegmentFile(segmentId)

        // ダウンロードファイル名を生成（日時は録画を始めた時刻）
        const formattedDate = formatDateForFileName(segment.startedAt)
        const filename = `${segment.userName}_${segment.title}_${formattedDate}.${getVideoExtension(segment.mimeType)}`

        downloadBlob(blob, filename)
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
    captureThumbnail,
    getVideoExtension,
    downloadSegment,
    downloadBlob,
    getScreenShotAndDownload,
    formatDateForFileName,
    formatDate
}