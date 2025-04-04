import { saveChunk, getChunkByKey, getAllChunks, deleteChunkByKeys, cleanUpOldChunks, cleanUpAllChunks, deleteDB } from "../../hooks/indexedDB/recordingDB"
import { startResetRecordInterval, startTimer, startRecordingActions, stopRecordingActions, mergeChunksBySession, mergeStaleChunks, resetTimeoutCheck, fixAudioTrack } from "../../utils/recording"
import { getProgramData, extractFirstFrame, getScreenShotAndDownload } from "../../utils/feature"
import { insertRecordedMovieAria, insertRecordedMovie, createModal, confirmModal, openModalWithVideo, reloadRecordedMovieList, deleteMovieIcon, setRecordingStatus, getTimeString } from "../../utils/ui"
import './style.css'

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

  // 初期値
  const SAVE_CHUNK_INTERVAL_MS = 3 * 1000 // 1 * 1000
  let RESTART_MEDIARECORDER_INTERVAL_MS = 1 * 60 * 1000
  let MAX_STORAGE_SIZE = 1 * 1024 * 1024 * 1024
  let AUTO_START = true

  // 起動時に設定を読み込む
  chrome.storage.sync.get(['RESTART_MEDIARECORDER_INTERVAL_MS', 'MAX_STORAGE_SIZE', 'AUTO_START'], (result) => {
    if (typeof result.RESTART_MEDIARECORDER_INTERVAL_MS === 'number') {
      RESTART_MEDIARECORDER_INTERVAL_MS = result.RESTART_MEDIARECORDER_INTERVAL_MS
    }
    if (typeof result.MAX_STORAGE_SIZE === 'number') {
      MAX_STORAGE_SIZE = result.MAX_STORAGE_SIZE
    }
    if (typeof result.AUTO_START === 'boolean') {
      AUTO_START = result.AUTO_START
    }    
  })

  // 設定変更の反映（オートスタートは対象外）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync') {
      if (changes.RESTART_MEDIARECORDER_INTERVAL_MS) {
        RESTART_MEDIARECORDER_INTERVAL_MS = changes.RESTART_MEDIARECORDER_INTERVAL_MS.newValue
        startResetRecordInterval(
          resetRecording,
          RESTART_MEDIARECORDER_INTERVAL_MS
        )
      }
      if (changes.MAX_STORAGE_SIZE) {
        MAX_STORAGE_SIZE = changes.MAX_STORAGE_SIZE.newValue
      }
    }
  })

  const { userName, title } = getProgramData() // 番組情報を取得
  const sessionId = crypto.randomUUID()  // タブごとの識別子
  let chunkIndex = 0

  const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
  let stream: MediaStream = {} as MediaStream
  let mediaRecorder: MediaRecorder = {} as MediaRecorder

  const initStream = () => {
    if (!video) return
    if (mediaRecorder && mediaRecorder.state === "recording") return

    try {
      // 動画ストリームを取得
      stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()

      if (video.readyState >= 3) {
        console.log("動画が準備完了")
        startNewRecorder()
      } else {
        console.log("動画の準備が完了していないため、待機します...")
        video.addEventListener("canplay", () => {
          console.log("動画が再生可能になりました。")
          startNewRecorder()
        }, { once: true })
      }
    } catch (error) {
      console.log("録画の開始に失敗しました:", error)
    }
  }

  const startNewRecorder = () => {

    const options = {
      // mimeType: 'video/webm; codecs="vp8, opus"'
      mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"'
    }
    mediaRecorder = new MediaRecorder(stream, options)

    // チャンク取得
    mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      console.log("ondataavailable", event.data.size)
      if (event.data.size <= 0) return

      // チャンクを保存
      await saveChunk('Temps', sessionId, chunkIndex++, event.data, null, Date.now(), userName, title)

      resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS)
    }

    mediaRecorder.onstop = async () => {
      await stopRecordingActions(sessionId)
    }

    // 録画を開始
    mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
    startRecordingActions(
      resetRecording,
      mediaRecorder,
      RESTART_MEDIARECORDER_INTERVAL_MS,
      SAVE_CHUNK_INTERVAL_MS
    )
  }

  // 録画を再スタート
  const resetRecording = () => {

    if (mediaRecorder && mediaRecorder.state === "recording") {
      console.log("🔄 録画を切り替えます...")

      mediaRecorder.onstop = async () => {
        await stopRecordingActions(sessionId)

        // ✅ 新しい recorder を開始
        startNewRecorder()
      }

      // recorder を停止
      mediaRecorder.stop()

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
  }

  const start = () => {
    // if (stream === {} as MediaStream) initStream()
    
    if (mediaRecorder && mediaRecorder.state === "inactive") {
      mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
      startRecordingActions(
        resetRecording,
        mediaRecorder,
        RESTART_MEDIARECORDER_INTERVAL_MS,
        SAVE_CHUNK_INTERVAL_MS
      )
    } else {
      initStream()
    }
  }
  const stop = () => {
    console.log("録画を停止します", mediaRecorder)
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop()
    }
  }
  const reload = async () => {
    // 不完全なtempファイルを取得・削除し結合して保存
    await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

    // 録画リストを更新
    await reloadRecordedMovieList()
  }
  const clear = async () => {
    const confirmed = await confirmModal('すべての録画データを削除しますか？')
    if (confirmed) {
      setRecordingStatus(false, false, '準備中')
      try {
        if (mediaRecorder && mediaRecorder.state === "recording") {

          mediaRecorder.onstop = async () => {
            await stopRecordingActions(sessionId)
            setTimeout(async () => {
              await cleanUp(sessionId) // リセット
              // startNewRecorder() // 録画を再開
              // 録画を開始
              mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
              startRecordingActions(
                resetRecording,
                mediaRecorder,
                RESTART_MEDIARECORDER_INTERVAL_MS,
                SAVE_CHUNK_INTERVAL_MS
              )
            }, 500) // 録画停止後にリセット
          }
          // recorder を停止
          mediaRecorder.stop()
        } else {
          await cleanUp(sessionId) // リセット
          setRecordingStatus(true, false, '停止中')
        }
      }
      catch (error) {
        console.log("リセットに失敗しました:", error)
      }
    }
  }

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

      // 新しいストリームを取得し録画を開始
      setTimeout(() => {
        initStream()
      }, 1000)
    })
  }

  // UI類を作成
  insertRecordedMovieAria(
    start,
    stop,
    reload,
    clear
  )
  createModal()

  // 不完全なtempファイルを取得・削除し結合して保存
  await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

  setTimeout(async () => {

    // 録画リストを更新
    await reloadRecordedMovieList()

    // 録画を開始
    setTimeout(() => {
      if (AUTO_START) {
        initStream()
      } else {
        setRecordingStatus(true, false, '停止中')
      }
    }, 2000)

    // ミュート対策
    fixAudioTrack(video)

    // video の track 変更を監視
    observeVideoResize()
  }, 2000)
}

