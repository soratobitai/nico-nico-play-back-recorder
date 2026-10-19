import { cleanUpOldChunks } from "../../hooks/indexedDB/recordingDB"
import { startResetRecordInterval, startRecordingActions, getRecordingMimeType, isQuotaExceeded, saveTempChunk, holdSegmentLock, mergeChunksBySession, mergeStaleChunks, resetTimeoutCheck, fixAudioTrack, RecordingStateManager, startTimer, stopTimer } from "../../utils/recording"
import { getProgramData } from "../../utils/feature"
import { insertRecordedMovieAria, createModal, loadRecordedMovieList, deleteMovieIcon, insertToggleButton, updateToggleButton, isUICollapsed, setScreenCaptureButton } from "../../utils/ui"
import { RESTART_MEDIARECORDER_INTERVAL_MS, MAX_STORAGE_SIZE, AUTO_START, AUTO_RELOAD_ON_FAILURE, RECORD_WITH_COMMENTS } from '../../utils/storage'
import { createCommentCompositor, type CommentCompositor } from '../../utils/comment-compositor'
import { isScreenCaptureSupported, startScreenCapture, type ScreenCapture } from '../../utils/screen-capture'
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
    let recordWithComments = false

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
        recordWithComments = await RECORD_WITH_COMMENTS.getValue()

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
    RECORD_WITH_COMMENTS.watch((newValue) => {
        recordWithComments = newValue
        // 録画中ならすぐに区間を切り替えて反映する
        // （画面ごと録画中はコメントも入っているので、画面ごと録画をやめた時に反映する）
        if (!screenCapture) switchRecordingStream(createRecordingStream)
    })

    const SAVE_CHUNK_INTERVAL_MS = 3 * 1000
    const { userName, title } = getProgramData() // 番組情報を取得

    const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    let stream = new MediaStream() // 録画する映像（設定によっては流れるコメントを合成したもの、または画面ごと）
    let compositor: CommentCompositor | null = null // コメントを合成している場合はその処理
    let screenCapture: ScreenCapture | null = null // 画面ごと録画している場合はその処理
    let mediaRecorder: MediaRecorder | null = null // 現在の録画区間の recorder

    // 通常の録画の映像を用意する（設定に応じて流れるコメントを合成する）
    const createRecordingStream = (): MediaStream => {
        if (recordWithComments) {
            compositor = createCommentCompositor(video)
            if (compositor) return compositor.stream
        }
        return (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
    }

    // 録画していた映像を解放する（コメントの合成や画面の取り込みも止める）
    const releaseRecordingStream = () => {
        stream.getTracks().forEach(track => track.stop())
        compositor?.stop()
        compositor = null
        if (screenCapture) {
            screenCapture.stop()
            screenCapture = null
            setScreenCaptureButton(false)
        }
    }

    // 録画中なら、録画する映像を next() で作り直して次の区間を始める。録画していなければ何もせず false を返す
    const switchRecordingStream = (next: () => MediaStream): boolean => {
        if (mediaRecorder?.state !== "recording") return false

        mediaRecorder.stop()
        releaseRecordingStream()
        stream = next()
        startNewRecorder()
        return true
    }

    // 画面ごと録画を始める・やめる（録画パネルのボタンから。共有の確認を出すためクリックから呼ぶ必要がある）
    const toggleScreenCapture = async () => {
        if (screenCapture) {
            endScreenCapture()
            return
        }

        let capture: ScreenCapture
        try {
            capture = await startScreenCapture(video.videoHeight, endScreenCapture)
        } catch (error) {
            // 「このタブを共有」でキャンセルされた場合など
            console.log('画面ごと録画を開始できませんでした:', error)
            return
        }

        const useCapture = () => {
            screenCapture = capture
            setScreenCaptureButton(true)
            return capture.stream
        }
        // 録画中なら区間を切り替え、録画していなければ録画を始める
        if (!switchRecordingStream(useCapture)) {
            releaseRecordingStream()
            stream = useCapture()
            startNewRecorder()
        }
    }

    // 画面ごと録画をやめる。録画中なら通常の録画（設定に応じてコメント付き）に戻して続ける
    // （ボタンを押した時と、Chrome の「共有を停止」で取り込みが終わった時）
    const endScreenCapture = () => {
        if (!screenCapture) return
        if (!switchRecordingStream(createRecordingStream)) releaseRecordingStream()
    }



    // 動画の再生を待って録画を開始する
    const initStream = () => {
        if (!video) return

        // mediaRecorder.state のチェックを削除し、代わりに stateManager の状態をチェック
        if (stateManager.getState() === 'recording') return

        // 録画開始前の状態を準備中に設定
        stateManager.setState('preparing')

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
            // 既に録画中の recorder があれば二重に開始しない
            if (mediaRecorder?.state === "recording") return

            // 録画開始処理
            try {
                releaseRecordingStream()
                stream = createRecordingStream()
                startNewRecorder()
            } catch (error) {
                console.log("録画の開始に失敗しました:", error)
                // 録画開始に失敗した場合は状態を停止中に設定
                stateManager.setState('stopped')
                // リロードボタンを押す
                clickReloadButton("録画開始に失敗")
            }
        }

        const waitForVideoReady = (video: HTMLVideoElement, callback: () => void) => {
            const timeoutId = setTimeout(() => {
                // 待っている間に別の方法（画面ごと録画など）で録画が始まっていれば何もしない
                if (mediaRecorder?.state === "recording") return
                // タイムアウトした場合は状態を停止中に設定
                stateManager.setState('stopped')
                clickReloadButton("動画の準備完了待機がタイムアウト")
            }, 3000)

            video.addEventListener("canplay", () => {
                console.log("動画が再生可能になりました。")
                clearTimeout(timeoutId) // タイムアウトをクリア
                setTimeout(() => {
                    if (!video.paused && video.currentTime > 0) {
                        callback()
                    } else if (mediaRecorder?.state !== "recording") {
                        console.log("動画が再生可能になりましたが、まだ再生されていません")
                        // 再生されていない場合は状態を停止中に設定
                        stateManager.setState('stopped')
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
        // 対応している形式がなければブラウザの標準の形式で録画する
        const mimeType = getRecordingMimeType()
        const options = mimeType ? { mimeType } : {}

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
                    await saveTempChunk(segmentId, index, event.data, createdAt, userName, title)
                    // 次の区間に切り替わった後は、そちらの監視を上書きしない
                    if (recorder === mediaRecorder) {
                        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure)
                    }
                })
                .catch((error) => {
                    console.error("チャンクの保存に失敗しました:", error)

                    // 古い録画を消しても容量が足りない場合は、録画を続けても保存されないので止める
                    if (isQuotaExceeded(error) && recorder === mediaRecorder && recorder.state === 'recording') {
                        stopTimer()
                        stateManager.setState('error')
                        recorder.stop()
                        releaseRecordingStream()
                    }
                })
        }

        recorder.onstop = async () => {
            // 停止ボタン・解像度変更では呼び出し側が先に状態を更新し、区間の切り替えでは mediaRecorder が次の recorder に替わっている
            // それ以外（放送終了や recorder が自分で止まった場合）はここで停止状態にする
            if (recorder === mediaRecorder && stateManager.getState() === 'recording') {
                stopTimer()
                stateManager.setState('stopped')
                releaseRecordingStream()
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
        // 停止中もコメントの合成を続けないように解放する（録画開始時に作り直す）
        releaseRecordingStream()
    }
    const reload = async () => {
        // 不完全なtempファイルを取得・削除し結合して保存
        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        // 録画リストを更新
        await loadRecordedMovieList()
    }

    const observeVideoResize = () => {
        if (!video) return

        video.addEventListener("resize", () => {
            console.log("video の track 変更を検知しました！", mediaRecorder?.state)

            // 録画中でなければ何もしない
            if (mediaRecorder?.state !== "recording") return
            // 画面ごと録画は画面を取り込んでいるので、動画の解像度が変わっても録画し直さなくてよい
            // （録画し直すと共有の確認をもう一度出す必要があるが、クリックからでないと出せない）
            if (screenCapture) return

            // 状態を準備中に設定（onstop で停止扱いにさせない）
            stateManager.setState('preparing')
            stopTimer()

            // recorder を停止（結合は onstop で行う）
            mediaRecorder.stop()

            // stream を解放
            releaseRecordingStream()

            // 新しいストリームを取得し録画を開始
            setTimeout(() => {
                initStream()
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
        () => settingsModal.show(),
        isScreenCaptureSupported() ? toggleScreenCapture : null,
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
            await loadRecordedMovieList()
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
                        initStream() // 録画を開始
                    } else {
                        // 動画の準備は録画開始ボタンを押した時に待つので、ここでは待たずに開始できる状態にする
                        // （動画が一時停止中だと準備完了を検知できず、準備中のまま固まっていた）
                        stateManager.setState('stopped')
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
