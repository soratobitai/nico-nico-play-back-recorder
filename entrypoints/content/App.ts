import { saveChunk, cleanUpOldChunks, getStorageUsage } from "../../hooks/indexedDB/recordingDB"
import { startResetRecordInterval, startRecordingActions, stopRecordingActions, mergeStaleChunks, resetTimeoutCheck, fixAudioTrack } from "../../utils/recording"
import { getProgramData } from "../../utils/feature"
import { insertRecordedMovieAria, createModal, confirmModal, loadRecordedMovieList, deleteMovieIcon, setRecordingStatus } from "../../utils/ui"
import { RESTART_MEDIARECORDER_INTERVAL_MS, MAX_STORAGE_SIZE, AUTO_START } from '../../utils/storage'
import { checkLiveStatus } from '../../services/api'

export default async () => {

    // ステータスを確認
    const liveStatus = await checkLiveStatus()
    if (liveStatus !== 'ON_AIR') return
    
    // メッセージハンドラーを追加
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type === 'GET_STORAGE_USAGE') {
            getStorageUsage().then(usage => {
                sendResponse({ usage })
            }).catch(error => {
                console.error('ストレージ使用量の取得に失敗しました:', error)
                sendResponse({ error: error.message })
            })
            return true // 非同期レスポンスを示す
        }
    })

    let restartInterval = 1 * 60 * 1000
    let maxStorageSize = 1 * 1024 * 1024 * 1024
    let autoStart = true

    // 初期設定読み込み
    const loadSettings = async () => {
        restartInterval = await RESTART_MEDIARECORDER_INTERVAL_MS.getValue()
        maxStorageSize = await MAX_STORAGE_SIZE.getValue()
        autoStart = await AUTO_START.getValue()

        startResetRecordInterval(resetRecording, restartInterval)
    }
    loadSettings()

    // 設定変更の反映（RESTART_MEDIARECORDER_INTERVAL_MSとMAX_STORAGE_SIZEのみ監視）
    RESTART_MEDIARECORDER_INTERVAL_MS.watch((newValue) => {
        restartInterval = newValue
        startResetRecordInterval(resetRecording, restartInterval)
    })
    MAX_STORAGE_SIZE.watch((newValue) => {
        maxStorageSize = newValue
    })


    const SAVE_CHUNK_INTERVAL_MS = 3 * 1000
    const { userName, title } = getProgramData() // 番組情報を取得
    const sessionId = crypto.randomUUID()  // タブごとの識別子
    let chunkIndex = 0

    const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    let stream: MediaStream = {} as MediaStream
    let mediaRecorder: MediaRecorder = {} as MediaRecorder

    const initStream = () => {
        if (!video) return
        if (mediaRecorder && mediaRecorder.state === "recording") return

        // ページが忙しい場合は少し待つ
        const executeWhenReady = (callback: () => void) => {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', callback, { once: true })
            } else if (document.readyState === 'interactive') {
                // 少し待ってから実行
                setTimeout(callback, 100)
            } else {
                // 完全に読み込み完了している場合は即座に実行
                callback()
            }
        }

        executeWhenReady(() => {
            try {
                // 動画の準備状態をより厳密にチェック
                if (video.readyState >= 4 && !video.paused && video.currentTime > 0) {
                    console.log("動画が完全に準備完了し、再生中です")
                    // 動画ストリームを取得
                    stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
                    startNewRecorder()
                } else if (video.readyState >= 3) {
                    console.log("動画が準備完了しましたが、再生状態を確認中...")
                    // 少し待ってから再生状態を再確認
                    setTimeout(() => {
                        if (video.readyState >= 4 && !video.paused && video.currentTime > 0) {
                            console.log("動画の再生状態が確認できました")
                            stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
                            startNewRecorder()
                        } else {
                            console.log("動画の準備が完了していないため、待機します...")
                            video.addEventListener("canplay", () => {
                                console.log("動画が再生可能になりました。")
                                // 再生開始を少し待ってからストリームを取得
                                setTimeout(() => {
                                    if (!video.paused && video.currentTime > 0) {
                                        stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
                                        startNewRecorder()
                                    }
                                }, 500)
                            }, { once: true })

                        }
                    }, 1000)
                } else {
                    console.log("動画の準備が完了していないため、待機します...")
                    video.addEventListener("canplay", () => {
                        console.log("動画が再生可能になりました。")
                        // 再生開始を少し待ってからストリームを取得
                        setTimeout(() => {
                            if (!video.paused && video.currentTime > 0) {
                                stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream()
                                startNewRecorder()
                            }
                        }, 500)
                    }, { once: true })
                }
            } catch (error) {
                console.log("録画の開始に失敗しました:", error)
            }
        })
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
            restartInterval,
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
                const deletedKeys = await cleanUpOldChunks('Chunks', maxStorageSize)
                if (deletedKeys.length === 0) return
                console.log(`容量超過分のチャンクを削除しました: ${deletedKeys.length}件`, deletedKeys)

                // UIから削除
                deleteMovieIcon(deletedKeys)

            }, restartInterval / 2)
        }
    }

    const start = () => {
        if (mediaRecorder && mediaRecorder.state === "inactive") {
            setRecordingStatus(false, false, '準備中')
            mediaRecorder.start(SAVE_CHUNK_INTERVAL_MS)
            startRecordingActions(
                resetRecording,
                mediaRecorder,
                restartInterval,
                SAVE_CHUNK_INTERVAL_MS
            )
        } else {
            initStream()
        }
    }
    const stop = () => {
        if (mediaRecorder && mediaRecorder.state === "recording") {
            setRecordingStatus(false, false, '停止中')
            mediaRecorder.stop()
        }
    }
    const reload = async () => {
        // 不完全なtempファイルを取得・削除し結合して保存
        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        // 録画リストを更新
        await loadRecordedMovieList('latest')
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
                                restartInterval,
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
            console.log("video の track 変更を検知しました！", mediaRecorder.state)

            // 停止中は何もしない
            if (mediaRecorder && mediaRecorder instanceof MediaRecorder && mediaRecorder.state === "inactive") {
                return
            }

            // recorder を停止
            if (mediaRecorder && mediaRecorder instanceof MediaRecorder && mediaRecorder.state === "recording") {
                mediaRecorder.stop()

                // stream を解放
                if (stream) {
                    stream.getTracks().forEach(track => track.stop())
                }

                // 新しいストリームを取得し録画を開始
                setTimeout(() => {
                    initStream()
                }, 1000)
            }
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

    // ミュート対策
    fixAudioTrack(video)

    // video の track 変更を監視
    observeVideoResize()

    // 不完全なtempファイルを取得・削除し結合して保存
    await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

    // ページの他のスクリプトが忙しい時期を避けて、アイドル時間に実行
    const executeWhenIdle = (callback: () => void) => {
        if ('requestIdleCallback' in window) {
            requestIdleCallback(callback, { timeout: 5000 })
        } else {
            // requestIdleCallbackがサポートされていない場合は、少し長めの遅延で代替
            setTimeout(callback, 1000)
        }
    }

    executeWhenIdle(async () => {

        // 録画を開始
        if (autoStart) {
            // 録画開始もアイドル時間に実行
            executeWhenIdle(async () => {
                initStream()

                // 2秒待つ
                await new Promise(resolve => setTimeout(resolve, 2000))

                // 録画リストを初期化（最新20件のみ）
                await loadRecordedMovieList('latest')
            })
        } else {
            setRecordingStatus(true, false, '停止中')
        }
    })
}
