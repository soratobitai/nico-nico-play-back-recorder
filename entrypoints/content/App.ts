import { saveChunk, cleanUpOldChunks } from "../../hooks/indexedDB/recordingDB"
import { startResetRecordInterval, startRecordingActions, holdSegmentLock, mergeChunksBySession,mergeStaleChunks, resetTimeoutCheck, fixAudioTrack, RecordingStateManager, startTimer, stopTimer } from "../../utils/recording"
import { getProgramData } from "../../utils/feature"
import { insertRecordedMovieAria, createModal, loadRecordedMovieList, deleteMovieIcon, insertToggleButton, updateToggleButton, isUICollapsed } from "../../utils/ui"
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
        if (mediaRecorder?.state !== "recording") return

        console.log("🔄 録画を切り替えます...")

        // 前の区間の結合は onstop で行い、次の区間はすぐに録画を始める（区間の間に空白を作らない）
        mediaRecorder.stop()
        startNewRecorder()

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

    const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    let stream: MediaStream = {} as MediaStream
    let mediaRecorder: MediaRecorder | null = null // 現在の録画区間の recorder



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
                // 既に録画中の recorder があれば二重に開始しない
                if (mediaRecorder?.state === "recording") return

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

    const startNewRecorder = () => {
        const options = {
            // mimeType: 'video/webm; codecs="vp8, opus"'
            mimeType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"'
        }

        let recorder: MediaRecorder
        try {
            recorder = new MediaRecorder(stream, options)
        } catch (error) {
            console.log("MediaRecorderの作成に失敗しました:", error)
            stopTimer()
            stateManager.setState('stopped')
            return
        }
        mediaRecorder = recorder

        // 区間ごとに別の ID で保存し、前の区間の結合と並行して録画できるようにする
        const segmentId = crypto.randomUUID()
        // 結合が終わるまで区間をロックし、他のタブや「録画リスト更新」から途中で結合されないようにする
        const releaseSegmentLock = holdSegmentLock(segmentId)
        let chunkIndex = 0
        // チャンクの保存を直列化し、停止時に最後のチャンクの保存完了を待てるようにする
        let saving: Promise<void> = Promise.resolve()

        // 録画開始イベントでカウンター開始
        recorder.onstart = () => {
            // 開始イベントが届く前に停止・切り替えされていたら何もしない
            if (recorder !== mediaRecorder || recorder.state !== 'recording') return

            startTimer()
            // 録画開始時に状態を録画中に設定
            stateManager.setState('recording')
        }

        // チャンク取得
        recorder.ondataavailable = (event: BlobEvent) => {
            console.log("ondataavailable", event.data.size)
            if (event.data.size <= 0) return

            // チャンクを保存
            const index = chunkIndex++
            const createdAt = Date.now()
            saving = saving
                .then(async () => {
                    await saveChunk('Temps', segmentId, index, event.data, null, createdAt, userName, title)
                    // 次の区間に切り替わった後は、そちらの監視を上書きしない
                    if (recorder === mediaRecorder) {
                        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure)
                    }
                })
                .catch((error) => console.error("チャンクの保存に失敗しました:", error))
        }

        recorder.onstop = async () => {
            // 停止ボタン・解像度変更では呼び出し側が先に状態を更新し、区間の切り替えでは mediaRecorder が次の recorder に替わっている
            // それ以外（放送終了や recorder が自分で止まった場合）はここで停止状態にする
            if (recorder === mediaRecorder && stateManager.getState() === 'recording') {
                stopTimer()
                stateManager.setState('stopped')
            }

            // 最後のチャンクの保存を待ってから結合して保存
            try {
                await saving
                await mergeChunksBySession(segmentId)
            } finally {
                releaseSegmentLock()
            }
        }

        // 録画を開始
        try {
            recorder.start(SAVE_CHUNK_INTERVAL_MS)
            startRecordingActions(
                resetRecording,
                recorder,
                restartInterval,
                SAVE_CHUNK_INTERVAL_MS,
                autoReloadOnFailure,
            )
        } catch (error) {
            console.log("録画の開始に失敗しました:", error)
            releaseSegmentLock()
            stopTimer()
            stateManager.setState('stopped')
        }
    }



    const start = () => {
        // クリア後や新規録画時は必ず新しいstream/recorderを初期化する
        initStream()
    }
    const stop = () => {
        if (mediaRecorder?.state !== "recording") return

        stopTimer()
        stateManager.setState('stopped')
        mediaRecorder.stop()
    }
    const reload = async () => {
        // 不完全なtempファイルを取得・削除し結合して保存
        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        // 録画リストを更新
        await loadRecordedMovieList('latest')
    }

    const observeVideoResize = () => {
        if (!video) return

        video.addEventListener("resize", () => {
            console.log("video の track 変更を検知しました！", mediaRecorder?.state)

            // 録画中でなければ何もしない
            if (mediaRecorder?.state !== "recording") return

            // 状態を準備中に設定（onstop で停止扱いにさせない）
            stateManager.setState('preparing')
            stopTimer()

            // recorder を停止（結合は onstop で行う）
            mediaRecorder.stop()

            // stream を解放
            stream.getTracks().forEach(track => track.stop())

            // 新しいストリームを取得し録画を開始
            setTimeout(() => {
                initStream(true) // 明示的に録画開始を指定
            }, 1000)
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
        () => settingsModal.show()
    )
    createModal()

    // 録画状態の変更を監視してボタンを更新
    stateManager.onChange((state) => {
        updateToggleButton(state === 'recording')
    })

    // 録画リストを読み込む関数
    const loadRecordingListIfNeeded = async () => {
        // UIが開いている時のみ読み込む
        if (!isUICollapsed()) {
            await loadRecordedMovieList('latest')
        }
    }

    // 折りたたみボタンを追加（DOM準備後に実行）
    executeWhenIdle(async () => {
        // UIを開いた時に録画リストを読み込むコールバックを設定
        await insertToggleButton(async () => {
            await loadRecordingListIfNeeded()
        })
        // 初期状態を反映
        updateToggleButton(stateManager.getState() === 'recording')
        
        // 折りたたみボタンの初期化が完了した後、初期読み込みを実行
        executeWhenIdle(async () => {
            // 不完全なtempファイルを取得・削除し結合して保存
            await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

            await new Promise(resolve => setTimeout(resolve, 1000))

            executeWhenIdle(async () => {
                // UIが開いている時のみ録画リストを読み込む
                await loadRecordingListIfNeeded()

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
    })
    // fixAudioTrack(video) // ミュート対策
}
