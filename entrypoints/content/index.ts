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
      fixAudioTrack() // ミュート対策
    } catch (error) {
      console.error("録画の開始に失敗しました:", error)
    }
  }

  const startNewRecorder = () => {

    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm; codecs=vp9" })

    mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      // 録画データを保存
      await saveTempToIndexedDB(event.data)
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

  //  video = getVideo()
  //  stream = getStream()
  //  mediaRecorder = getMediaRecorder()

    if (mediaRecorder && mediaRecorder.state === "recording") {
      console.log("🔄 録画を切り替えます...")

      const oldRecorder = mediaRecorder

      // ✅ 新しい recorder を開始
      startNewRecorder()

      // ここで `mediaRecorder` が切り替わるのを待つ
      setTimeout(() => {
        if (mediaRecorder !== oldRecorder) {
          console.log("✅ 新しい録画が開始されたことを確認しました")

          // ✅ 旧 recorder を停止
          oldRecorder.stop()

          // `onstop` の実行が完全に終わるのを待つ
          oldRecorder.onstop = async () => {
            console.log("🛑 古い録画を停止しました。")

            // setRecordingStatus(false)

            setTimeout(async () => {
              // チャンクを結合して保存
              await mergeWebMChunksBySession()
            }, 500) // 0.5秒待ってから実行
          }
        }
      }, 200) // 200ms 待って新しい recorder が安定するのを確認

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
      const key = await saveChunk('Chunks', sessionId, Date.now(), webmBlob, screenShot_)
      console.log(`sessionId: ${sessionId} のチャンクを結合して保存しました`)

      // UIに挿入
      insertRecordedMovie(key, screenShot_, 'end')
    } catch (error) {
      console.error(`sessionId: ${sessionId} の録画データの結合に失敗しました:`, error)
    }
  }

  const mergeStaleChunks = async () => {
    try {
      const now = Date.now()
      const threshold = now - 5000 // 5 秒前

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

      // `createdAt` が 5 秒以上前のグループのみ処理
      for (const sessionId in groupedChunks) {
        if (groupedChunks[sessionId].latestCreatedAt < threshold) {
          const { blobs, keys } = groupedChunks[sessionId]

          // 削除
          await deleteChunkByKeys('Temps', keys)

          // チャンクを結合
          const webmBlob = new Blob(blobs, { type: "video/webm" })
          const screenShot_ = await extractFirstFrame(webmBlob) as string

          // `Chunks` に保存
          const key = await saveChunk('Chunks', sessionId, Date.now(), webmBlob, screenShot_)
          console.log(`不良チャンク: ${sessionId} のチャンクを結合して保存しました`)

          // UIに挿入
          insertRecordedMovie(key, screenShot_, 'end')
        }
      }
    } catch (error) {
      console.error("不良チャンクの結合に失敗しました:", error)
    }
  }


  // const mergeWebMChunks = async () => {
  //   try {
  //     // tempファイルを取得
  //     const temps = await getAllChunks('Temps')
  //     if (temps.length === 0) return

  //     // sessionId ごとにチャンクをグループ化
  //     const groupedChunks: Record<string, { blobs: Blob[], keys: IDBValidKey[][] }> = {}

  //     for (const temp of temps) {
  //       if (!groupedChunks[temp.sessionId]) {
  //         groupedChunks[temp.sessionId] = { blobs: [], keys: [] }
  //       }
  //       groupedChunks[temp.sessionId].blobs.push(temp.blob)
  //       groupedChunks[temp.sessionId].keys.push([temp.sessionId, temp.chunkIndex])
  //     }

  //     // sessionId ごとに処理
  //     for (const sessionId in groupedChunks) {
  //       const { blobs, keys } = groupedChunks[sessionId]

  //       // チャンクを削除
  //       await deleteChunkByKeys('Temps', keys)

  //       // チャンクを結合
  //       const webmBlob = new Blob(blobs, { type: "video/webm" })
  //       const screenShot_ = await extractFirstFrame(webmBlob) as string

  //       // Chunks に保存
  //       const key = await saveChunk('Chunks', sessionId, Date.now(), webmBlob, screenShot_)
  //       console.log(`sessionId: ${sessionId} のチャンクを結合して保存しました`)
  //     }
  //   } catch (error) {
  //     console.error("録画データの結合に失敗しました:", error)
  //   }
  // }

  // const mergeWebMChunks = async () => {
  //   const chunks_: Blob[] = []
  //   const keys: IDBValidKey[][] = []

  //   try {
  //     // tempファイルを取得し削除
  //     const temps = await getAllChunks('Temps')
  //     if (temps.length === 0) return
  //     for (const temp of temps) {
  //       chunks_.push(temp.blob)
  //       keys.push([temp.sessionId, temp.chunkIndex])
  //     }
  //     await deleteChunkByKeys('Temps', keys)

  //     // 結合して保存
  //     const webmBlob = new Blob(chunks_, { type: "video/webm" })
  //     const screenShot_ = await extractFirstFrame(webmBlob) as string
  //     const key = await saveChunk('Chunks', sessionId, chunkIndex++, webmBlob, screenShot_)

  //     console.log("チャンクを結合して保存しました")

  //     return { key, screenShot_ }
  //   } catch (error) {
  //     console.error("録画データの結合に失敗しました:", error)
  //   }
  // }

  const reloadRecordedMovieList = async () => {
    const chunks = await getAllChunks('Chunks')
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    recordedMovieBox.innerHTML = ""

    for (const chunk of chunks.reverse()) {
      insertRecordedMovie([chunk.sessionId, chunk.chunkIndex], chunk.imgUrl)
      await new Promise(resolve => setTimeout(resolve, 10)) // ライブ画面のフリーズを回避するためにインターバルを入れる
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

    await saveChunk('Temps', sessionId, chunkIndex++, data, null)
  }


  const insertRecordedMovie = (key: IDBValidKey, imgUrl: string | null, insertPosition: string = 'start') => {

    let sessionId_ = "" as IDBValidKey
    let chunkIndex_ = 0 as IDBValidKey
    if (Array.isArray(key)) {
      sessionId_ = key[0]
      chunkIndex_ = key[1]
    }

    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    // 新しい要素を作成してスクリーンショットを挿入
    const recordedMovie = document.createElement("div")
    recordedMovie.classList.add("recordedMovie")
    recordedMovie.innerHTML = `<img src="${imgUrl}" sessionId="${sessionId_}" chunkIndex="${chunkIndex_}" />`

    // クリックイベントを追加
    recordedMovie.addEventListener('click', (event) => {
      const key = [
        (event.target as HTMLElement).getAttribute('sessionId') as IDBValidKey,
        Number((event.target as HTMLElement).getAttribute('chunkIndex')) as IDBValidKey
      ]
      if (!key) return
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
      console.error('動画のロードに失敗しました:', error)
    }
  }

  // 動画の最初のフレームを取得する関数
  const extractFirstFrame = async (blob: Blob) => {
    if (!blob.type.startsWith('video/')) {
      console.warn(`Invalid blob type: ${blob.type}, returning default image`)
      return defaultScreenshot
    }

    const video = document.createElement('video')
    const objectURL = URL.createObjectURL(blob)
    video.src = objectURL
    video.muted = true
    video.playsInline = true
    video.crossOrigin = "anonymous"

    return new Promise((resolve) => {
      const cleanUp = () => {
        URL.revokeObjectURL(objectURL)
        video.remove()
      }

      video.onloadeddata = () => {
        video.currentTime = 0
      }

      video.onseeked = () => {
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
            console.warn('Canvas context is not available, returning default image')
            resolve(defaultScreenshot) // エラー時はデフォルト画像を返す
          }
        } catch (err) {
          console.error('Error capturing first frame:', err)
          resolve(defaultScreenshot) // エラー時はデフォルト画像を返す
        } finally {
          cleanUp()
        }
      }

      video.onerror = (e) => {
        console.error('Video load error:', e)
        cleanUp()
        resolve(defaultScreenshot) // エラー時はデフォルト画像を返す
      }
    })
  }

  // const extractFirstFrame = async (blob: Blob) => {
  //   if (!blob.type.startsWith('video/')) {
  //     throw new Error(`Invalid blob type: ${blob.type}`)
  //   }

  //   const video = document.createElement('video')
  //   const objectURL = URL.createObjectURL(blob)
  //   video.src = objectURL
  //   video.muted = true
  //   video.autoplay = false
  //   video.playsInline = true
  //   video.crossOrigin = "anonymous"

  //   return new Promise((resolve, reject) => {
  //     const cleanUp = () => {
  //       URL.revokeObjectURL(objectURL)
  //       video.remove()
  //     }

  //     video.onloadeddata = () => {
  //       video.currentTime = 0 // 最初のフレームを確実に設定
  //     }

  //     video.oncanplay = async () => {
  //       try {
  //         await video.play()
  //         setTimeout(() => {
  //           video.pause()

  //           requestAnimationFrame(() => {
  //             const canvas = document.createElement('canvas')
  //             const aspectRatio = video.videoHeight / video.videoWidth
  //             canvas.width = 100 // 幅を100pxに固定
  //             canvas.height = Math.round(100 * aspectRatio) // 高さをアスペクト比に応じて調整

  //             const ctx = canvas.getContext('2d', { willReadFrequently: true })
  //             if (ctx) {
  //               ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  //               resolve(canvas.toDataURL('image/jpeg', 0.7)) // JPEGで軽量化し、品質70%に設定
  //             } else {
  //               reject(new Error('Canvas context is not available'))
  //             }

  //             cleanUp()
  //           })
  //         }, 100) // 100ms 待機して確実にフレームがセットされるようにする
  //       } catch (err) {
  //         reject(err)
  //       }
  //     }

  //     video.onerror = (e) => {
  //       cleanUp()
  //       reject(new Error(`Video load error: ${JSON.stringify(e)}`))
  //     }
  //   })
  // }




  // const extractFirstFrame = async (blob: Blob): Promise<string> => {
  //   return new Promise((resolve, reject) => {
  //     if (!blob.type.startsWith('video/')) {
  //       reject(new Error(`Invalid blob type: ${blob.type}`))
  //       return
  //     }

  //     const video = document.createElement('video')
  //     const objectURL = URL.createObjectURL(blob)

  //     video.src = objectURL
  //     video.muted = true
  //     video.autoplay = false
  //     video.playsInline = true

  //     // CORS制限がある場合に必要
  //     // video.crossOrigin = "anonymous"

  //     const cleanUp = () => {
  //       URL.revokeObjectURL(objectURL)
  //       video.remove()
  //     }

  //     video.onloadeddata = () => {
  //       video.currentTime = 0 // 最初のフレームへ移動
  //     }

  //     video.oncanplay = () => {
  //       // 再生してすぐ止めることで、確実にフレームを取得
  //       video.play().then(() => {
  //         setTimeout(() => {
  //           video.pause()

  //           const canvas = document.createElement('canvas')
  //           canvas.width = video.videoWidth
  //           canvas.height = video.videoHeight
  //           const ctx = canvas.getContext('2d')

  //           if (ctx) {
  //             ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  //             resolve(canvas.toDataURL('image/png'))
  //           } else {
  //             reject(new Error('Canvas context is not available'))
  //           }

  //           cleanUp()
  //         }, 100) // 100ms 待つことでフレーム描画を確実にする
  //       }).catch(reject)
  //     }

  //     video.onerror = (e) => {
  //       cleanUp()
  //       reject(new Error(`Video load error: ${JSON.stringify(e)}`))
  //     }
  //   })
  // }



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




  /////////////////////////////////////////////////////////////////////
  
  // indexedDBをすべてクリア
  // deleteDB('RecordingDB').then(() => {
  //   console.log('Database deleted successfully.')
  // }).catch(error => {
  //   console.error('Error deleting database:', error)
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

  // 指定間隔で録画をリセット
  setInterval(() => {
    resetRecording()
  }, CHUNK_RESTART_INTERVAL_MS)

  // video の track 変更を監視
  video.addEventListener("resize", () => {
    console.log("video の track 変更を検知しました！")

    // 古い recorder を停止
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
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

