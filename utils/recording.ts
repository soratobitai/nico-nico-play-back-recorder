import { checkLiveStatus } from '../services/api'
import { setRecorderState, getTimeString } from './ui'
import { createFmp4Splitter, isMp4MimeType } from './fmp4'
import * as library from './library/api'
import { publishLiveFeed } from './review/live-feed'
import type { NewSegment, NewFragment, SegmentSummary } from './library/db'

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

  // 録画バーの表示を更新する（error は、容量不足で保存できない場合）
  private updateUI() {
    setRecorderState(this.state)
  }
}

let recordingTimeout: any // ondataavailable の発火を監視する関数

let startTime: number | null = null
let recordTimer: ReturnType<typeof setInterval> | null = null

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
    if (recordTimeElem) recordTimeElem.textContent = '0:00'
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


const isQuotaExceeded = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError'

// 容量不足で保存できなかった場合は、古い録画を bytesNeeded バイト以上削除してから1回だけ再試行する
// （設定の上限より実際に使える容量が少ない場合もここで古いものから消える）
const retryOnQuotaExceeded = async <T>(bytesNeeded: number, save: () => Promise<T>): Promise<T> => {
    try {
        return await save()
    } catch (error) {
        if (!isQuotaExceeded(error)) throw error

        const { freed } = await library.freeSpace(bytesNeeded)
        if (freed === 0) throw error // 削除できる録画がない
        console.log(`容量不足のため古い録画を削除しました: ${freed} バイト`)

        return await save()
    }
}

// 1回の録画処理（区間）で録ったデータを、保存先へ書き込む
// mp4 は初期化セグメントと数秒ごとの断片に分けて書き込む（録画中でも再生でき、古い断片から消していける）。
// 書き込んだら、同じページのプレイバックのウィンドウへ知らせる。
// webm などは、届いたデータをそのまま断片として書き込む。
// write は届いた順に1つずつ呼ぶこと（前の write が終わってから次を呼ぶ）
const createSegmentWriter = (segment: NewSegment) => {
    const splitter = segment.format === 'fmp4' ? createFmp4Splitter() : null
    let index = 0
    let opaqueEnd = 0 // webm などの、これまでに書き込んだ長さ（秒）

    const append = (fragments: NewFragment[]) => {
        const bytes = fragments.reduce((sum, f) => sum + f.blob.size, 0)
        return retryOnQuotaExceeded(bytes, () => library.appendFragments(segment.segmentId, fragments))
    }

    return {
        start: () => library.createSegment(segment),

        async write(data: Blob) {
            if (!splitter) {
                const now = (Date.now() - segment.startedAt) / 1000
                await append([{ index: index++, blob: data, moofSize: 0, startTime: opaqueEnd, duration: now - opaqueEnd, wallClock: Date.now() }])
                opaqueEnd = now
                return
            }
            const { init, fragments } = splitter.push(new Uint8Array(await data.arrayBuffer()))
            if (init) {
                const initBlob = new Blob([init], { type: segment.mimeType })
                await library.setSegmentInit(segment.segmentId, initBlob)
                publishLiveFeed({ type: 'init', segment, init: initBlob })
            }
            if (fragments.length === 0) return
            const saved = fragments.map(f => ({
                index: index++,
                blob: new Blob([f.bytes]),
                moofSize: f.moofSize,
                startTime: f.startTime,
                duration: f.duration,
                wallClock: segment.startedAt + f.startTime * 1000,
                keyframe: f.keyframe,
            }))
            await append(saved)
            publishLiveFeed({ type: 'fragments', segmentId: segment.segmentId, fragments: saved })
        },

        // 録画を終えた区間を確定する。断片が1つもない区間は消して null を返す
        async finish(endedAt: number, mimeType?: string): Promise<SegmentSummary | null> {
            const summary = await library.finishSegment(segment.segmentId, endedAt, mimeType)
            publishLiveFeed({ type: 'finish', segmentId: segment.segmentId, endedAt })
            return summary
        },
    }
}

// 録画形式から、保存の形式を決める
const segmentFormatOf = (mimeType: string) => isMp4MimeType(mimeType) ? 'fmp4' as const : 'opaque' as const

// ライブ状態の確認に続けて失敗した時の、再確認の間隔の上限
const MAX_LIVE_STATUS_RETRY_INTERVAL_MS = 60 * 1000

// ondataavailable の発火が止まったことを検知する
const resetTimeoutCheck = (
    mediaRecorder: MediaRecorder,
    SAVE_CHUNK_INTERVAL_MS: number,
    autoReloadOnFailure: boolean = false,
    failureCount: number = 0, // ライブ状態の確認に続けて失敗した回数（失敗が続くほど間隔を伸ばす）
    // ライブが終わっていた時（複数の種類を録画している場合は、すべて止める）
    onLiveEnded: () => void = () => mediaRecorder.stop(),
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
            resetTimeoutCheck(mediaRecorder, SAVE_CHUNK_INTERVAL_MS, autoReloadOnFailure, failureCount + 1, onLiveEnded)
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
            // 録画を停止
            onLiveEnded()
            console.log('ライブが終了したため録画を停止します')

            clearTimeout(recordingTimeout)
        }
    }, delay)
}

export {
    startTimer,
    stopTimer,
    getRecordingMimeType,
    isQuotaExceeded,
    retryOnQuotaExceeded,
    createSegmentWriter,
    segmentFormatOf,
    resetTimeoutCheck,
}
