import { saveChunk, saveMergedChunk, getAllChunks, deleteChunkByKeys, deleteOldestChunks } from "../hooks/indexedDB/recordingDB"
import { checkLiveStatus } from '../services/api'
import { setRecordingStatus, deleteMovieIcon } from './ui'

// 録画状態の一元管理クラス
export type RecordingState = 'preparing' | 'recording' | 'stopped' | 'error'

export class RecordingStateManager {
  private state: RecordingState = 'preparing' // 画面の初期表示（準備中・ボタン無効）に合わせる
  private listeners: Array<(state: RecordingState) => void> = []

  getState() {
    return this.state
  }

  // 同期的にすぐ反映する（後から遅れて反映すると、その間の状態変更と順番が入れ替わる）
  setState(newState: RecordingState) {
    if (this.state === newState) return

    this.state = newState
    this.updateUI()
    this.listeners.forEach(fn => fn(newState))
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
        // 現在は容量不足で保存できない場合のみ
        setRecordingStatus(true, false, '保存エラー')
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

// 録画形式の候補（上から順に、対応している最初の形式を使う）
const RECORDING_MIME_TYPES = [
    'video/mp4; codecs="avc1.640028, mp4a.40.2"',
    'video/webm; codecs="vp9, opus"',
    'video/webm; codecs="vp8, opus"',
]

// mp4 で録画できない環境（H.264 のエンコーダーがない Chromium など）では webm で録画する
const getRecordingMimeType = (): string | undefined =>
    RECORDING_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type))

type ChunkRecord = Awaited<ReturnType<typeof getAllChunks>>[number]

const isQuotaExceeded = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError'

// 容量不足で保存できなかった場合は、古い録画を bytesNeeded バイト以上削除してから1回だけ再試行する
// （設定の上限より実際に使える容量が少ない場合もここで古いものから消える）
const retryOnQuotaExceeded = async <T>(bytesNeeded: number, save: () => Promise<T>): Promise<T> => {
    try {
        return await save()
    } catch (error) {
        if (!isQuotaExceeded(error)) throw error

        const deletedKeys = await deleteOldestChunks('Chunks', bytesNeeded)
        if (deletedKeys.length === 0) throw error // 削除できる録画がない
        console.log(`容量不足のため古い録画を削除しました: ${deletedKeys.length}件`)
        deleteMovieIcon(deletedKeys)

        return await save()
    }
}

// 録画中のチャンクを一時データ（Temps）に保存する
const saveTempChunk = (
    sessionId: string,
    chunkIndex: number,
    blob: Blob,
    createdAt: number,
    userName: string | null,
    title: string | null,
) => retryOnQuotaExceeded(blob.size, () => saveChunk('Temps', sessionId, chunkIndex, blob, null, createdAt, userName, title))

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
    const temps = (await getAllChunks('Temps'))
        .filter(temp => temp.sessionId === sessionId)
        // 録画した順に並べる（作成時刻は PC の時計の補正でずれることがあるので通し番号を使う）
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
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
    // 形式は録画したチャンクに合わせる（mp4 または webm）
    const blob = new Blob(temps.map(temp => temp.blob), { type: temps[0].blob.type || "video/mp4" })
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
    // 保存が確定するまでは結合前と結合後の両方を持つので、容量不足なら結合後のサイズ分を空けて再試行する
    // サムネイルが時間内に取得できなかった場合（null）はデフォルト画像で表示される
    const [, chunkIndex] = await retryOnQuotaExceeded(blob.size, () =>
        saveMergedChunk(sessionId, createdAt, blob, screenShot, createdAt, userName, title, keys)
    )

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

// ライブ状態の確認に続けて失敗した時の、再確認の間隔の上限
const MAX_LIVE_STATUS_RETRY_INTERVAL_MS = 60 * 1000

// ondataavailable の発火が止まったことを検知する
const resetTimeoutCheck = (
    mediaRecorder: MediaRecorder,
    SAVE_CHUNK_INTERVAL_MS: number,
    autoReloadOnFailure: boolean = false,
    failureCount: number = 0, // ライブ状態の確認に続けて失敗した回数（失敗が続くほど間隔を伸ばす）
) => {
    clearTimeout(recordingTimeout)
    const delay = Math.min(SAVE_CHUNK_INTERVAL_MS * 3 * 2 ** failureCount, MAX_LIVE_STATUS_RETRY_INTERVAL_MS)
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
            resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure, failureCount + 1)
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
    }, delay)
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
    getRecordingMimeType,
    isQuotaExceeded,
    retryOnQuotaExceeded,
    saveTempChunk,
    holdSegmentLock,
    mergeChunksBySession,
    mergeStaleChunks,
    resetTimeoutCheck,
    fixAudioTrack,
}
