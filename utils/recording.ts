import { saveMergedChunk, getAllChunks, deleteChunkByKeys } from "../hooks/indexedDB/recordingDB"
import { checkLiveStatus } from '../services/api'
import { setRecordingStatus } from './ui'

// 録画状態の一元管理クラス
export type RecordingState = 'preparing' | 'recording' | 'stopped' | 'error'

export class RecordingStateManager {
  private state: RecordingState = 'preparing' // 画面の初期表示（準備中・ボタン無効）に合わせる
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
    // 前のタイマーを止めてから開始する（二重に動かないようにする）
    stopTimer()

    startTime = Date.now()
    recordTimer = setInterval(() => {
        if (startTime) {
            const timeString = getTimeString(startTime)
            const recordTimeElem = document.getElementById('recordTime')
            if (recordTimeElem) recordTimeElem.textContent = `${timeString}`
        }
    }, 1000)
}

// 録画時間をリセット
const stopTimer = () => {
    if (recordTimer) {
        clearInterval(recordTimer)
        recordTimer = null
    }
    startTime = null

    const recordTimeElem = document.getElementById('recordTime')
    if (recordTimeElem) recordTimeElem.textContent = '00:00'
}

const startRecordingActions = async (
    resetRecording: () => void,
    mediaRecorder: MediaRecorder,
    RESTART_MEDIARECORDER_INTERVAL_MS: number,
    SAVE_CHUNK_INTERVAL_MS: number,
    autoReloadOnFailure: boolean = false,
) => {
    startResetRecordInterval(resetRecording, RESTART_MEDIARECORDER_INTERVAL_MS)
    resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure)
    console.log("録画を開始しました。")
}

type ChunkRecord = Awaited<ReturnType<typeof getAllChunks>>[number]

// 録画中〜結合完了までの区間を、他のタブや「録画リスト更新」から結合させないためのロック
// タブを閉じたり再読み込みしたりすると自動で解放されるので、解放されている区間は放置されたものとみなせる
const segmentLockName = (sessionId: string) => `recording-segment-${sessionId}`

// 区間のロックを取得して保持する。返り値の関数を呼ぶと解放する
const holdSegmentLock = (sessionId: string): (() => void) => {
    let release = () => {}
    if (!navigator.locks) return release

    const released = new Promise<void>(resolve => { release = resolve })
    navigator.locks.request(segmentLockName(sessionId), () => released)
        .catch((error) => console.log('区間のロックを取得できませんでした:', error))
    return release
}

// sessionId の Temps を1本の動画に結合して Chunks に保存し、Temps を削除する
// 同じ区間を同時に結合しないよう、呼び出し側で区間のロックを持っていること
// 保存した動画データを返す（保存しなかった場合は null）
const mergeTemps = async (sessionId: string, createdAt: number): Promise<ChunkRecord | null> => {
    const temps = (await getAllChunks('Temps')).filter(temp => temp.sessionId === sessionId)
    if (temps.length === 0) return null

    const keys = temps.map(temp => [temp.sessionId, temp.chunkIndex])

    // チャンク数のチェック
    if (temps.length <= 2) {
        console.log(`sessionId: ${sessionId} のチャンク数が少ないので保存をスキップします`)
        await deleteChunkByKeys('Temps', keys)
        return null
    }
    console.log(`sessionId: ${sessionId} のチャンク数: ${temps.length}`)

    // チャンクを結合
    const blob = new Blob(temps.map(temp => temp.blob), { type: "video/mp4" })
    const screenShot = await extractFirstFrame(blob)
    if (screenShot === '') {
        console.log(`sessionId: ${sessionId} は動画として読み込めないため保存をスキップします（チャンクが正しくない）`)
        await deleteChunkByKeys('Temps', keys)
        return null
    }

    // チャンクの最初のuserNameを取得
    const userName = temps[0].userName || ''
    const title = temps[0].title || ''

    // `Chunks` への保存と Temps の削除を同時に行う（失敗した場合は Temps が残り、mergeStaleChunks で再試行される）
    // サムネイルが時間内に取得できなかった場合（null）はデフォルト画像で表示される
    const [, chunkIndex] = await saveMergedChunk(sessionId, createdAt, blob, screenShot, createdAt, userName, title, keys)

    return { sessionId, chunkIndex, blob, imgUrl: screenShot, createdAt, userName, title }
}

