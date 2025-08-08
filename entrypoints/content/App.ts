import { saveChunk, cleanUpOldChunks } from "../../hooks/indexedDB/recordingDB"
import { startResetRecordInterval, startRecordingActions, stopRecordingActions, mergeStaleChunks, resetTimeoutCheck, fixAudioTrack, RecordingStateManager, getRecordTimer, setRecordTimer, setStartTime } from "../../utils/recording"
import { getProgramData } from "../../utils/feature"
import { insertRecordedMovieAria, createModal, loadRecordedMovieList, deleteMovieIcon } from "../../utils/ui"
import { RESTART_MEDIARECORDER_INTERVAL_MS, MAX_STORAGE_SIZE, AUTO_START, AUTO_RELOAD_ON_FAILURE } from '../../utils/storage'
import { checkLiveStatus } from '../../services/api'
import SettingsModal from './settings-modal'
import './settings-modal.css'

// 録画状態の一元管理クラス

const stateManager = new RecordingStateManager()

export default async () => {

    // ステータスを確認
    const liveStatus = await checkLiveStatus()
    if (liveStatus !== 'ON_AIR') return

    let restartInterval = 1 * 60 * 1000
    let maxStorageSize = 1 * 1024 * 1024 * 1024
    let autoStart = true
    let autoReloadOnFailure = false

    // 録画を再スタート
    const resetRecording = () => {

        if (mediaRecorder && mediaRecorder.state === "recording") {
            console.log("🔄 録画を切り替えます...")
            stateManager.setState('preparing')

            mediaRecorder.onstop = async () => {
                await stopRecordingActions(sessionId, stateManager)
                // ✅ 新しい recorder を開始
                startNewRecorder()
            }

            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop()
            }

            // ✅ 容量超過分のチャンクを削除（マージとズラす）
            setTimeout(async () => {
                // indexedDBから削除
                const deletedKeys = await cleanUpOldChunks('Chunks', maxStorageSize)
                if (deletedKeys.length === 0) return
                console.log(`容量超過分のチャンクを削除しました: ${deletedKeys.length}件`, deletedKeys)

                // UIから削除
                deleteMovieIcon(deletedKeys)

            }, restartInterval / 2)
        }
    }

    // 初期設定読み込み
    const loadSettings = async () => {
        restartInterval = await RESTART_MEDIARECORDER_INTERVAL_MS.getValue()
        let size = await MAX_STORAGE_SIZE.getValue()
        autoStart = await AUTO_START.getValue()
        autoReloadOnFailure = await AUTO_RELOAD_ON_FAILURE.getValue()

        maxStorageSize = size

        startResetRecordInterval(resetRecording, restartInterval)
    }
    await loadSettings()

    // 設定変更の反映（RESTART_MEDIARECORDER_INTERVAL_MSとMAX_STORAGE_SIZEのみ監視）
    RESTART_MEDIARECORDER_INTERVAL_MS.watch((newValue) => {
        restartInterval = newValue
        startResetRecordInterval(resetRecording, restartInterval)
    })
    MAX_STORAGE_SIZE.watch((newValue) => {
        maxStorageSize = newValue
    })
    AUTO_RELOAD_ON_FAILURE.watch((newValue) => {
        autoReloadOnFailure = newValue
    })

    const SAVE_CHUNK_INTERVAL_MS = 3 * 1000
    const { userName, title } = getProgramData() // 番組情報を取得
    const sessionId = crypto.randomUUID()  // タブごとの識別子
    let chunkIndex = 0

    const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    let stream: MediaStream = {} as MediaStream
    let mediaRecorder: MediaRecorder = {} as MediaRecorder



    const initStream = (startRecording: boolean = true) => {
        if (!video) return
        
        // mediaRecorder.state のチェックを削除し、代わりに stateManager の状態をチェック
        if (stateManager.getState() === 'recording') return

        // 録画開始前の状態を準備中に設定
        if (startRecording) {
            stateManager.setState('preparing')
        }

        // リロードボタンを押す共通関数
        const clickReloadButton = (reason: string) => {
            if (!autoReloadOnFailure) {
                console.log(`${reason}が発生しましたが、自動リロードが無効になっているためリロードしません`)
                return
            }
            const reloadButton = document.querySelector('button[class*="___reload-button___"]') as HTMLButtonElement
            if (reloadButton) {
                console.log(`${reason}のためリロードボタンを押します`)
                reloadButton.click()
            }
        }

        // ヘルパー関数をinitStream内に定義
        const isVideoReady = (video: HTMLVideoElement): boolean => {
            return video.readyState >= 4 && !video.paused && video.currentTime > 0
        }

        const isVideoPrepared = (video: HTMLVideoElement): boolean => {
            return video.readyState >= 3
        }

        const startRecordingFromStream = (video: HTMLVideoElement) => {
            if (startRecording) {
                // 録画開始処理
                try {
                    stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
                    startNewRecorder()
                } catch (error) {
                    console.log("録画の開始に失敗しました:", error)
                    // 録画開始に失敗した場合は状態を停止中に設定
                    stateManager.setState('stopped')
                    // リロードボタンを押す
                    clickReloadButton("録画開始に失敗")
                }
            } else {
                // 準備完了のみ
                stateManager.setState('stopped')
            }
        }

        const waitForVideoReady = (video: HTMLVideoElement, callback: () => void) => {
            const timeoutId = setTimeout(() => {
                // タイムアウトした場合は状態を停止中に設定
                if (startRecording) {
                    stateManager.setState('stopped')
                    clickReloadButton("動画の準備完了待機がタイムアウト")
                }
            }, 3000)

            video.addEventListener("canplay", () => {
                console.log("動画が再生可能になりました。")
                clearTimeout(timeoutId) // タイムアウトをクリア
                setTimeout(() => {
                    if (!video.paused && video.currentTime > 0) {
                        callback()
                    } else {
                        console.log("動画が再生可能になりましたが、まだ再生されていません")
                        // 再生されていない場合は状態を停止中に設定
                        if (startRecording) {
                            stateManager.setState('stopped')
                        }
                    }
                }, 500)
            }, { once: true })
        }

        const executeWhenReady = (callback: () => void) => {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', callback, { once: true })
            } else if (document.readyState === 'interactive') {
                setTimeout(callback, 100)
            } else {
                callback()
            }
        }

        // メインロジック
        const handleVideoInitialization = () => {
            if (isVideoReady(video)) {
                console.log("動画が完全に準備完了し、再生中です")
                startRecordingFromStream(video)
            } else if (isVideoPrepared(video)) {
                console.log("動画が準備完了しましたが、再生状態を確認中...")
                setTimeout(() => {
                    if (isVideoReady(video)) {
                        console.log("動画の再生状態が確認できました")
                        startRecordingFromStream(video)
                    } else {
                        console.log("動画の準備が完了していないため、待機します...")
                        waitForVideoReady(video, () => startRecordingFromStream(video))
                    }
                }, 1000)
            } else {
                console.log("動画の準備が完了していないため、待機します...")
                waitForVideoReady(video, () => startRecordingFromStream(video))
            }
        }

        // 実行開始
        executeWhenReady(handleVideoInitialization)
    }

    let recordingStateCheckInterval: ReturnType<typeof setInterval> | null = null

    const startNewRecorder = () => {
        // 既存の録画状態監視をクリア
        if (recordingStateCheckInterval) {
            clearInterval(recordingStateCheckInterval)
            recordingStateCheckInterval = null
        }

        const options = {
            // mimeType: 'video/webm; codecs="vp8, opus"'
            mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"'
        }
        
        try {
            mediaRecorder = new MediaRecorder(stream, options)
        } catch (error) {
            console.log("MediaRecorderの作成に失敗しました:", error)
            stateManager.setState('stopped')
            return
        }

        // 録画開始イベントでカウンター開始
        mediaRecorder.onstart = () => {
            startTimer()
            // 録画開始時に状態を録画中に設定
            stateManager.setState('recording')
        }

        // チャンク取得
        mediaRecorder.ondataavailable = async (event: BlobEvent) => {
            console.log("ondataavailable", event.data.size)
            if (event.data.size <= 0) return

            // チャンクを保存
            await saveChunk('Temps', sessionId, chunkIndex++, event.data, null, Date.now(), userName, title)

            resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure)
        }

        mediaRecorder.onstop = async () => {
            await stopRecordingActions(sessionId, stateManager)
            // 録画停止時に監視もクリア
            if (recordingStateCheckInterval) {
                clearInterval(recordingStateCheckInterval)
                recordingStateCheckInterval = null
            }
            // 状態を停止中に更新
            stateManager.setState('stopped')
        }

        // 録画状態の監視を開始
        recordingStateCheckInterval = setInterval(() => {
            if (mediaRecorder.state === 'recording' && !getRecordTimer()) {
                console.log('録画状態確認: カウンター開始')
                startTimer()
            } else if (mediaRecorder.state !== 'recording' && getRecordTimer()) {
                console.log('録画状態確認: カウンター停止')
                const currentTimer = getRecordTimer()
                if (currentTimer) {
                    clearInterval(currentTimer)
                    setRecordTimer(null)
                }
                setStartTime(null)
            }
        }, 100)

        // 録画を開始
        try {
            mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
            startRecordingActions(
                resetRecording,
                mediaRecorder,
                restartInterval,
                SAVE_CHUNK_INTERVAL_MS,
                autoReloadOnFailure,
                stateManager
            )
        } catch (error) {
            console.log("録画の開始に失敗しました:", error)
            stateManager.setState('stopped')
        }
    }



    const start = () => {
        // クリア後や新規録画時は必ず新しいstream/recorderを初期化する
        initStream()
    }
    const stop = () => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
            stateManager.setState('stopped')
            
            // 録画状態監視をクリア
            if (recordingStateCheckInterval) {
                clearInterval(recordingStateCheckInterval)
                recordingStateCheckInterval = null
            }
            
            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop()
            }
        }
    }
    const reload = async () => {
        // 不完全なtempファイルを取得・削除し結合して保存
        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        // 録画リストを更新
        await loadRecordedMovieList('latest')
    }
    const clear = async () => {
        stateManager.setState('preparing')
        try {
            // 録画状態監視をクリア
            if (recordingStateCheckInterval) {
                clearInterval(recordingStateCheckInterval)
                recordingStateCheckInterval = null
            }
            
            if (mediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.onstop = async () => {
                    await stopRecordingActions(sessionId, stateManager)
                    setTimeout(async () => {
                        await cleanUp(sessionId) // リセット
                        stateManager.setState('stopped')
                    }, 500) // 録画停止後にリセット
                }
                
                if (mediaRecorder && mediaRecorder.state === "recording") {
                    mediaRecorder.stop()
                }
            } else {
                await cleanUp(sessionId) // リセット
                stateManager.setState('stopped')
            }
        }
        catch (error) {
            console.log("リセットに失敗しました:", error)
            stateManager.setState('error')
        }
    }

    const observeVideoResize = () => {
        if (!video) return

        video.addEventListener("resize", () => {
            console.log("video の track 変更を検知しました！", mediaRecorder.state)

            // 停止中は何もしない
            if (mediaRecorder && mediaRecorder instanceof MediaRecorder && mediaRecorder.state === "inactive") {
                return
            }

            // recorder を停止
            if (mediaRecorder && mediaRecorder instanceof MediaRecorder && mediaRecorder.state === "recording") {
                // 状態を準備中に設定
                stateManager.setState('preparing')
                
                if (mediaRecorder && mediaRecorder.state === "recording") {
                    mediaRecorder.stop()

                    // stream を解放
                    if (stream) {
                        stream.getTracks().forEach(track => track.stop())
                    }

                    // 新しいストリームを取得し録画を開始
                    setTimeout(() => {
                        initStream(true) // 明示的に録画開始を指定
                    }, 1000)
                }
            }
        })
    }

    // ページの他のスクリプトが忙しい時期を避けて、アイドル時間に実行
    const executeWhenIdle = (callback: () => void) => {
        if ('requestIdleCallback' in window) {
            requestIdleCallback(callback) // { timeout: 5000 }
        } else {
            // requestIdleCallbackがサポートされていない場合は、少し長めの遅延で代替
            setTimeout(callback, 1000)
        }
    }

    // 設定モーダルを初期化
    const settingsModal = new SettingsModal()

    // UI類を作成
    insertRecordedMovieAria(
        start,
        stop,
        reload,
        clear,
        () => settingsModal.show()
    )
    createModal()
    // fixAudioTrack(video) // ミュート対策

    executeWhenIdle(async () => {
        // 不完全なtempファイルを取得・削除し結合して保存
        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        await new Promise(resolve => setTimeout(resolve, 1000))

        executeWhenIdle(async () => {
            // 録画リストを取得（最新20件のみ）
            await loadRecordedMovieList('latest')

            await new Promise(resolve => setTimeout(resolve, 1000))

            executeWhenIdle(async () => {
                if (autoStart) {
                    initStream(true) // 録画を開始
                } else {
                    stateManager.setState('preparing') // 初期状態を準備中に設定
                    initStream(false) // 動画の準備完了を確認（録画開始なし）
                }

                await new Promise(resolve => setTimeout(resolve, 1000))

                executeWhenIdle(async () => {
                    observeVideoResize() // video の track 変更を監視
                })
            })
        })
    })
}
