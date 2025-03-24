import { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks } from "../../hooks/indexedDB/recordingDB"
import './style.css'

const CHUNK_RESTART_INTERVAL_MS = 1 * 60 * 1000 // 1 * 60 * 1000
const MAX_STORAGE_SIZE = 10 * 1024 * 1024 * 1024 // GB

let video: HTMLVideoElement = {} as HTMLVideoElement
let stream: MediaStream = {} as MediaStream
let mediaRecorder: MediaRecorder = {} as MediaRecorder

let startButton = null as HTMLButtonElement | null
let stopButton = null as HTMLButtonElement | null
let recordStatus = null as HTMLDivElement | null

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
  // await cleanUpAllChunks('Chunks')
  // await cleanUpAllChunks('Temps')

  // UIを作成
  insertRecordedMovieAria()
  createModal()

  // 録画を開始
  startRec()
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

const startMediaRecorder = async () => {

  try {
    const startNewRecorder = () => {

      mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm; codecs=vp9" })

      mediaRecorder.ondataavailable = async (event: BlobEvent) => {
        // 録画データを保存
        await saveTempToIndexedDB(event.data)
      }

      mediaRecorder.onstop = async () => {
        console.log("🎥 録画停止、チャンクを結合して WebM を作成")
        const { timestamp, screenShot_ } = await mergeWebMChunks() as { timestamp: number, screenShot_: string }
        // リストに追加
        insertRecordedMovie(timestamp, screenShot_, 'end')
      }

      // 録画を開始
      mediaRecorder.start(1000)
      console.log("録画を開始しました")
      if (startButton) startButton.disabled = true
      if (stopButton) stopButton.disabled = false
      if (recordStatus) recordStatus.textContent = "録画中"
      if (recordStatus) recordStatus.classList.add("recording")
    }

    // 前回のtempファイルを取得・削除し結合して保存
    await mergeWebMChunks()

    // 最初の録画を開始
    startNewRecorder()

    // ミュート対策
    fixAudioTrack()

    // 録画リストを更新
    reloadRecordedMovieList()

    // ◯分ごとに新しい録画を開始
    setInterval(() => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        const oldRecorder = mediaRecorder
        startNewRecorder()

        // 50ms 後に古い録画を停止
        setTimeout(() => {
          oldRecorder.stop()
          // oldRecorder.ondataavailable = null
          // oldRecorder.onstop = null
        }, 50)

        // 容量超過分のチャンクを削除（マージのタイミングとズラす）
        setTimeout(() => deleteExcessChunks(), CHUNK_RESTART_INTERVAL_MS / 2)
      }
    }, CHUNK_RESTART_INTERVAL_MS)

  } catch (error) {
    console.error("録画の開始に失敗しました:", error)
  }
}

