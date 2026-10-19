import { enforceLimit, flushPending, migrateLegacy, closeStaleSegments } from "../../utils/library/api"
import { getRecordingMimeType, segmentFormatOf, resetTimeoutCheck, RecordingStateManager, startTimer, stopTimer } from "../../utils/recording"
import { getProgramData, captureThumbnail } from "../../utils/feature"
import { insertRecordedMovieAria, insertRecordedMovie, createModal, loadRecordedMovieList, removeSegmentItems, updateRecordingCount, insertToggleButton, updateToggleButton, isUICollapsed, setScreenCaptureButton, setReviewButton, setRecordingKinds } from "../../utils/ui"
import { MAX_STORAGE_SIZE, AUTO_START, AUTO_RELOAD_ON_FAILURE, RECORD_VIDEO, RECORD_WITH_COMMENTS, RESOLUTION_MODE, FIXED_RESOLUTION_HEIGHT, type ResolutionMode } from '../../utils/storage'
import { createVideoCapture, createVideoSource, createCommentSource, type RecordingSource } from '../../utils/recording-source'
import { createKindRecorder, type KindRecorder } from '../../utils/kind-recorder'
import { isScreenCaptureSupported, startScreenCapture } from '../../utils/screen-capture'
import { checkLiveStatus } from '../../services/api'
import { isReviewSupported, isReviewOpen, toggleReviewWindow } from '../../utils/review/window'
import type { RecordingKind } from '../../utils/library/db'
import SettingsModal from './settings-modal'
import './settings-modal.css'

// 録画状態の一元管理クラス

const stateManager = new RecordingStateManager()

// 録画を区切る間隔（内部の区切り。見直しではつながって再生される）
const SEGMENT_INTERVAL_MS = 5 * 60 * 1000
// データを受け取って保存する間隔
const SAVE_CHUNK_INTERVAL_MS = 3 * 1000
// 容量の上限を超えた分を消す間隔
const ENFORCE_LIMIT_INTERVAL_MS = 60 * 1000
// 録画中の区間はこれより短い間隔で書き込まれる（止まれば録画し直す）ので、これだけ書き込みのない区間は録画を終えている
const STALE_SEGMENT_IDLE_MS = 5 * 60 * 1000
// 動画の解像度が変わってから録り直すまでの時間（続けて変わる間は待つ）
const RESTART_DELAY_MS = 1000
// 止まっていないかを見張る種類の優先順（録画している種類のうち1つを見張る）
const WATCH_ORDER: RecordingKind[] = ['video', 'comments', 'screen']
// 動画から作る種類（動画の解像度が変わると録り直す）
const VIDEO_KINDS = ['video', 'comments'] as const
type VideoKind = typeof VIDEO_KINDS[number]

