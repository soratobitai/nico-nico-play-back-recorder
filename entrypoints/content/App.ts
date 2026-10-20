import { enforceLimit, flushPending, migrateLegacy, closeStaleSegments, setPendingLimit } from "../../utils/library/api"
import { getRecordingMimeType, segmentFormatOf, resetTimeoutCheck, RecordingStateManager, startTimer, stopTimer } from "../../utils/recording"
import { getProgramData, captureThumbnail } from "../../utils/feature"
import { insertRecorderBar, insertToggleButton, updateToggleButton, setScreenCaptureButton, setPlaybackButton, setKindChips, showBarHint } from "../../utils/ui"
import { MAX_STORAGE_SIZE, AUTO_START, AUTO_RELOAD_ON_FAILURE, RECORD_VIDEO, RECORD_WITH_COMMENTS, RECORD_SCREEN, RESOLUTION_MODE, FIXED_RESOLUTION_HEIGHT, type ResolutionMode } from '../../utils/storage'
import { createVideoCapture, createVideoSource, createCommentSource, type RecordingSource } from '../../utils/recording-source'
import { createKindRecorder, type KindRecorder } from '../../utils/kind-recorder'
import { isScreenCaptureSupported, startScreenCapture } from '../../utils/screen-capture'
import { checkLiveStatus } from '../../services/api'
import { isPlaybackSupported, isPlaybackOpen, togglePlaybackWindow } from '../../utils/review/window'
import { requestOpenLibrary } from '../../utils/library/open-library'
import type { RecordingKind } from '../../utils/library/db'
import SettingsModal from './settings-modal'
import './settings-modal.css'

// 録画状態の一元管理クラス

const stateManager = new RecordingStateManager()