const downloadBlob = (blob: Blob, fileName: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const mergeWebMChunks = async () => {
  const chunks_: Blob[] = []
  const keys: number[] = []

  try {
    // tempファイルを取得し削除
    const temps = await getAllChunks('Temps')
    if (temps.length === 0) return
    for (const temp of temps) {
      chunks_.push(temp.chunk)
      keys.push(temp.timestamp)
    }
    await deleteChunkByKeys('Temps', keys)

    // 結合して保存
    const webmBlob = new Blob(chunks_, { type: "video/webm" })
    const screenShot_ = await extractFirstFrame(webmBlob) as string
    const key = await saveChunk('Chunks', webmBlob, screenShot_) as number
    const timestamp = key
    
    return { timestamp, screenShot_ }
  } catch (error) {
    console.error("録画データの結合に失敗しました:", error)
  }
}

const reloadRecordedMovieList = async () => {
  const chunks = await getAllChunks('Chunks')
  const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
  if (!recordedMovieBox) return

  recordedMovieBox.innerHTML = ""

  for (const chunk of chunks.reverse()) {
    insertRecordedMovie(chunk.timestamp, chunk.imgUrl)
    await new Promise(resolve => setTimeout(resolve, 1)) // ライブ画面のフリーズを回避するためにインターバルを入れる
  }
}

// 容量超過分を削除
const deleteExcessChunks = async () => {
  const deletedKeys = await cleanUpOldChunks('Chunks', MAX_STORAGE_SIZE)
  for (const key of deletedKeys) {
    // keyと同じIDを持つ要素を取得してDOMから削除する
    const element = document.getElementById(key.toString())
    if (element) element.remove()
  }
}

// 録画一時データを保存
const saveTempToIndexedDB = async (data: Blob) => {

  console.log("ondataavailable", data.size)

  if (data.size <= 0) return

  await saveChunk('Temps', data, null)
}

// 録画データを保存
const saveChunkToIndexedDB = async (event: BlobEvent) => {
  
  console.log("ondataavailable", event.data.size)

  if (event.data.size <= 0) return

  const deletedKeys = await cleanUpOldChunks('Chunks', MAX_STORAGE_SIZE)
  
  for (const key of deletedKeys) {
    // keyと同じIDを持つ要素を取得してDOMから削除する
    const element = document.getElementById(key.toString())
    if (element) element.remove()
  }

  const imgUrl = await getScreenShot()
  const key = await saveChunk('Chunks', event.data, imgUrl)

  const chunk = await getChunkByKey('Chunks', key)
  if (!chunk) return
  insertRecordedMovie(chunk.timestamp, chunk.imgUrl)
}

const insertRecordedMovie = (key: number, imgUrl: string | null, insertPosition: string = 'start') => {

  const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
  if (!recordedMovieBox) return

  // 新しい要素を作成してスクリーンショットを挿入
  const newElement = document.createElement("div")
  newElement.classList.add("recordedMovie")
  newElement.innerHTML = `<img src="${imgUrl}" chunk-key="${key}">`

  // recordedMovieBoxの中に挿入
  if (insertPosition === "start") {
    recordedMovieBox.prepend(newElement)
  } else {
    recordedMovieBox.appendChild(newElement)
  }
  recordedMovieBox.scrollLeft = recordedMovieBox.scrollWidth

  // クリックイベントを追加
  newElement.addEventListener('click', (event) => {
    const key: number = Number((event.target as HTMLElement).getAttribute('chunk-key'))
    if (!key) return
    openModalWithVideo(key, event)
  })
}


const extractFirstFrame = async (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    if (!blob.type.startsWith('video/')) {
      reject(new Error(`Invalid blob type: ${blob.type}`))
      return
    }

    const video = document.createElement('video')
    const objectURL = URL.createObjectURL(blob)

    video.src = objectURL
    video.muted = true
    video.autoplay = false
    video.playsInline = true

    // CORS制限がある場合に必要
    video.crossOrigin = "anonymous"

    const cleanUp = () => {
      URL.revokeObjectURL(objectURL)
      video.remove()
    }

    video.onloadeddata = () => {
      video.currentTime = 0 // 最初のフレームへ移動
    }

    video.oncanplay = () => {
      // 再生してすぐ止めることで、確実にフレームを取得
      video.play().then(() => {
        setTimeout(() => {
          video.pause()

          const canvas = document.createElement('canvas')
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
          const ctx = canvas.getContext('2d')

          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            resolve(canvas.toDataURL('image/png'))
          } else {
            reject(new Error('Canvas context is not available'))
          }

          cleanUp()
        }, 100) // 100ms 待つことでフレーム描画を確実にする
      }).catch(reject)
    }

    video.onerror = (e) => {
      cleanUp()
      reject(new Error(`Video load error: ${JSON.stringify(e)}`))
    }
  })
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

