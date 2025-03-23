// import { saveChunk, cleanUp } from "../../hooks/indexdb"
import './style.css'

const BUFFER_FLUSH_INTERVAL_MS = 10 * 60 * 1000 // 10 * 60 * 1000
const CHUNK_UPLOAD_INTERVAL_MS = 1 * 60 * 1000 // 1 * 60 * 1000
const MAX_STORAGE_SIZE = 1 * 1024 * 1024 * 1024 // GB

let video: HTMLVideoElement = {} as HTMLVideoElement
let stream: MediaStream = {} as MediaStream
let mediaRecorder: MediaRecorder = {} as MediaRecorder
// let port = {} as chrome.runtime.Port

export default defineContentScript({
  matches: ["*://live.nicovideo.jp/watch/*"],
  main(ctx) {
    // 統合されたコンテンツUIを作成してマウントする
    const ui = createIntegratedUi(ctx, {
      position: 'inline',
      onMount: handleUiMount,
    })
    ui.mount()
  }
})

async function handleUiMount() {

  // indexedDBをすべてクリア
  // await cleanUp()

  insertRecordedMovieAria()

  // 録画を開始
  startRec()
}

const insertRecordedMovieAria = async () => {
  const controlArea = document.querySelector('[class*="_player-controller_"]')
  if (!controlArea) return
  const recordedMovieAria = document.createElement("div")
  const recordedMovieBox = document.createElement("div")
  recordedMovieAria.setAttribute("id", "recordedMovieAria")
  recordedMovieBox.setAttribute("class", "recordedMovieBox")
  recordedMovieAria.appendChild(recordedMovieBox)
  controlArea.after(recordedMovieAria)

  const chunks = await getAllChunks()
  for (const chunk of chunks) {
    insertRecordedMovie(chunk)
  }
}

const insertRecordedMovie = (chunk: { timestamp: number, chunk: Blob, imgUrl: string }) => {

  const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
  if (!recordedMovieBox) return

  // 新しい要素を作成してスクリーンショットを挿入
  const newElement = document.createElement("div")
  newElement.setAttribute("id", chunk.timestamp.toString())
  newElement.classList.add("recordedMovie")
  newElement.innerHTML = `<img src="${chunk.imgUrl}" alt="Video Screenshot">`

  // recordedMovieBoxの中に挿入
  recordedMovieBox.appendChild(newElement)
  recordedMovieBox.scrollLeft = recordedMovieBox.scrollWidth
}

const startRec = () => {

  video = document.querySelector("video") as HTMLVideoElement
  if (!video) return
  
  // 動画ストリームを取得
  stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()

  if (video.readyState >= 3) {
    console.log("動画が準備完了、録画を開始します")
    startMediaRecorder()
  } else {
    console.log("動画の準備が完了していないため、待機します...")
    video.addEventListener("canplay", () => {
      console.log("動画が再生可能になりました。録画を開始します")
      startMediaRecorder()
    }, { once: true })
  }
}

// indexedDBをすべてクリア
// const cleanUp = async () => {
//   await chrome.runtime.sendMessage({
//     action: "cleanUp"
//   })
//   console.log("Cleanup completed!!!!!!")
// }

const startMediaRecorder = async () => {

  try {
    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm; codecs=vp9" })

    mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      // 録画データを保存
      await saveChunkToIndexedDB(event)
    }

    // 録画を開始
    mediaRecorder.start()
    console.log("録画を開始しました")

    // ◯分ごとに MediaRecorder を再作成
    setInterval(async () => {
      await restartRecording()
    }, BUFFER_FLUSH_INTERVAL_MS)

    // ◯分ごとに最新の録画データを確保
    setInterval(() => {
      if (mediaRecorder.state === "recording") {
        mediaRecorder.requestData() // 🎯 最新の録画データを確保
      }
    }, CHUNK_UPLOAD_INTERVAL_MS)

    // ミュート対策
    fixAudioTrack()

  } catch (error) {
    console.error("録画の開始に失敗しました:", error)
  }
}

const getScreenShot = async () => {

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

  return imgUrl
}

const restartRecording = async () => {
  // 新しい MediaStream を作成（元のストリームをクローン）
  let newStream = stream.clone()
  let newRecorder = new MediaRecorder(newStream, { mimeType: "video/webm; codecs=vp9" })

  // 新しい MediaRecorder のデータ処理をセット
  newRecorder.ondataavailable = async (event: BlobEvent) => {
    // 録画データを保存
    await saveChunkToIndexedDB(event)
  }

  // 新しい MediaRecorder を開始
  newRecorder.start()

  // 古い MediaRecorder を安全に停止
  if (mediaRecorder.state !== "inactive") {
    await new Promise((resolve) => {
      mediaRecorder.onstop = resolve
      mediaRecorder.stop()
    })
  }

  // 新しい MediaRecorder に切り替え
  mediaRecorder = newRecorder

  // 古いストリームを解放（ただし、新しいストリームに影響しないか確認）
  stream.getTracks().forEach(track => track.stop())
  stream = newStream // クローンしたストリームを現在のストリームとしてセット
}

// 録画データを保存
const saveChunkToIndexedDB = async (event: BlobEvent) => {
  
  console.log("ondataavailable", event.data.size)

  if (event.data.size <= 0) return

  const deletedKeys = await cleanUpOldData(MAX_STORAGE_SIZE)
  
  for (const key of deletedKeys) {
    // keyと同じIDを持つ要素を取得してDOMから削除する
    const element = document.getElementById(key.toString())
    if (element) element.remove()
  }

  const imgUrl = await getScreenShot()
  const key = await saveChunk(event.data, imgUrl)

  const chunk = await getChunkByKey(key)
  if (!chunk) return
  insertRecordedMovie(chunk)
}

// ミュート対策
const fixAudioTrack = () => {

  let previousVolume = '0'
  let isMuted = 'false'

  const controlMute = () => {
    isMuted = localStorage.getItem('LeoPlayer_MuteSettingsStore_isMute') || 'false'
    previousVolume = localStorage.getItem('LeoPlayer_VolumeSettingsStore_volume') || '0'

    if (isMuted === 'true' || previousVolume === '0') {
      console.log("🔴 ミュート検出", video.volume)

      video.muted = false
      video.volume = 0.0000001
    } else {
      console.log("🔊 ミュート解除検出")
      video.volume = Number(previousVolume) / 100
    }
  }

  controlMute()

  // ミュートボタン押下時
  const muteButtons = document.querySelectorAll('[class*="_mute-button_"]')
  muteButtons.forEach(button => button.addEventListener("click", () => {
    console.log("ミュートボタンがクリックされました")
    controlMute()
  }))

  // 音量変化時
  video.addEventListener("volumechange", async () => {
    controlMute()
  })
}

