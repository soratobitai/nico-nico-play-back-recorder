import { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks, deleteDB } from "../../hooks/indexedDB/recordingDB"
import './style.css'

const CHUNK_RESTART_INTERVAL_MS = 1 * 60 * 1000 // 1 * 60 * 1000
const MAX_STORAGE_SIZE = 1 * 1024 * 1024 * 1024 // GB

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

  const sessionId = crypto.randomUUID()  // タブごとの識別子

  let video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
  let stream: MediaStream = {} as MediaStream
  let mediaRecorder: MediaRecorder = {} as MediaRecorder

  let startButton = null as HTMLButtonElement | null
  let stopButton = null as HTMLButtonElement | null
  let recordStatus = null as HTMLDivElement | null
  // let isRecordOn = true
  let chunkIndex = 0

  const defaultScreenshot = chrome.runtime.getURL("assets/images/defaultScreenshot.webp")

  const startRec = () => {
    if (!video) return
    if (mediaRecorder && mediaRecorder.state === "recording") return

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
      await mergeStaleChunks() // 前回のtempファイルを取得・削除し結合して保存
      startNewRecorder() // 最初の録画を開始
      // fixAudioTrack() // ミュート対策
    } catch (error) {
      console.log("録画の開始に失敗しました:", error)
    }
  }

  const startNewRecorder = () => {

    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm; codecs=vp9" })

    // チャンクデータを保存
    mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      console.log("ondataavailable", event.data.size)
      if (event.data.size <= 0) return
      await saveChunk('Temps', sessionId, chunkIndex++, event.data, null, Date.now())
    }

    mediaRecorder.onstop = async () => {
      setRecordingStatus(false)

      setTimeout(async () => {
        // チャンクを結合して保存
        await mergeWebMChunksBySession()
      }, 500) // 0.5秒待ってから実行
    }

    // 録画を開始
    mediaRecorder.start(1000)
    setRecordingStatus(true)
  }

  const resetRecording = () => {

    if (mediaRecorder && mediaRecorder.state === "recording") {
      console.log("🔄 録画を切り替えます...")

      // recorder を停止
      mediaRecorder.stop()

      // `onstop` の実行が完全に終わるのを待つ
      mediaRecorder.onstop = async () => {
        console.log("🛑 録画を停止しました。")

        // チャンクを結合して保存
        await mergeWebMChunksBySession()

        // ✅ 新しい recorder を開始
        startNewRecorder()
      }

      // ✅ 容量超過分のチャンクを削除（マージとズラす）
      setTimeout(() => deleteExcessChunks(), CHUNK_RESTART_INTERVAL_MS / 2)
    }
  }

  const setRecordingStatus = (isRecording: boolean) => {
    if (isRecording) {
      if (startButton) startButton.disabled = true
      if (stopButton) stopButton.disabled = false
      if (recordStatus) recordStatus.textContent = "録画中"
      if (recordStatus) recordStatus.classList.add("recording")
      console.log("録画を開始しました")
    } else {
      if (stopButton) stopButton.disabled = true
      if (startButton) startButton.disabled = false
      if (recordStatus) recordStatus.textContent = "停止中"
      if (recordStatus) recordStatus.classList.remove("recording")
      console.log("録画を停止しました")
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

  const mergeWebMChunksBySession = async () => {
    try {
      // 特定の sessionId のデータのみ取得
      const temps = (await getAllChunks('Temps')).filter(temp => temp.sessionId === sessionId)
      if (temps.length === 0) return

      // 削除するキーを準備
      const keys = temps.map(temp => [temp.sessionId, temp.chunkIndex])
      await deleteChunkByKeys('Temps', keys)

      // チャンクを結合
      const webmBlob = new Blob(temps.map(temp => temp.blob), { type: "video/webm" })
      const screenShot_ = await extractFirstFrame(webmBlob) as string

      // `Chunks` に保存
      const key = await saveChunk('Chunks', sessionId, Date.now(), webmBlob, screenShot_, Date.now())
      console.log(`sessionId: ${sessionId} のチャンクを結合して保存しました`)

      // UIに挿入
      insertRecordedMovie(key, screenShot_, 'end')
    } catch (error) {
      console.log(`sessionId: ${sessionId} の録画データの結合に失敗しました:`, error)
    }
  }

  const mergeStaleChunks = async () => {
    try {
      const now = Date.now()
      const threshold = now - (3 * 1000) // ◯ 秒前

      // すべてのデータを取得して sessionId ごとにグループ化
      const temps = await getAllChunks('Temps')
      const groupedChunks: Record<string, { blobs: Blob[], keys: IDBValidKey[][], latestCreatedAt: number }> = {}

      for (const temp of temps) {
        if (!groupedChunks[temp.sessionId]) {
          groupedChunks[temp.sessionId] = { blobs: [], keys: [], latestCreatedAt: 0 }
        }
        groupedChunks[temp.sessionId].blobs.push(temp.blob)
        groupedChunks[temp.sessionId].keys.push([temp.sessionId, temp.chunkIndex])
        groupedChunks[temp.sessionId].latestCreatedAt = Math.max(groupedChunks[temp.sessionId].latestCreatedAt, temp.createdAt)
      }

      // `createdAt` が ◯ 秒以上前のグループのみ処理
      for (const sessionId in groupedChunks) {
        if (groupedChunks[sessionId].latestCreatedAt < threshold) {
          const { blobs, keys } = groupedChunks[sessionId]

          // 削除
          await deleteChunkByKeys('Temps', keys)

          // チャンクを結合
          const webmBlob = new Blob(blobs, { type: "video/webm" })
          const screenShot_ = await extractFirstFrame(webmBlob) as string

          // チャンクの最終のcreatedAtを取得
          const latestCreatedAt = Math.max(...temps.filter(temp => temp.sessionId === sessionId).map(temp => temp.createdAt))

          // `Chunks` に保存
          const key = await saveChunk('Chunks', sessionId, latestCreatedAt, webmBlob, screenShot_, latestCreatedAt)
          console.log(`不良チャンク: ${sessionId} のチャンクを結合して保存しました`)
        }
      }
    } catch (error) {
      console.log("不良チャンクの結合に失敗しました:", error)
    }
  }

  const reloadRecordedMovieList = async () => {
    
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return
    recordedMovieBox.innerHTML = ""

    const chunks = await getAllChunks('Chunks')
    for (const chunk of chunks.reverse()) {
      insertRecordedMovie([chunk.sessionId, chunk.chunkIndex], chunk.imgUrl)
      await new Promise(resolve => setTimeout(resolve, 10)) // ライブ画面のフリーズを回避するためにインターバルを入れる
    }
  }

  // 容量超過分を削除
  const deleteExcessChunks = async () => {
    // indexedDBから削除
    const deletedKeys = await cleanUpOldChunks('Chunks', MAX_STORAGE_SIZE)
    console.log(`容量超過分のチャンクを削除しました: ${deletedKeys.length}件`, deletedKeys)

    // UIから削除
    for (const key of deletedKeys) {
      const [sessionId, chunkIndex] = key as [string, string]
      const elements = document.querySelectorAll('.recordedMovie')
      elements.forEach(element => {
        if (element.getAttribute('sessionId') == sessionId && element.getAttribute('chunkIndex') == chunkIndex) {
          element.remove()
        }
      })
    }
  }

  const insertRecordedMovie = (key: IDBValidKey, imgUrl: string | null, insertPosition: string = 'start') => {

    const [sessionId_, chunkIndex_] = key as [string, string]

    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    // 新しい要素を作成してスクリーンショットを挿入
    const recordedMovie = document.createElement("div")
    recordedMovie.classList.add("recordedMovie")
    recordedMovie.setAttribute('sessionId', sessionId_)
    recordedMovie.setAttribute('chunkIndex', chunkIndex_)
    recordedMovie.innerHTML = `<img src="${imgUrl}" />`

    // クリックイベントを追加
    recordedMovie.addEventListener('click', (event) => {
      const parent = (event.target as HTMLElement).parentElement
      if (!parent) return

      const sessionId = parent.getAttribute('sessionId')
      const chunkIndexStr = parent.getAttribute('chunkIndex')

      if (!sessionId || chunkIndexStr === null) return

      const chunkIndex = Number(chunkIndexStr)
      if (isNaN(chunkIndex)) return

      const key: [string, number] = [sessionId, chunkIndex]

      openModalWithVideo(key, event)
    })

    // recordedMovieBoxの中に挿入
    if (insertPosition === "start") {
      recordedMovieBox.prepend(recordedMovie)
    } else {
      recordedMovieBox.appendChild(recordedMovie)
    }
    recordedMovieBox.scrollLeft = recordedMovieBox.scrollWidth
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
              <button type="button" id="stopButton" disabled>STOP</button>
            </div>
            <div id="recordStatus">準備中</div>
          </div>
        </div>
      </div>
    `
    controlArea.insertAdjacentHTML("afterend", recordedMovieHTML)

    startButton = document.getElementById("startButton") as HTMLButtonElement
    stopButton = document.getElementById("stopButton") as HTMLButtonElement
    recordStatus = document.getElementById("recordStatus") as HTMLDivElement

    startButton.addEventListener("click", async () => {
      if (mediaRecorder && mediaRecorder.state === "inactive") {
        mediaRecorder.start(1000)
      }
    })

    stopButton.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop()
      }
    })
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
  async function openModalWithVideo(key: IDBValidKey, event: MouseEvent) {
    try {
      const chunk = await getChunkByKey('Chunks', key)
      if (!chunk) throw new Error('動画データが見つかりません')

      const url = URL.createObjectURL(chunk.blob)

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
      let posY = clientY - modalHeight - 50

      // はみ出さないように調整
      if (posX + modalWidth > viewportWidth) posX = viewportWidth - modalWidth - 10
      if (posY + modalHeight > viewportHeight) posY = viewportHeight - modalHeight - 10

      modalContent.style.position = 'absolute'
      modalContent.style.left = `${posX}px`
      modalContent.style.top = `${posY}px`
    } catch (error) {
      console.log('動画のロードに失敗しました:', error)
    }
  }

  // 動画の最初のフレームを取得する関数
  const extractFirstFrame = async (blob: Blob) => {
    if (!blob.type.startsWith('video/')) {
      console.log(`Invalid blob type: ${blob.type}, returning default image`)
      return defaultScreenshot
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
              resolve(defaultScreenshot) // エラー時はデフォルト画像を返す
            }
          } catch (err) {
            console.log('Error capturing first frame:', err)
            resolve(defaultScreenshot) // エラー時はデフォルト画像を返す
          } finally {
            cleanUp()
          }
        }, 500)
      }

      video.onerror = (e) => {
        console.log('Video load error:', e)
        cleanUp()
        resolve(defaultScreenshot) // エラー時はデフォルト画像を返す
      }
    })
  }

  // const getScreenShot = async () => {

  //   // canvas要素を作成
  //   const canvas = document.createElement("canvas")
  //   const ctx = canvas.getContext("2d")

  //   // canvasのサイズをvideoのサイズに設定
  //   canvas.width = video.videoWidth
  //   canvas.height = video.videoHeight

  //   // videoの現在のフレームをcanvasに描画
  //   ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)

  //   // 画像データを取得
  //   const imgUrl = canvas.toDataURL("image/png")

  //   return imgUrl
  // }

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
      controlMute()
    }))

    // 音量変化時
    video.addEventListener("volumechange", async () => {
      controlMute()
    })
  }

  /////////////////////////////////////////////////////////////////////
  
  // indexedDBをすべてクリア
  // deleteDB('RecordingDB').then(() => {
  //   console.log('Database deleted successfully.')
  // }).catch(error => {
  //   console.log('Error deleting database:', error)
  // })
  // await cleanUpAllChunks('Chunks')
  // await cleanUpAllChunks('Temps')

  // UIを作成
  insertRecordedMovieAria()
  createModal()

  // 録画リストを更新
  await reloadRecordedMovieList()

  // 録画を開始
  startRec()

  // ミュート対策
  fixAudioTrack()

  // 指定間隔で録画をリセット
  setInterval(() => {
    resetRecording()
  }, CHUNK_RESTART_INTERVAL_MS)

  // video の track 変更を監視
  video.addEventListener("resize", () => {
    console.log("video の track 変更を検知しました！")

    // 古い recorder を停止
    if (mediaRecorder && mediaRecorder instanceof MediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop()
    }

    // 古い stream を解放
    if (stream) {
      stream.getTracks().forEach(track => track.stop())
    }

    // 新しい録画を開始
    setTimeout(() => {
      startRec()
    }, 3000)
  })
}