const insertRecordedMovieAria = async () => {
  const controlArea = document.querySelector('[class*="_player-controller_"]')
  if (!controlArea) return

  const recordedMovieHTML = `
  <div id="recordedMovieAria">
    <div class="recordedMovieWrapper">
      <div class="recordedMovieBox"></div>
      <div class="control-panel">
        <div class="control-buttons">
          <button type="button" id="startButton" disabled>●Rec</button>
          <button type="button" id="stopButton">STOP</button>
        </div>
        <div id="recordStatus"></div>
      </div>
    </div>
  </div>
`
  controlArea.insertAdjacentHTML("beforeend", recordedMovieHTML)

  startButton = document.getElementById("startButton") as HTMLButtonElement
  stopButton = document.getElementById("stopButton") as HTMLButtonElement
  recordStatus = document.getElementById("recordStatus") as HTMLDivElement

  startButton.addEventListener("click", async () => {
    if (mediaRecorder && mediaRecorder.state === "inactive") {
      mediaRecorder.start(1000)
      if (startButton) startButton.disabled = true
      if (stopButton) stopButton.disabled = false
      if (recordStatus) recordStatus.textContent = "録画中"
      if (recordStatus) recordStatus.classList.add("recording")
    }
  })

  stopButton.addEventListener("click", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop()
      if (stopButton) stopButton.disabled = true
      if (startButton) startButton.disabled = false
      if (recordStatus) recordStatus.textContent = "停止中"
      if (recordStatus) recordStatus.classList.remove("recording")
    }
  })

  setInterval(() => {
    console.log("startButton.disabled:", startButton?.disabled)
  }, 1000)
}

// モーダルを作成する関数
function createModal() {
  if (document.getElementById('video-modal')) return // すでに作成済みならスキップ

  const root = document.getElementById('root')

  const modal = document.createElement('div')
  modal.id = 'video-modal'
  modal.innerHTML = `
        <div class="modal-content">
            <span id="close-modal" class="close">&times;</span>
            <video id="video-player" controls autoplay></video>
        </div>
    `
  modal.style.width = `${root?.offsetWidth}px`
  modal.style.height = `${root?.offsetHeight}px`
  document.body.appendChild(modal)

    // 閉じるボタンの処理
  const closeButton = document.getElementById('close-modal')
  closeButton?.addEventListener('click', () => {
    modal.style.display = 'none'
    const video = document.getElementById('video-player') as HTMLVideoElement
    video.pause()
    video.src = '' // メモリ解放
  })

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeButton?.click()
    }
  })
}

// 動画を取得してモーダルを開く
async function openModalWithVideo(key: number, event: MouseEvent) {
  try {
    const chunk = await getChunkByKey('Chunks', key)
    if (!chunk) throw new Error('動画データが見つかりません')

    const url = URL.createObjectURL(chunk.chunk)

    const video = document.getElementById('video-player') as HTMLVideoElement
    video.src = url

    const modal = document.getElementById('video-modal') as HTMLElement
    const modalContent = modal.querySelector('.modal-content') as HTMLElement
    modal.style.display = 'block'
    modalContent.style.width = '300px'
    modalContent.style.height = '250px'

    // クリック位置を考慮してモーダルの位置を設定
    const { clientX, clientY } = event
    const modalWidth = modalContent.offsetWidth
    const modalHeight = modalContent.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let posX = clientX - (modalWidth / 2)
    let posY = clientY - modalHeight

    // はみ出さないように調整
    if (posX + modalWidth > viewportWidth) posX = viewportWidth - modalWidth - 10
    if (posY + modalHeight > viewportHeight) posY = viewportHeight - modalHeight - 10

    modalContent.style.position = 'absolute'
    modalContent.style.left = `${posX}px`
    modalContent.style.top = `${posY}px`
  } catch (error) {
    console.error('動画のロードに失敗しました:', error)
  }
}






// const restartRecording = async () => {
//   // 新しい MediaStream を作成（元のストリームをクローン）
//   let newStream = stream.clone()
//   let newRecorder = new MediaRecorder(newStream, { mimeType: "video/webm; codecs=vp9" })

//   // 新しい MediaRecorder のデータ処理をセット
//   newRecorder.ondataavailable = async (event: BlobEvent) => {
//     // 録画データを保存
//     await saveTempToIndexedDB(event.data)
//   }

//   // 新しい MediaRecorder を開始
//   newRecorder.start(1000)

//   // 古い MediaRecorder を安全に停止
//   if (mediaRecorder.state !== "inactive") {
//     await new Promise((resolve) => {
//       mediaRecorder.onstop = resolve
//       mediaRecorder.stop()
//     })
//   }

//   // 新しい MediaRecorder に切り替え
//   mediaRecorder = newRecorder

//   // 古いストリームを解放（ただし、新しいストリームに影響しないか確認）
//   stream.getTracks().forEach(track => track.stop())
//   stream = newStream // クローンしたストリームを現在のストリームとしてセット
// }