// 放置された区間（どのタブもロックを持っていない区間）だけを結合する
const mergeIfAbandoned = async (sessionId: string, createdAt: number): Promise<ChunkRecord | null> => {
    if (!navigator.locks) return mergeTemps(sessionId, createdAt)

    let granted = false
    try {
        return await navigator.locks.request(segmentLockName(sessionId), { ifAvailable: true }, (lock) => {
            granted = true
            // 録画中・結合中の区間はロックが取れない（lock が null）ので触らない
            return lock ? mergeTemps(sessionId, createdAt) : null
        })
    } catch (error) {
        // ロック自体が使えない環境では、時間による判定だけで結合する
        if (!granted) return mergeTemps(sessionId, createdAt)
        throw error
    }
}

const mergeChunksBySession = async (sessionId: string) => {
    try {
        const chunk = await mergeTemps(sessionId, Date.now())
        if (!chunk) return
        console.log(`sessionId: ${sessionId} のチャンクを結合して保存しました`)

        // UIに挿入
        insertRecordedMovie(chunk, 'end')
    } catch (error) {
        console.log(`sessionId: ${sessionId} の録画データの結合に失敗しました:`, error)
    }
}

const mergeStaleChunks = async (SAVE_CHUNK_INTERVAL_MS: number) => {
    try {
        const now = Date.now()
        const threshold = now - (SAVE_CHUNK_INTERVAL_MS + 1000) // ◯ 秒より前に限定する

        // すべてのデータを取得して sessionId ごとに最新の createdAt を求める
        const temps = await getAllChunks('Temps')
        const latestCreatedAt: Record<string, number> = {}
        for (const temp of temps) {
            latestCreatedAt[temp.sessionId] = Math.max(latestCreatedAt[temp.sessionId] ?? 0, temp.createdAt)
        }

        for (const sessionId in latestCreatedAt) {
            // `createdAt` が ◯ 秒以上前のグループのみ処理
            // （ロックを持たない旧バージョンのスクリプトが録画中のタブを守るため、ロックと併用する）
            if (latestCreatedAt[sessionId] >= threshold) continue

            // 1つのセッションで失敗しても残りのセッションは処理する
            try {
                const chunk = await mergeIfAbandoned(sessionId, latestCreatedAt[sessionId])
                if (chunk) console.log(`不良チャンク: ${sessionId} のチャンクを結合して保存しました`)
            } catch (error) {
                console.log(`不良チャンク: ${sessionId} の結合に失敗しました:`, error)
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
) => {
    clearTimeout(recordingTimeout)
    recordingTimeout = setTimeout(async () => {
        // 既に停止している recorder は監視しない（ライブ状態の確認中に停止される場合もあるので確認後にも見る）
        const isInactive = () => mediaRecorder.state === 'inactive'
        if (isInactive()) return

        // ライブが続いているか確認
        const liveStatus = await checkLiveStatus()
        if (isInactive()) return

        if (liveStatus === 'ERROR') {
            // 取得失敗（ネットワーク断など）は放送終了と区別できないので、録画は止めずに再確認する
            console.log('ライブ状態を取得できなかったため再確認します')
            resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure)
        } else if (liveStatus === 'ON_AIR') {
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
            // 録画を停止（状態の更新は recorder の onstop で行う）
            mediaRecorder.stop()
            console.log('ライブが終了したため録画を停止します')

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

export {
    startResetRecordInterval,
    startTimer,
    stopTimer,
    startRecordingActions,
    holdSegmentLock,
    mergeChunksBySession,
    mergeStaleChunks,
    resetTimeoutCheck,
    fixAudioTrack,
}