export default async () => {

    // ステータスを確認
    const liveStatus = await checkLiveStatus()
    if (liveStatus !== 'ON_AIR') return

    let maxStorageSize = 1 * 1024 * 1024 * 1024
    let autoStart = true
    let autoReloadOnFailure = false
    let recordVideo = true
    let recordWithComments = false
    let resolutionMode: ResolutionMode = 'split'
    let fixedResolutionHeight = 720

    // 初期設定読み込み
    ;[maxStorageSize, autoStart, autoReloadOnFailure, recordVideo, recordWithComments, resolutionMode, fixedResolutionHeight] = await Promise.all([
        MAX_STORAGE_SIZE.getValue(),
        AUTO_START.getValue(),
        AUTO_RELOAD_ON_FAILURE.getValue(),
        RECORD_VIDEO.getValue(),
        RECORD_WITH_COMMENTS.getValue(),
        RESOLUTION_MODE.getValue(),
        FIXED_RESOLUTION_HEIGHT.getValue(),
    ])

    const { userName, title } = getProgramData() // 番組情報を取得
    const programId = location.pathname.match(/lv\d+/)?.[0] ?? location.pathname
    const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    // 動画の取り込み（動画のみ・コメント付きで共有する）
    const videoCapture = createVideoCapture(video)

    // ---- 種類ごとの録画 ----

    const recorders = new Map<RecordingKind, KindRecorder>() // 録画中の種類
    const restartPending = new Set<VideoKind>() // 解像度が変わって、録り直しを待っている種類
    let sessionActive = false // 録画中（停止するまで。録り直しを待っている間も含む）
    let splitTimer: ReturnType<typeof setInterval> | undefined
    let limitTimer: ReturnType<typeof setInterval> | undefined
    let restartTimer: ReturnType<typeof setTimeout> | undefined

    // 一定の解像度で録る場合の高さ
    const fixedHeight = () => resolutionMode === 'fixed' ? fixedResolutionHeight : null

    // 設定で選んだ、動画から作る種類（少なくとも1つ。両方 OFF にはできないが、念のため動画のみを録る）
    const enabledKinds = (): VideoKind[] => {
        const kinds = VIDEO_KINDS.filter(kind => kind === 'video' ? recordVideo : recordWithComments)
        return kinds.length > 0 ? kinds : ['video']
    }

    const createSourceFor = (kind: VideoKind): RecordingSource => {
        if (kind === 'video') return createVideoSource(videoCapture, fixedHeight())
        const source = createCommentSource(videoCapture, video, fixedHeight())
        if (!source) throw new Error('この環境ではコメント付きで録画できません')
        return source
    }

    const updateKindsDisplay = () => setRecordingKinds(WATCH_ORDER.filter(kind => recorders.has(kind)))

    const startKind = (kind: RecordingKind, createSource: () => RecordingSource): boolean => {
        if (recorders.has(kind)) return true
        const recorder: KindRecorder = createKindRecorder({
            kind,
            createSource,
            chunkIntervalMs: SAVE_CHUNK_INTERVAL_MS,
            segmentDetails: () => ({ programId, title, userName, thumbnail: captureThumbnail(video) }),
            onStarted: () => {
                if (!sessionActive || stateManager.getState() === 'recording') return
                startTimer()
                stateManager.setState('recording')
            },
            onData: (mediaRecorder) => {
                // 録画している種類のうち1つだけを見張る（データが届かなくなったらライブが続いているか確かめる）
                const watched = WATCH_ORDER.map(k => recorders.get(k)).find(Boolean)
                if (watched !== recorder) return
                resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure, 0, () => stopSession('stopped'))
            },
            onSegmentFinished: (segment) => {
                insertRecordedMovie(segment, 'end')
                updateRecordingCount()
            },
            // 古い録画を消しても容量が足りない場合は、録画を続けても保存されないので止める
            onSaveFailed: () => stopSession('error'),
            onEnded: () => {
                if (recorders.get(kind) !== recorder) return
                recorders.delete(kind)
                afterKindStopped(kind)
            },
        })
        try {
            recorder.start()
        } catch (error) {
            console.log(`録画（${kind}）を開始できませんでした:`, error)
            return false
        }
        recorders.set(kind, recorder)
        updateKindsDisplay()
        return true
    }

    const stopKind = (kind: RecordingKind) => {
        const recorder = recorders.get(kind)
        if (!recorder) return
        recorders.delete(kind)
        recorder.stop()
        afterKindStopped(kind)
    }

    // 種類の録画が止まった後。録画している種類がなくなったら停止する
    const afterKindStopped = (kind: RecordingKind) => {
        if (kind === 'screen') setScreenCaptureButton(false)
        updateKindsDisplay()
        if (sessionActive && recorders.size === 0 && restartPending.size === 0) stopSession('stopped')
    }

    const startEnabledKinds = () => {
        for (const kind of enabledKinds()) startKind(kind, () => createSourceFor(kind))
    }

    // 容量の上限を超えた分を、古い断片から削除する
    const enforceStorageLimit = async () => {
        try {
            const { freed, deletedSegmentIds } = await enforceLimit(maxStorageSize)
            if (freed === 0) return
            console.log(`容量超過分を削除しました: ${freed} バイト（区間ごと消えたもの ${deletedSegmentIds.length}件）`)
            removeSegmentItems(deletedSegmentIds)
        } catch (error) {
            console.log("容量超過分を削除できませんでした:", error)
        }
    }

    const beginSession = () => {
        if (sessionActive) return
        sessionActive = true
        // 一定の間隔で、すべての種類の区間を区切る（区間の間に空白を作らないよう、すぐに次の区間を録り始める）
        splitTimer = setInterval(() => {
            console.log("🔄 録画を区切ります...")
            for (const recorder of recorders.values()) recorder.split()
        }, SEGMENT_INTERVAL_MS)
        limitTimer = setInterval(enforceStorageLimit, ENFORCE_LIMIT_INTERVAL_MS)
    }

    // すべての種類の録画を止める
    const stopSession = (state: 'stopped' | 'error' = 'stopped') => {
        sessionActive = false
        clearInterval(splitTimer)
        clearInterval(limitTimer)
        clearTimeout(restartTimer)
        restartPending.clear()
        for (const kind of [...recorders.keys()]) stopKind(kind)
        stopTimer()
        stateManager.setState(state)
    }

    // 動画から作る種類を、少し待ってから録り直す（解像度が変わった時や、設定を変えた時）
    const scheduleRestart = (kinds: VideoKind[]) => {
        for (const kind of kinds) {
            restartPending.add(kind)
            stopKind(kind)
        }
        clearTimeout(restartTimer)
        restartTimer = setTimeout(() => {
            const pending = [...restartPending]
            restartPending.clear()
            if (!sessionActive) return
            for (const kind of pending) {
                if (enabledKinds().includes(kind)) startKind(kind, () => createSourceFor(kind))
            }
            if (recorders.size === 0) stopSession('stopped')
        }, RESTART_DELAY_MS)
    }

    // 録画中の、動画から作る種類をすべて録り直す（設定の変更を反映する）
    const restartVideoKinds = () => {
        if (!sessionActive) return
        const kinds = VIDEO_KINDS.filter(kind => recorders.has(kind))
        if (kinds.length > 0) scheduleRestart(kinds)
    }

    // 設定で選んだ種類に合わせて、録画中の種類を始める・止める
    const applyKinds = () => {
        if (!sessionActive) return
        for (const kind of VIDEO_KINDS) {
            if (enabledKinds().includes(kind)) {
                if (!restartPending.has(kind)) startKind(kind, () => createSourceFor(kind))
            } else {
                restartPending.delete(kind)
                stopKind(kind)
            }
        }
    }

    // 設定変更の反映
    MAX_STORAGE_SIZE.watch((newValue) => {
        maxStorageSize = newValue
    })
    AUTO_RELOAD_ON_FAILURE.watch((newValue) => {
        autoReloadOnFailure = newValue
    })
    // 録画中に種類を変えた場合は、その場で始める・止める
    RECORD_VIDEO.watch((newValue) => {
        recordVideo = newValue
        applyKinds()
    })
    RECORD_WITH_COMMENTS.watch((newValue) => {
        recordWithComments = newValue
        applyKinds()
    })
    // 録画中に解像度の設定を変えた場合は、録り直して反映する
    RESOLUTION_MODE.watch((newValue) => {
        resolutionMode = newValue
        restartVideoKinds()
    })
    FIXED_RESOLUTION_HEIGHT.watch((newValue) => {
        fixedResolutionHeight = newValue
        if (resolutionMode === 'fixed') restartVideoKinds()
    })

    // 画面ごと録画を始める・やめる（録画パネルのボタンから。共有の確認を出すためクリックから呼ぶ必要がある）
    // 他の種類と並行して録る。停止中に押した場合は、設定で選んだ種類も一緒に録り始める
    const toggleScreenCapture = async () => {
        if (recorders.has('screen')) {
            stopKind('screen')
            return
        }

        let source: RecordingSource
        try {
            // Chrome の「共有を停止」で取り込みが終わったら、画面の録画だけやめる
            const capture = await startScreenCapture(fixedHeight() ?? video.videoHeight, () => stopKind('screen'))
            source = { stream: capture.stream, fixedSize: true, stop: capture.stop }
        } catch (error) {
            // 「このタブを共有」でキャンセルされた場合など
            console.log('画面ごと録画を開始できませんでした:', error)
            return
        }

        const wasActive = sessionActive
        beginSession()
        if (!wasActive) startEnabledKinds()
        if (startKind('screen', () => source)) {
            setScreenCaptureButton(true)
        } else {
            source.stop()
            if (recorders.size === 0) stopSession('stopped')
        }
    }

    // 動画の再生を待って録画を開始する
    const initStream = () => {
        if (!video) return

        if (sessionActive) return

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

        const startRecordingFromStream = () => {
            // 既に録画中なら二重に開始しない（待っている間に画面ごと録画で始まった場合など）
            if (sessionActive) return

            beginSession()
            startEnabledKinds()
            if (recorders.size === 0) {
                // 録画開始に失敗した場合は状態を停止中に設定
                stopSession('stopped')
                clickReloadButton("録画開始に失敗")
            }
        }

        const waitForVideoReady = (video: HTMLVideoElement, callback: () => void) => {
            const timeoutId = setTimeout(() => {
                // 待っている間に別の方法（画面ごと録画など）で録画が始まっていれば何もしない
                if (sessionActive) return
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
                    } else if (!sessionActive) {
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
                startRecordingFromStream()
            } else if (isVideoPrepared(video)) {
                console.log("動画が準備完了しましたが、再生状態を確認中...")
                setTimeout(() => {
                    if (isVideoReady(video)) {
                        console.log("動画の再生状態が確認できました")
                        startRecordingFromStream()
                    } else {
                        console.log("動画の準備が完了していないため、待機します...")
                        waitForVideoReady(video, startRecordingFromStream)
                    }
                }, 1000)
            } else {
                console.log("動画の準備が完了していないため、待機します...")
                waitForVideoReady(video, startRecordingFromStream)
            }
        }

        // 実行開始
        executeWhenReady(handleVideoInitialization)
    }

    const start = () => {
        initStream()
    }
    const stop = () => {
        if (!sessionActive) return
        stopSession('stopped')
    }
    const reload = async () => {
        // 一時保存した録画があれば、拡張機能側へ移す
        await flushPending().catch((error) => console.log("一時保存した録画を移せませんでした:", error))

        // 録画リストを更新
        await loadRecordedMovieList()
    }

    // 動画の解像度が変わったら、元の解像度のまま録る種類は録画を分けて録り直す
    // （一定の解像度で録る種類と画面ごとの録画は、そのまま録り続ける）
    const observeVideoResize = () => {
        if (!video) return

        video.addEventListener("resize", () => {
            if (!sessionActive) return
            const kinds = VIDEO_KINDS.filter(kind => recorders.get(kind) && !recorders.get(kind)!.fixedSize)
            console.log("動画の解像度が変わりました", `${video.videoWidth}x${video.videoHeight}`, kinds)
            if (kinds.length > 0 || restartPending.size > 0) scheduleRestart(kinds)
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

    // 見直しのウィンドウを開く・閉じる（録画は止めない）
    const toggleReview = () => {
        toggleReviewWindow({ programId, title, onClose: () => setReviewButton(false) })
            .then(() => setReviewButton(isReviewOpen()))
            .catch((error) => console.log("見直しのウィンドウを開けませんでした:", error))
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
        // 見直しは mp4 の録画だけ（webm でしか録画できない環境では使えない）
        isReviewSupported() && segmentFormatOf(getRecordingMimeType() ?? '') === 'fmp4' ? toggleReview : null,
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
            // 拡張機能が更新された直後などに一時保存した録画を、拡張機能側へ移す
            await flushPending().catch((error) => console.log("一時保存した録画を移せませんでした:", error))
            // 録画中にタブが閉じられるなどして、終えられないまま残った録画を確定する
            await closeStaleSegments(STALE_SEGMENT_IDLE_MS).catch((error) => console.log("残っていた録画を確定できませんでした:", error))

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

                        // 以前のバージョンの録画を拡張機能側へ移す（時間がかかることがあるので、録画を始めてから）
                        migrateLegacy()
                            .then((count) => { if (count > 0) return loadRecordingListIfNeeded() })
                            .catch((error) => console.log("以前の録画を移せませんでした:", error))
                    })
                })
            })
        })
    })
    // fixAudioTrack(video) // ミュート対策（utils/recording.ts）
}