// 録画を区切る間隔（内部の区切り。プレイバックと録画一覧ではつながって再生される）
const SEGMENT_INTERVAL_MS = 5 * 60 * 1000
// データを受け取って保存する間隔
const SAVE_CHUNK_INTERVAL_MS = 3 * 1000
// 容量の上限を超えた分を消す間隔
const ENFORCE_LIMIT_INTERVAL_MS = 60 * 1000
// 録画中の区間はこれより短い間隔で書き込まれる（止まれば録画し直す）ので、これだけ書き込みのない区間は録画を終えている
const STALE_SEGMENT_IDLE_MS = 5 * 60 * 1000
// 動画の解像度が変わってから録り直すまでの時間（続けて変わる間は待つ）
const RESTART_DELAY_MS = 1000
// 録り始めてからこれ以内に解像度が変わったら、それまでの区間は残さない
// （ニコ生は番組を開いた直後の画質が低く、すぐに上がる。数秒だけの低い画質の区間が、録画一覧やまとめて保存で別に分かれないように）
const EARLY_RESIZE_MS = 10 * 1000
// 複数の種類を区切る・録り直す時に、種類ごとにずらす時間
// （同時に録り始めると、ハードウェアのエンコーダーをどの種類が使うかが入れ替わり、同じ種類の前の区間と
//   映像の設定が変わって、つないで保存できなくなる。ずらせば、どの種類も前と同じエンコーダーを使う）
const KIND_STAGGER_MS = 500
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
    let recordScreen = false // 演出あり（ページを開くたびに、録画バーのチップで始める）
    let resolutionMode: ResolutionMode = 'split'
    let fixedResolutionHeight = 720

    // 初期設定読み込み
    ;[maxStorageSize, autoStart, autoReloadOnFailure, recordVideo, recordWithComments, recordScreen, resolutionMode, fixedResolutionHeight] = await Promise.all([
        MAX_STORAGE_SIZE.getValue(),
        AUTO_START.getValue(),
        AUTO_RELOAD_ON_FAILURE.getValue(),
        RECORD_VIDEO.getValue(),
        RECORD_WITH_COMMENTS.getValue(),
        RECORD_SCREEN.getValue(),
        RESOLUTION_MODE.getValue(),
        FIXED_RESOLUTION_HEIGHT.getValue(),
    ])

    const { userName, title } = getProgramData() // 番組情報を取得
    const programId = location.pathname.match(/lv\d+/)?.[0] ?? location.pathname
    const video: HTMLVideoElement = document.querySelector("video") as HTMLVideoElement
    // 動画の取り込み（コメントなし・コメントありで共有する）
    const videoCapture = createVideoCapture(video)

    // ---- 種類ごとの録画 ----

    const recorders = new Map<RecordingKind, KindRecorder>() // 録画中の種類
    const restartPending = new Set<VideoKind>() // 解像度が変わって、録り直しを待っている種類
    let sessionActive = false // 録画中（停止するまで。録り直しを待っている間も含む）
    let sessionId = 0 // 録画を始めるたびに変わる（止めた後に、前の録画のためにずらした処理を行わない）
    let splitTimer: ReturnType<typeof setInterval> | undefined
    let limitTimer: ReturnType<typeof setInterval> | undefined
    let restartTimer: ReturnType<typeof setTimeout> | undefined
    let cancelRestarts: (() => VideoKind[]) | undefined // 順番待ちの録り直しを取り消す
    const discardPending = new Set<VideoKind>() // 録り直す時に、それまでの区間を残さない種類
    let sessionStartedAt = 0 // 録画を始めた時刻

    // 一定の解像度で録る場合の高さ
    const fixedHeight = () => resolutionMode === 'fixed' ? fixedResolutionHeight : null

    // 設定で選んだ、動画から作る種類（少なくとも1つ。両方 OFF にはできないが、念のためコメントなしを録る）
    const enabledKinds = (): VideoKind[] => {
        const kinds = VIDEO_KINDS.filter(kind => kind === 'video' ? recordVideo : recordWithComments)
        return kinds.length > 0 ? kinds : ['video']
    }

    const createSourceFor = (kind: VideoKind): RecordingSource => {
        if (kind === 'video') return createVideoSource(videoCapture, video, fixedHeight())
        const source = createCommentSource(videoCapture, video, fixedHeight())
        if (!source) throw new Error('この環境ではコメントありで録画できません')
        return source
    }

    const startKind = (kind: RecordingKind, createSource: () => RecordingSource): boolean => {
        if (recorders.has(kind)) return true
        // 録画している種類のうち1つだけを見張る（データが届かなくなったらライブが続いているか確かめる）
        // 区間を録り始めた時にも見張り始める（新しい区間のデータが一度も届かない場合にも気づけるように）
        const watch = (mediaRecorder: MediaRecorder) => {
            const watched = WATCH_ORDER.map(k => recorders.get(k)).find(Boolean)
            if (watched !== recorder) return
            resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure, 0, () => stopSession('stopped'))
        }
        const recorder: KindRecorder = createKindRecorder({
            kind,
            createSource,
            chunkIntervalMs: SAVE_CHUNK_INTERVAL_MS,
            segmentDetails: () => ({ programId, title, userName, thumbnail: captureThumbnail(video) }),
            onStarted: (mediaRecorder) => {
                watch(mediaRecorder)
                if (!sessionActive || stateManager.getState() === 'recording') return
                startTimer()
                stateManager.setState('recording')
            },
            onData: watch,
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
        // 順番待ちの区切り・録り直しは、これより KIND_STAGGER_MS 以上あとに行う
        nextStartAt = Math.max(nextStartAt, Date.now() + KIND_STAGGER_MS)
        recorders.set(kind, recorder)
        return true
    }

    // discard: 今の区間は残さずに消す
    const stopKind = (kind: RecordingKind, discard = false) => {
        const recorder = recorders.get(kind)
        if (!recorder) return
        recorders.delete(kind)
        if (discard) recorder.discard()
        else recorder.stop()
        afterKindStopped(kind)
    }

    // 種類の録画が止まった後。録画している種類がなくなったら停止する
    const afterKindStopped = (kind: RecordingKind) => {
        if (kind === 'screen') refreshScreenChip()
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
        } catch (error) {
            console.log("容量超過分を削除できませんでした:", error)
        }
    }

    // 録画を始める操作（区切る・録り直す）の順番待ち。どの操作も、前の操作から KIND_STAGGER_MS 以上あけて行う
    // （区切りと録り直しが重なっても、エンコーダーの準備が重ならないように）。何ミリ秒後に行うかを返す
    let nextStartAt = 0
    const reserveStart = () => {
        const now = Date.now()
        const at = Math.max(now, nextStartAt)
        nextStartAt = at + KIND_STAGGER_MS
        return at - now
    }

    // 種類ごとに、順番待ちに入れて action を行い、最後に done を呼ぶ（録画を止めたら、残りは行わない）
    // 返す関数で、まだ行っていない種類を取り消せる（取り消した種類を返す）
    const staggered = <K extends RecordingKind>(kinds: K[], action: (kind: K) => void, done?: () => void) => {
        const id = sessionId
        const waiting = new Map<K, ReturnType<typeof setTimeout>>()
        if (kinds.length === 0) done?.()
        for (const kind of kinds) {
            waiting.set(kind, setTimeout(() => {
                waiting.delete(kind)
                if (!sessionActive || sessionId !== id) return
                action(kind)
                if (waiting.size === 0) done?.()
            }, reserveStart()))
        }
        return (): K[] => {
            for (const timer of waiting.values()) clearTimeout(timer)
            const cancelled = [...waiting.keys()]
            waiting.clear()
            return cancelled
        }
    }

    const beginSession = () => {
        if (sessionActive) return
        sessionActive = true
        sessionId++
        sessionStartedAt = Date.now()
        // 一定の間隔で、すべての種類の区間を区切る（区間の間に空白を作らないよう、すぐに次の区間を録り始める）
        splitTimer = setInterval(() => {
            console.log("🔄 録画を区切ります...")
            staggered(WATCH_ORDER.filter(kind => recorders.has(kind)), kind => recorders.get(kind)?.split())
        }, SEGMENT_INTERVAL_MS)
        limitTimer = setInterval(enforceStorageLimit, ENFORCE_LIMIT_INTERVAL_MS)
    }

    // すべての種類の録画を止める
    const stopSession = (state: 'stopped' | 'error' = 'stopped') => {
        sessionActive = false
        clearInterval(splitTimer)
        clearInterval(limitTimer)
        clearTimeout(restartTimer)
        cancelRestarts?.()
        cancelRestarts = undefined
        restartPending.clear()
        discardPending.clear()
        for (const kind of [...recorders.keys()]) stopKind(kind)
        stopTimer()
        stateManager.setState(state)
    }

    // 動画から作る種類を、少し待ってから録り直す（解像度が変わった時や、設定を変えた時）
    // 映像の大きさが変わらないように描き直している種類は、録り直すまで録り続ける（録画の間を空けない）。
    // 描き直せない種類は、大きさが変わった所から再生できなくなるので、すぐに止める
    // discardEarly: 録り直す前の区間は残さない（録り始めてすぐに解像度が変わった時）
    const scheduleRestart = (kinds: VideoKind[], { discardEarly = false } = {}) => {
        // 前の録り直しで、まだ順番待ちの種類は、今回まとめて録り直す（同じ種類を続けて2回録り直さない）
        for (const kind of cancelRestarts?.() ?? []) restartPending.add(kind)
        cancelRestarts = undefined
        for (const kind of kinds) {
            restartPending.add(kind)
            if (discardEarly) discardPending.add(kind)
            if (!recorders.get(kind)?.steadySize) {
                stopKind(kind, discardPending.has(kind))
                discardPending.delete(kind)
            }
        }
        clearTimeout(restartTimer)
        restartTimer = setTimeout(() => {
            const pending = VIDEO_KINDS.filter(kind => restartPending.has(kind))
            restartPending.clear()
            if (!sessionActive) return
            cancelRestarts = staggered(pending, (kind) => {
                const previous = recorders.get(kind)
                if (previous) {
                    recorders.delete(kind)
                    if (discardPending.has(kind)) previous.discard()
                    else previous.stop()
                }
                discardPending.delete(kind)
                if (enabledKinds().includes(kind)) startKind(kind, () => createSourceFor(kind))
            }, () => {
                if (recorders.size === 0) stopSession('stopped')
            })
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
                discardPending.delete(kind)
                stopKind(kind)
            }
        }
    }

    // 拡張機能側に保存できない間に一時保存する量の上限（拡張機能が更新された後も録画を続けるので）
    setPendingLimit(maxStorageSize)

    // 設定変更の反映
    MAX_STORAGE_SIZE.watch((newValue) => {
        maxStorageSize = newValue
        setPendingLimit(newValue)
    })
    AUTO_RELOAD_ON_FAILURE.watch((newValue) => {
        autoReloadOnFailure = newValue
    })
    // 録画中に種類を変えた場合は、その場で始める・止める
    RECORD_VIDEO.watch((newValue) => {
        recordVideo = newValue
        setKindChips({ video: recordVideo, comments: recordWithComments })
        applyKinds()
    })
    RECORD_WITH_COMMENTS.watch((newValue) => {
        recordWithComments = newValue
        setKindChips({ video: recordVideo, comments: recordWithComments })
        applyKinds()
    })

    // 録画バーのチップで、録る種類を切り替える（少なくとも1つは録る）
    const toggleKind = (kind: VideoKind) => {
        const next = { video: recordVideo, comments: recordWithComments }
        next[kind] = !next[kind]
        if (!next.video && !next.comments) {
            showBarHint('少なくとも1つは録画します')
            return
        }
        setKindChips(next)
        if (kind === 'video') void RECORD_VIDEO.setValue(next.video)
        else void RECORD_WITH_COMMENTS.setValue(next.comments)
    }
    // 録画中に解像度の設定を変えた場合は、録り直して反映する
    RESOLUTION_MODE.watch((newValue) => {
        resolutionMode = newValue
        restartVideoKinds()
    })
    FIXED_RESOLUTION_HEIGHT.watch((newValue) => {
        fixedResolutionHeight = newValue
        if (resolutionMode === 'fixed') restartVideoKinds()
    })

    // ---- 演出あり（プレイヤーの画面ごとの録画） ----
    // 「このタブを共有」の確認を出すので、クリックの処理から始める必要がある（自動では始められない）。
    // 設定で「演出あり」を選んでいる間は、まだ始めていなければ録画バーのチップを光らせて促す

    // 録画バーのチップの表示を合わせる
    const refreshScreenChip = () => {
        setScreenCaptureButton(recorders.has('screen') ? 'on' : recordScreen ? 'ready' : 'off')
    }

    // 演出ありの録画を始める（他の種類と並行して録る。停止中なら、設定で選んだ種類も一緒に録り始める）
    // 始められたら true（共有の確認でキャンセルされた場合などは false）
    let screenStarting = false // 共有の確認を出している間（続けて押されても、2つ目の取り込みを始めない）
    const startScreen = async (): Promise<boolean> => {
        if (recorders.has('screen')) return true
        if (screenStarting) return false

        let source: RecordingSource
        screenStarting = true
        try {
            // Chrome の「共有を停止」で取り込みが終わったら、演出ありの録画をやめる（設定もやめたことにする）
            const capture = await startScreenCapture(fixedHeight() ?? video.videoHeight, () => {
                stopKind('screen')
                void RECORD_SCREEN.setValue(false)
            })
            source = { stream: capture.stream, fixedSize: true, steadySize: true, stop: capture.stop }
        } catch (error) {
            // 「このタブを共有」でキャンセルされた場合など
            console.log('演出ありの録画を開始できませんでした:', error)
            return false
        } finally {
            screenStarting = false
        }

        const wasActive = sessionActive
        beginSession()
        if (!wasActive) startEnabledKinds()
        const started = startKind('screen', () => source)
        if (!started) {
            source.stop()
            if (recorders.size === 0) stopSession('stopped')
        }
        refreshScreenChip()
        return started
    }

    // 録画バーのチップ（設定の「演出あり」のショートカット）。録っていれば止めて、設定もやめる。
    // 録っていなければ始め、始められたら設定も「演出あり」にする
    const toggleScreenCapture = async () => {
        if (recorders.has('screen')) {
            stopKind('screen')
            void RECORD_SCREEN.setValue(false)
            return
        }
        if (await startScreen()) void RECORD_SCREEN.setValue(true)
    }

    // 他のタブや設定画面で「演出あり」を変えた時（やめたら、このページの演出ありの録画もやめる）
    RECORD_SCREEN.watch((newValue) => {
        recordScreen = newValue
        if (!newValue) stopKind('screen')
        refreshScreenChip()
    })

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
            // 既に録画中なら二重に開始しない（待っている間に演出ありの録画で始まった場合など）
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
                // 待っている間に別の方法（演出ありの録画など）で録画が始まっていれば何もしない
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
    // 動画の解像度が変わったら、元の解像度のまま録る種類は録画を分けて録り直す
    // （一定の解像度で録る種類と画面ごとの録画は、そのまま録り続ける）
    const observeVideoResize = () => {
        if (!video) return

        video.addEventListener("resize", () => {
            if (!sessionActive) return
            const kinds = VIDEO_KINDS.filter(kind => recorders.get(kind) && !recorders.get(kind)!.fixedSize)
            console.log("動画の解像度が変わりました", `${video.videoWidth}x${video.videoHeight}`, kinds)
            // 録り始めてすぐなら、それまでの数秒の区間は残さない
            const discardEarly = Date.now() - sessionStartedAt <= EARLY_RESIZE_MS
            if (kinds.length > 0 || restartPending.size > 0) scheduleRestart(kinds, { discardEarly })
        })

        // 動画が読み込み直された（プレイヤーの再読み込みなど）。今の録画のトラックにはコマが届かなくなる
        // （トラックは終わらないまま残る）ので、一定の解像度で録っている種類も含めて、新しいトラックで録り直す。
        // 読み込み直した動画の映像が届いてから録り直す（新しいトラックは、その頃に加わる）
        let reloaded = false
        video.addEventListener("emptied", () => {
            reloaded = true
        })
        video.addEventListener("loadeddata", () => {
            if (!reloaded) return
            reloaded = false
            if (!sessionActive) return
            const kinds = VIDEO_KINDS.filter(kind => recorders.has(kind) || restartPending.has(kind))
            console.log("動画が読み込み直されました", kinds)
            if (kinds.length > 0) scheduleRestart(kinds)
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

    // プレイバックのウィンドウを開く・閉じる（録画は止めない）
    const togglePlayback = () => {
        togglePlaybackWindow({ programId, title, onClose: () => setPlaybackButton(false) })
            .then(() => setPlaybackButton(isPlaybackOpen()))
            .catch((error) => console.log("プレイバックのウィンドウを開けませんでした:", error))
    }

    // 設定モーダルを初期化
    const settingsModal = new SettingsModal({
        // 設定画面の「演出あり」をオンにした時に、このページでもすぐ始める
        screen: isScreenCaptureSupported()
            ? { isRecording: () => recorders.has('screen'), start: startScreen, stop: () => stopKind('screen') }
            : null,
    })

    // 録画バーを作る
    insertRecorderBar({
        start,
        stop,
        showSettings: () => settingsModal.show(),
        toggleKind,
        toggleScreenCapture: isScreenCaptureSupported() ? toggleScreenCapture : null,
        // プレイバックは mp4 の録画だけ（webm でしか録画できない環境では使えない）
        togglePlayback: isPlaybackSupported() && segmentFormatOf(getRecordingMimeType() ?? '') === 'fmp4' ? togglePlayback : null,
        // 録画一覧のページを、この番組を選んだ状態で開く
        openRecordings: () => {
            requestOpenLibrary(programId).catch((error) => console.log("録画一覧を開けませんでした:", error))
        },
    })
    setKindChips({ video: recordVideo, comments: recordWithComments })
    // 設定で「演出あり」を選んでいれば、押して始めるよう「演出あり」を光らせる
    refreshScreenChip()

    // 録画状態の変更を監視してボタンを更新
    stateManager.onChange((state) => {
        updateToggleButton(state === 'recording')
    })

    // 折りたたみボタンを追加（DOM準備後に実行）
    executeWhenIdle(async () => {
        await insertToggleButton()
        // 初期状態を反映
        updateToggleButton(stateManager.getState() === 'recording')

        // 折りたたみボタンの初期化が完了した後、初期読み込みを実行
        executeWhenIdle(async () => {
            await new Promise(resolve => setTimeout(resolve, 1000))

            executeWhenIdle(async () => {
                if (autoStart) {
                    initStream() // 録画を開始
                } else {
                    // 動画の準備は録画開始ボタンを押した時に待つので、ここでは待たずに開始できる状態にする
                    // （動画が一時停止中だと準備完了を検知できず、準備中のまま固まっていた）
                    stateManager.setState('stopped')
                }
                observeVideoResize() // 動画の解像度の変更・読み込み直しを監視

                await new Promise(resolve => setTimeout(resolve, 1000))

                // 以下は時間がかかることがあるので、録画を始めてから
                executeWhenIdle(async () => {
                    // 拡張機能が更新された直後などに一時保存した録画を、拡張機能側へ移す
                    await flushPending().catch((error) => console.log("一時保存した録画を移せませんでした:", error))
                    // 録画中にタブが閉じられるなどして、終えられないまま残った録画を確定する
                    await closeStaleSegments(STALE_SEGMENT_IDLE_MS).catch((error) => console.log("残っていた録画を確定できませんでした:", error))
                    // 移した分で容量の上限を超えていれば、古いものから消す
                    await enforceStorageLimit()

                    // 以前のバージョンの録画を拡張機能側へ移す
                    migrateLegacy()
                        .catch((error) => console.log("以前の録画を移せませんでした:", error))
                })
            })
        })
    })
}
