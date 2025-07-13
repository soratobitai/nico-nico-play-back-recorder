import { saveChunk, getAllChunks, deleteChunkByKeys, cleanUpAllChunks } from "../hooks/indexedDB/recordingDB"
import { checkLiveStatus } from '../services/api'

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
    // 録画時間を更新
    startTime = Date.now()
    recordTimer = setInterval(() => {
        if (startTime) {
            const timeString = getTimeString(startTime)
            const recordTimeElem = document.getElementById('recordTime')
            if (recordTimeElem) recordTimeElem.textContent = `${timeString}`
        }
    }, 1000)
}

const startRecordingActions = async (
    resetRecording: () => void,
    mediaRecorder: MediaRecorder,
    RESTART_MEDIARECORDER_INTERVAL_MS: number,
    SAVE_CHUNK_INTERVAL_MS: number,
) => {
    startTimer()
    startResetRecordInterval(resetRecording, RESTART_MEDIARECORDER_INTERVAL_MS)
    resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS)
    setRecordingStatus(false, true, "🔴録画中")
    console.log("録画を開始しました。")
}

const stopRecordingActions = async (sessionId: string) => {

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
        if (recordTimeElem) recordTimeElem.textContent = '00:00:00'
    }
    resetRecordingTimer()

    setRecordingStatus(true, false, '停止中')
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
) => {
    clearTimeout(recordingTimeout)
    recordingTimeout = setTimeout(async () => {

        // ライブが続いているか確認
        const liveStatus = await checkLiveStatus()
        if (liveStatus === 'ON_AIR') {
            if (mediaRecorder.state === 'recording') {
                // ライブが続いていて、かつ録画中の場合のみリロードボタンを押す
                const reloadButton = document.querySelector('button[class*="___reload-button___"]') as HTMLButtonElement
                if (reloadButton) {
                    console.log('ライブが続いていて録画中のためリロードボタンを押します')
                    reloadButton.click()
                }
            }
        } else {
            // 録画を停止
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop()
            }
            console.log('ライブが終了したため録画を停止します')

            clearTimeout(recordingTimeout)
        }
    }, SAVE_CHUNK_INTERVAL_MS * 3)
}

// ミュート対策
const fixAudioTrack = (video: HTMLVideoElement) => {

    let previousVolume = '0'
    let isMuted = 'false'

    const controlMute = () => {
        isMuted = localStorage.getItem('LeoPlayer_MuteSettingsStore_isMute') || 'false'
        previousVolume = localStorage.getItem('LeoPlayer_VolumeSettingsStore_volume') || '0'

        if (isMuted === 'true' || previousVolume === '0') {
            console.log("🔴 ミュート検出", video.volume)

            video.muted = false
            video.volume = 0.0000001
        } else {
            console.log("🔊 ミュート解除検出")
            video.volume = Number(previousVolume) / 100
        }
    }

    controlMute()

    // ミュートボタン押下時
    const muteButtons = document.querySelectorAll('[class*="_mute-button_"]')
    muteButtons.forEach(button => button.addEventListener("click", () => {
        controlMute()
    }))

    // 音量変化時
    video.addEventListener("volumechange", async () => {
        controlMute()
    })
}

const cleanUp = async (sessionId: string) => {

    // リセット（すべてのチャンクを削除）
    await cleanUpAllChunks('Chunks')
    await cleanUpAllChunks('Temps')

    // stopRecordingActions(sessionId)
    reloadRecordedMovieList() // 録画リストを更新
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
