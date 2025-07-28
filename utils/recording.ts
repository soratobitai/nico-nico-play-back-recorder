import { saveChunk, getAllChunks, deleteChunkByKeys, cleanUpAllChunks } from "../hooks/indexedDB/recordingDB"
import { checkLiveStatus } from '../services/api'
import { setRecordingStatus } from './ui'

// 録画状態の一元管理クラス
export type RecordingState = 'preparing' | 'recording' | 'stopped' | 'error'

export class RecordingStateManager {
  private state: RecordingState = 'stopped'
  private listeners: Array<(state: RecordingState) => void> = []
  private isUpdating = false // 状態更新中のフラグ

  getState() {
    return this.state
  }

  setState(newState: RecordingState) {
    // 状態更新中の場合は待機
    if (this.isUpdating) {
      setTimeout(() => this.setState(newState), 10)
      return
    }

    if (this.state !== newState) {
      this.isUpdating = true
      this.state = newState
      this.updateUI()
      this.listeners.forEach(fn => fn(newState))
      this.isUpdating = false
    }
  }

  onChange(fn: (state: RecordingState) => void) {
    this.listeners.push(fn)
  }

  private updateUI() {
    // setRecordingStatusはApp.tsからimportして使う想定
    switch (this.state) {
      case 'preparing':
        setRecordingStatus(false, false, '準備中')
        break
      case 'recording':
        setRecordingStatus(false, true, '🔴録画中')
        break
      case 'stopped':
        setRecordingStatus(true, false, '停止中')
        break
      case 'error':
        setRecordingStatus(true, false, 'エラー')
        break
    }
  }
}

let recordingTimeout: any // ondataavailable の発火を監視する関数

let startTime: number | null = null
let recordTimer: ReturnType<typeof setInterval> | null = null

// 外部からアクセス可能にするための関数
export const getRecordTimer = () => recordTimer
export const setRecordTimer = (timer: ReturnType<typeof setInterval> | null) => { recordTimer = timer }
export const getStartTime = () => startTime
export const setStartTime = (time: number | null) => { startTime = time }

let resetRecordIntervalId = null as ReturnType<typeof setInterval> | null

// 指定間隔で録画をリセット
const startResetRecordInterval = (
    resetRecording: () => void = () => {},
    RESTART_MEDIARECORDER_INTERVAL_MS: number
) => {
    if (resetRecordIntervalId !== null) {
        clearInterval(resetRecordIntervalId)
    }
    resetRecordIntervalId = setInterval(() => {
        resetRecording()
    }, RESTART_MEDIARECORDER_INTERVAL_MS)
}

const startTimer = () => {
    // 完全にリセット
    if (recordTimer) {
        clearInterval(recordTimer)
        recordTimer = null
    }
    startTime = null
    
    // 少し待ってから完全に新しいタイマーを設定
    setTimeout(() => {
        startTime = Date.now()
        recordTimer = setInterval(() => {
            if (startTime) {
                const timeString = getTimeString(startTime)
                const recordTimeElem = document.getElementById('recordTime')
                if (recordTimeElem) recordTimeElem.textContent = `${timeString}`
            }
        }, 1000)
    }, 50)
}

const startRecordingActions = async (
    resetRecording: () => void,
    mediaRecorder: MediaRecorder,
    RESTART_MEDIARECORDER_INTERVAL_MS: number,
    SAVE_CHUNK_INTERVAL_MS: number,
    autoReloadOnFailure: boolean = false,
    stateManager?: RecordingStateManager,
) => {
    startResetRecordInterval(resetRecording, RESTART_MEDIARECORDER_INTERVAL_MS)
    resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure, stateManager)
    console.log("録画を開始しました。")
}

const stopRecordingActions = async (sessionId: string, stateManager?: RecordingStateManager) => {

    // チャンクを結合して保存
    await mergeChunksBySession(sessionId)

    // 録画時間をリセット
    const resetRecordingTimer = () => {
        if (recordTimer) {
            clearInterval(recordTimer)
            recordTimer = null
        }
        startTime = null

        const recordTimeElem = document.getElementById('recordTime')
        if (recordTimeElem) recordTimeElem.textContent = '00:00'
    }
    resetRecordingTimer()
    
    // 状態を停止中に更新
    if (stateManager) {
        stateManager.setState('stopped')
    }

    console.log('録画を停止しました')
}

const mergeChunksBySession = async (sessionId: string) => {
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

        // チャンクの最初のuserNameを取得
        const userName = temps[0].userName || ''
        const title = temps[0].title || ''

        // `Chunks` に保存
        const key = await saveChunk('Chunks', sessionId, Date.now(), blob, screenShot_, Date.now(), userName, title)
        console.log(`sessionId: ${sessionId} のチャンクを結合して保存しました`)

        const [sessionId_, chunkIndex_] = key

        // UIに挿入
        const chunkData = {
            sessionId: sessionId_,
            chunkIndex: chunkIndex_,
            blob,
            imgUrl: screenShot_,
            createdAt: Date.now(),
            userName,
            title
        }
        insertRecordedMovie(chunkData, 'end')
    } catch (error) {
        console.log(`sessionId: ${sessionId} の録画データの結合に失敗しました:`, error)
    }
}

