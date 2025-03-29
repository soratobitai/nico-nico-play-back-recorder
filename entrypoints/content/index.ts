import { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks, deleteDB } from "../../hooks/indexedDB/recordingDB"
import './style.css'

// 初期値（fallback）
const SAVE_CHUNK_INTERVAL_MS = 3 * 1000 // 1 * 1000
let RESTART_MEDIARECORDER_INTERVAL_MS = 1 * 60 * 1000
let MAX_STORAGE_SIZE = 1 * 1024 * 1024 * 1024

// 設定を取得して初期値を更新
chrome.storage.sync.get(['RESTART_MEDIARECORDER_INTERVAL_MS', 'MAX_STORAGE_SIZE'], (result) => {
  if (typeof result.RESTART_MEDIARECORDER_INTERVAL_MS === 'number') {
    RESTART_MEDIARECORDER_INTERVAL_MS = result.RESTART_MEDIARECORDER_INTERVAL_MS
  }
  if (typeof result.MAX_STORAGE_SIZE === 'number') {
    MAX_STORAGE_SIZE = result.MAX_STORAGE_SIZE
  }
})

// 設定がリアルタイムに変更されたときに反映
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    if (changes.RESTART_MEDIARECORDER_INTERVAL_MS) {
      RESTART_MEDIARECORDER_INTERVAL_MS = changes.RESTART_MEDIARECORDER_INTERVAL_MS.newValue
    }
    if (changes.MAX_STORAGE_SIZE) {
      MAX_STORAGE_SIZE = changes.MAX_STORAGE_SIZE.newValue
    }
  }
})

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

  let capButton = null as HTMLButtonElement | null
  let startButton = null as HTMLButtonElement | null
  let stopButton = null as HTMLButtonElement | null
  let recordStatus = null as HTMLDivElement | null
  // let isRecordOn = true
  let chunkIndex = 0

  let startTime: number | null = null
  let recordTimer: ReturnType<typeof setInterval> | null = null

  let recordingTimeout: any // ondataavailable の発火を監視する関数

  const startRec = () => {
    if (!video) return
    if (mediaRecorder && mediaRecorder.state === "recording") return

    try {
      // 動画ストリームを取得
      stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()

      if (video.readyState >= 3) {
        console.log("動画が準備完了、録画を開始します")
        startNewRecorder()
      } else {
        console.log("動画の準備が完了していないため、待機します...")
        video.addEventListener("canplay", () => {
          console.log("動画が再生可能になりました。録画を開始します")
          startNewRecorder()
        }, { once: true })
      }
    } catch (error) {
      console.log("録画の開始に失敗しました:", error)
    }
  }

  const startNewRecorder = () => {

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"' })

    // チャンクデータを保存
    mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      console.log("ondataavailable", event.data.size)
      if (event.data.size <= 0) return

      // ダウンロード用ファイル名を生成
      const now = Date.now()
      const downloadFileName = `${userName}_${title}_${new Date(now).toLocaleString()}.mp4`

      await saveChunk('Temps', sessionId, chunkIndex++, event.data, null, Date.now(), downloadFileName)

      resetTimeoutCheck()
    }

    mediaRecorder.onstop = async () => {
      setRecordingStatus(true, false, '停止中')

      setTimeout(async () => {
        // チャンクを結合して保存
        await mergeChunksBySession()
      }, 500) // 0.5秒待ってから実行

      if (recordTimer) {
        clearInterval(recordTimer)
        recordTimer = null
      }
      startTime = null

      const recordTimeElem = document.getElementById('recordTime')
      if (recordTimeElem) recordTimeElem.textContent = '00:00:00'

    }

    // 録画を開始
    mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
    resetTimeoutCheck()
    setRecordingStatus(false, true, "🔴録画中")

    console.log("タイマーを開始しました")
    startTime = Date.now()
    recordTimer = setInterval(() => {
      if (startTime) {
        const now = Date.now()
        const elapsed = now - startTime
        const minutes = Math.floor(elapsed / 60000)
        const seconds = Math.floor((elapsed % 60000) / 1000)
        const hours = Math.floor(minutes / 60)
        const mm = (minutes % 60).toString().padStart(2, '0')
        const ss = seconds.toString().padStart(2, '0')
        const hh = hours.toString().padStart(2, '0')
        const timeString = `${hh}:${mm}:${ss}`
        const recordTimeElem = document.getElementById('recordTime')
        if (recordTimeElem) recordTimeElem.textContent = `${timeString}`
      }
    }, 1000)
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
        await mergeChunksBySession()

        if (recordTimer) {
          clearInterval(recordTimer)
          recordTimer = null
        }
        startTime = null
        const recordTimeElem = document.getElementById('recordTime')
        if (recordTimeElem) recordTimeElem.textContent = '00:00:00'

        // ✅ 新しい recorder を開始
        startNewRecorder()
      }

      // ✅ 容量超過分のチャンクを削除（マージとズラす）
      setTimeout(async () => {
        // indexedDBから削除
        const deletedKeys = await cleanUpOldChunks('Chunks', MAX_STORAGE_SIZE)
        if (deletedKeys.length === 0) return
        console.log(`容量超過分のチャンクを削除しました: ${deletedKeys.length}件`, deletedKeys)

        // UIから削除
        deleteMovieIcon(deletedKeys)

      }, RESTART_MEDIARECORDER_INTERVAL_MS / 2)
    }

    // UIから動画サムネを削除
    const deleteMovieIcon = (deletedKeys: IDBValidKey[]) => {
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
  }

  // コントロールパネルのボタンの状態を設定
  const setRecordingStatus = (isStartBtn: boolean, isStopBtn: boolean, message: string) => {
    if (startButton) startButton.disabled = !isStartBtn
    if (stopButton) stopButton.disabled = !isStopBtn
    if (isStartBtn) {
      if (recordStatus) recordStatus.classList.remove("textRed")
    } else {
      if (recordStatus) recordStatus.classList.add("textRed")
    }
    if (recordStatus) recordStatus.textContent = message
  }

  const mergeChunksBySession = async () => {
    try {
      // 特定の sessionId のデータのみ取得
      const temps = (await getAllChunks('Temps')).filter(temp => temp.sessionId === sessionId)
      if (temps.length === 0) return

      // チャンクを削除
      const keys = temps.map(temp => [temp.sessionId, temp.chunkIndex])
      await deleteChunkByKeys('Temps', keys)

      // チャンク数のチェック
      if (temps.length <= 2) {
        throw new Error("チャンク数が少ないので保存をスキップします")
      }
      console.log(`sessionId: ${sessionId} のチャンク数: ${temps.length}`)

      // チャンクを結合
      const blob = new Blob(temps.map(temp => temp.blob), { type: "video/mp4" })
      const screenShot_ = await extractFirstFrame(blob) as string
      if (!screenShot_) {
        throw new Error("スクリーンショットの取得に失敗しました（チャンクが正しくない）")
      }

      // チャンクの最初のdownloadFileNameを取得
      const downloadFileName = temps[0].downloadFileName || ''

      // `Chunks` に保存
      const key = await saveChunk('Chunks', sessionId, Date.now(), blob, screenShot_, Date.now(), downloadFileName)
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
      const threshold = now - (SAVE_CHUNK_INTERVAL_MS + 1000) // ◯ 秒より前に限定する

      // すべてのデータを取得して sessionId ごとにグループ化
      const temps = await getAllChunks('Temps')
      const groupedChunks: Record<string, { blobs: Blob[], keys: IDBValidKey[][], latestCreatedAt: number, downloadFileName: string | null }> = {}

      for (const temp of temps) {
        if (!groupedChunks[temp.sessionId]) {
          groupedChunks[temp.sessionId] = { blobs: [], keys: [], latestCreatedAt: 0, downloadFileName: null }
        }
        groupedChunks[temp.sessionId].blobs.push(temp.blob)
        groupedChunks[temp.sessionId].keys.push([temp.sessionId, temp.chunkIndex])
        groupedChunks[temp.sessionId].latestCreatedAt = Math.max(groupedChunks[temp.sessionId].latestCreatedAt, temp.createdAt)
        groupedChunks[temp.sessionId].downloadFileName = temp.downloadFileName
      }

      for (const sessionId in groupedChunks) {
        // `createdAt` が ◯ 秒以上前のグループのみ処理
        if (groupedChunks[sessionId].latestCreatedAt < threshold) {
          const { blobs, keys, latestCreatedAt, downloadFileName } = groupedChunks[sessionId]

          // 削除
          await deleteChunkByKeys('Temps', keys)

          // チャンク数のチェック
          if (blobs.length <= 2) {
            throw new Error("チャンク数が少ないので保存をスキップします")
          }

          // チャンクを結合
          const blob = new Blob(blobs, { type: "video/mp4" })
          const screenShot_ = await extractFirstFrame(blob) as string
          if (!screenShot_) {
            throw new Error("スクリーンショットの取得に失敗しました（チャンクが正しくない）")
          }

          // `Chunks` に保存
          const key = await saveChunk('Chunks', sessionId, latestCreatedAt, blob, screenShot_, latestCreatedAt, downloadFileName)
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

    // 不完全なtempファイルを取得・削除し結合して保存
    await mergeStaleChunks()

    const chunks = await getAllChunks('Chunks')

    recordedMovieBox.innerHTML = ""
    for (const chunk of chunks.reverse()) {
      insertRecordedMovie([chunk.sessionId, chunk.chunkIndex], chunk.imgUrl)
      await new Promise(resolve => setTimeout(resolve, 10)) // ライブ画面のフリーズを回避するためにインターバルを入れる
    }
  }

  const downloadRecordedMovie = async (key: [string, number]) => {
    try {
      const chunk = await getChunkByKey('Chunks', key)
      if (!chunk) {
        alert('動画データが見つかりませんでした')
        return
      }

      const url = URL.createObjectURL(chunk.blob)

      // ダウンロードファイル名を取得
      const filename = chunk.downloadFileName || 'video.mp4'

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
  
  const insertRecordedMovie = (
    key: IDBValidKey,
    imgUrl: string | null,
    insertPosition: string = 'start'
  ) => {
    const [sessionId_, chunkIndex_] = key as [string, string]

    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    const recordedMovie = document.createElement("div")
    recordedMovie.classList.add("recordedMovie")
    recordedMovie.setAttribute('sessionId', sessionId_)
    recordedMovie.setAttribute('chunkIndex', chunkIndex_)

    // メイン画像
    const img = document.createElement("img")
    if (imgUrl) img.src = imgUrl || chrome.runtime.getURL("assets/images/defaultScreenshot.webp")
    recordedMovie.appendChild(img)

    // ✕ボタン（削除）
    const closeButton = document.createElement("button")
    closeButton.classList.add("closeButton")
    closeButton.textContent = "✕"
    closeButton.title = "削除"
    closeButton.addEventListener("click", async (e) => {
      e.stopPropagation()
      const confirmDelete = window.confirm("この動画データを削除しますか？")
      if (confirmDelete) {
        // UIから削除
        recordedMovie.remove()
        // indexedDBから削除
        await deleteChunkByKeys('Chunks', [key])
      }
    })
    recordedMovie.appendChild(closeButton)

    // ダウンロードボタン
    const downloadButton = document.createElement("button")
    downloadButton.classList.add("downloadButton")
    downloadButton.textContent = "DL"
    downloadButton.title = "ダウンロード"
    downloadButton.addEventListener("click", (e) => {
      e.stopPropagation()
      downloadRecordedMovie(key as [string, number])
    })
    recordedMovie.appendChild(downloadButton)

    // クリックでモーダルを開く
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
              <div class="capbutton" id="capButton">
                <img src="${chrome.runtime.getURL("assets/images/camera.png")}" title="スクリーンショット" />
              </div>
              <button type="button" id="startButton" disabled>録画開始</button>
              <button type="button" id="stopButton" disabled>停止</button>
            </div>
            <div class="control-status">
              <div id="recordStatus">準備中</div>
              <div id="recordTime">00:00:00</div>
            </div>
            <div class="control-buttons">
              <button type="button" id="reloadButton">リスト更新</button>
              <button type="button" id="clearButton">リセット</button>
            </div>
          </div>
        </div>
      </div>
    `
    controlArea.insertAdjacentHTML("afterend", recordedMovieHTML)

    capButton = document.getElementById("capButton") as HTMLButtonElement
    startButton = document.getElementById("startButton") as HTMLButtonElement
    stopButton = document.getElementById("stopButton") as HTMLButtonElement
    recordStatus = document.getElementById("recordStatus") as HTMLDivElement
    const reloadButton = document.getElementById("reloadButton") as HTMLButtonElement
    const clearButton = document.getElementById("clearButton") as HTMLButtonElement

    // キャプチャボタン
    capButton.addEventListener("click", async () => {
      if (video) {
        getScreenShotAndDownload()
      }
    })

    // 録画ボタン
    startButton.addEventListener("click", async () => {
      if (mediaRecorder && mediaRecorder.state === "inactive") {
        mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
        resetTimeoutCheck()
        setRecordingStatus(false, true, "🔴録画中")
      }
    })

    // 停止ボタン
    stopButton.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop()
      }
    })

    // 録画リスト更新ボタン
    reloadButton.addEventListener("click", async () => {
      // 録画リストを更新
      await reloadRecordedMovieList()
    })

    // リセットボタン
    clearButton.addEventListener("click", async () => {
      const confirmDelete = window.confirm("すべての録画データを削除しますか？")
      if (confirmDelete) {
        setRecordingStatus(false, false, 'リセット中')
        try {
          const cleanUp = async () => {
            // リセット（すべてのチャンクを削除）
            await cleanUpAllChunks('Chunks')
            await cleanUpAllChunks('Temps')

            reloadRecordedMovieList() // 録画リストを更新
          }

          if (mediaRecorder && mediaRecorder.state === "recording") {
            // `onstop` の実行が完全に終わるのを待つ
            mediaRecorder.onstop = async () => {
              await cleanUp() // リセット
              startNewRecorder() // 録画を再開
            }
            // recorder を停止
            mediaRecorder.stop()
          } else {
            await cleanUp() // リセット
            setRecordingStatus(true, false, 'リセット完了')
          }
        }
        catch (error) {
          console.log("リセットに失敗しました:", error)
        }
      }
    })
  }

  // モーダルを作成する関数
  function createModal() {
    if (document.getElementById('video-modal')) return // すでに作成済みならスキップ

    // Body要素を取得
    const body = document.querySelector('body')
    if (!body) return

    const modal = document.createElement('div')
    modal.id = 'video-modal'
    modal.innerHTML = `
      <div class="modal-content">
          <span id="close-modal" class="close">&times;</span>
          <video id="video-player" controls autoplay></video>
      </div>
  `

    const updateModalSize = () => {
      modal.style.width = `${body.offsetWidth}px`
      modal.style.height = `${body.offsetHeight}px`
    }

    updateModalSize() // 初期サイズ設定
    window.addEventListener('resize', updateModalSize) // リサイズ時に更新

    document.body.appendChild(modal)

    // 閉じるボタンの処理
    const closeButton = document.getElementById('close-modal')
    closeButton?.addEventListener('click', () => {
      modal.style.display = 'none'
      const video = document.getElementById('video-player') as HTMLVideoElement
      video.pause()
      video.src = '' // メモリ解放
      window.removeEventListener('resize', updateModalSize) // リスナー削除
    })

    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeButton?.click()
      }
    })
  }


  // 動画を取得してモーダルを開く
  const openModalWithVideo = async (key: IDBValidKey, event: MouseEvent) => {
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
      const { pageX, pageY } = event
      const modalWidth = modalContent.offsetWidth
      const modalHeight = modalContent.offsetHeight
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight

      let posX = pageX - (modalWidth / 2)
      let posY = pageY - modalHeight - 50

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

  const getScreenShotAndDownload = () => {
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
    const now = Date.now()
    a.download = `${userName}_${title}_${new Date(now).toLocaleString()}.png`

    // 自動クリックでダウンロードを実行
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }


  // ondataavailable の発火が止まったことを検知する
  const resetTimeoutCheck = () => {
    clearTimeout(recordingTimeout)
    recordingTimeout = setTimeout(() => {
      console.log('一定時間データが来なかったため録画を停止します')
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop()
      }
      clearTimeout(recordingTimeout)
    }, SAVE_CHUNK_INTERVAL_MS * 3)
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

  // ユーザー名を取得
  const userName_ = document.querySelector('[class*="_user-name_"]') as HTMLSpanElement | null
  const userName = (userName_?.textContent || '').replace(/[\\/:*?"<>|]/g, '')

  // タイトルを取得
  const title_ = document.querySelector('[class*="_program-title_"]') as HTMLSpanElement | null
  const title = (title_?.textContent || '').replace(/[\\/:*?"<>|]/g, '')

  // UIを作成
  insertRecordedMovieAria()
  createModal()

  // 録画リストを更新
  await reloadRecordedMovieList()

  setTimeout(() => {
    startRec() // 録画を開始
    fixAudioTrack() // ミュート対策
    observeVideoResize() // video の track 変更を監視
  }, 2000)

  // 指定間隔で録画をリセット
  setInterval(() => {
    resetRecording()
  }, RESTART_MEDIARECORDER_INTERVAL_MS)

  
  const observeVideoResize = () => {
    if (!video) return

    video.addEventListener("resize", () => {
      console.log("video の track 変更を検知しました！")

      // recorder を停止
      if (mediaRecorder && mediaRecorder instanceof MediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop()
      }

      // stream を解放
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
      }

      // 新しい録画を開始
      setTimeout(() => {
        startRec()
      }, 1000)
    })
  }

  // 定期実行
  setInterval(() => {
    // console.log(stream.active) // false になっていないか
    // console.log(mediaRecorder.state)
    // stream.getTracks().forEach(t => console.log(t.readyState)) // ended になってないか
    
    // const liveStatus = (window as any).__INITIAL_STATE__?.program?.broadcasterProgram?.programStatus

    // if (liveStatus === 'ON_AIR') {
    //   console.log('ライブ配信中')
    // } else if (liveStatus === 'ENDED') {
    //   console.log('ライブは終了しました')
    // } else {
    //   console.log('ライブの状態が不明です:', liveStatus)
    // }

    // const liveButton = document.querySelector('[data-live-status]')
    // const liveStatus = liveButton?.getAttribute('data-live-status')

    // if (liveStatus === 'live') {
    //   console.log('🎥 ライブ配信中（DOMから検出）')
    // } else if (liveStatus === 'end') {
    //   console.log('📺 配信終了（DOMから検出）')
    // } else {
    //   console.log('❓ 状態が不明です:', liveStatus)
    // }



    // if (!stream.active) {
    //   console.log('ストリームが非アクティブになったため録画停止')
    //   mediaRecorder.stop()
    //   clearInterval(interval)
    // }
  }, 3000)

  // const allKeys = Object.keys((window as any).__REACT_QUERY_STATE__?.queries ?? {})
  // console.log(allKeys)
  // for (const key of allKeys) {
  //   const query = (window as any).__REACT_QUERY_STATE__.queries[key]
  //   console.log(key, query)
  // }
}