const mergeStaleChunks = async (SAVE_CHUNK_INTERVAL_MS: number) => {
    try {
        const now = Date.now()
        const threshold = now - (SAVE_CHUNK_INTERVAL_MS + 1000) // ◯ 秒より前に限定する

        // すべてのデータを取得して sessionId ごとにグループ化
        const temps = await getAllChunks('Temps')
        const groupedChunks: Record<string, { blobs: Blob[], keys: IDBValidKey[][], latestCreatedAt: number, userName: string | null, title: string | null }> = {}

        for (const temp of temps) {
            if (!groupedChunks[temp.sessionId]) {
                groupedChunks[temp.sessionId] = { blobs: [], keys: [], latestCreatedAt: 0, userName: null, title: null }
            }
            groupedChunks[temp.sessionId].blobs.push(temp.blob)
            groupedChunks[temp.sessionId].keys.push([temp.sessionId, temp.chunkIndex])
            groupedChunks[temp.sessionId].latestCreatedAt = Math.max(groupedChunks[temp.sessionId].latestCreatedAt, temp.createdAt)
            groupedChunks[temp.sessionId].userName = temp.userName
            groupedChunks[temp.sessionId].title = temp.title
        }

        for (const sessionId in groupedChunks) {
            // `createdAt` が ◯ 秒以上前のグループのみ処理
            if (groupedChunks[sessionId].latestCreatedAt < threshold) {
                const { blobs, keys, latestCreatedAt, userName, title } = groupedChunks[sessionId]

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
                const key = await saveChunk('Chunks', sessionId, latestCreatedAt, blob, screenShot_, latestCreatedAt, userName, title)
                console.log(`不良チャンク: ${sessionId} のチャンクを結合して保存しました`)
            }
        }
    } catch (error) {
        console.log("不良チャンクの結合に失敗しました:", error)
    }
}

// ondataavailable の発火が止まったことを検知する
const resetTimeoutCheck = (
    mediaRecorder: MediaRecorder,
    SAVE_CHUNK_INTERVAL_MS: number,
    autoReloadOnFailure: boolean = false,
    stateManager?: RecordingStateManager,
) => {
    clearTimeout(recordingTimeout)
    recordingTimeout = setTimeout(async () => {

        // ライブが続いているか確認
        const liveStatus = await checkLiveStatus()
        if (liveStatus === 'ON_AIR') {
            if (mediaRecorder.state === 'recording') {
                // ライブが続いていて、かつ録画中の場合のみリロードボタンを押す
                if (autoReloadOnFailure) {
                    const reloadButton = document.querySelector('button[class*="___reload-button___"]') as HTMLButtonElement
                    if (reloadButton) {
                        console.log('ライブが続いていて録画中のためリロードボタンを押します')
                        // リロード前にタイマーをクリア
                        clearTimeout(recordingTimeout)
                        recordingTimeout = null
                        reloadButton.click()
                    }
                } else {
                    console.log('ライブが続いていて録画中ですが、オートリロードが無効になっているためリロードしません')
                }
            }
        } else {
            // 録画を停止
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop()
            }
            console.log('ライブが終了したため録画を停止します')
            
            // 状態を停止中に更新
            if (stateManager) {
                stateManager.setState('stopped')
            }

            clearTimeout(recordingTimeout)
        }
    }, SAVE_CHUNK_INTERVAL_MS * 3)
}

// ミュート対策
const fixAudioTrack = (video: HTMLVideoElement) => {
    // video要素の存在チェック
    if (!video || !(video instanceof HTMLVideoElement)) {
        console.error('fixAudioTrack: 無効なvideo要素です')
        return
    }

    let previousVolume = '0'
    let isMuted = 'false'
    const controlMute = () => {
        try {
            // localStorageアクセスのエラーハンドリング
            isMuted = localStorage.getItem('LeoPlayer_MuteSettingsStore_isMute') || 'false'
            previousVolume = localStorage.getItem('LeoPlayer_VolumeSettingsStore_volume') || '0'

            // 数値変換のエラーハンドリング
            const volumeValue = Number(previousVolume)
            if (isNaN(volumeValue)) {
                console.warn('fixAudioTrack: 無効な音量値です:', previousVolume)
                return
            }

            if (isMuted === 'true' || volumeValue === 0) {
                console.log("🔴 ミュート検出", video.volume)

                video.muted = false
                video.volume = 0.001
            } else {
                console.log("🔊 ミュート解除検出")
                video.volume = volumeValue / 100
            }
        } catch (error) {
            console.error('fixAudioTrack: controlMuteでエラーが発生しました:', error)
        }
    }

    controlMute()

    // ミュートボタン押下時
    try {
        const muteButtons = document.querySelectorAll('[class*="_mute-button_"]')
        muteButtons.forEach(button => {
            if (button instanceof HTMLElement) {
                button.addEventListener("click", () => {
                    controlMute()
                })
            }
        })
    } catch (error) {
        console.error('fixAudioTrack: ミュートボタンのイベントリスナー設定でエラーが発生しました:', error)
    }

    // 音量変化時
    try {
        video.addEventListener("volumechange", async () => {
            controlMute()
        })
    } catch (error) {
        console.error('fixAudioTrack: volumechangeイベントリスナーの設定でエラーが発生しました:', error)
    }
}

const cleanUp = async (sessionId: string) => {

    // リセット（すべてのチャンクを削除）
    await cleanUpAllChunks('Chunks')
    await cleanUpAllChunks('Temps')

    // stopRecordingActions(sessionId)
    loadRecordedMovieList('latest') // 録画リストを更新
}

export {
    startResetRecordInterval,
    startTimer,
    startRecordingActions,
    stopRecordingActions,
    mergeChunksBySession,
    mergeStaleChunks,
    resetTimeoutCheck,
    fixAudioTrack,
    cleanUp,
}
