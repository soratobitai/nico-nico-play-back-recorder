// 1つの種類（コメントなし・コメントあり・演出あり）の録画
// 同じ映像のまま区間を区切りながら（split）録り続ける。種類ごとに別々の区間として保存する。
// 録ったデータは届くたびに保存先へ書き込むので、録画中でもプレイバックできる。
import { createSegmentWriter, getRecordingMimeType, segmentFormatOf, isQuotaExceeded } from './recording'
import type { RecordingSource } from './recording-source'
import type { NewSegment, RecordingKind, SegmentSummary } from './library/db'

// 区間に記録する番組の情報など
type SegmentDetails = Pick<NewSegment, 'programId' | 'title' | 'userName' | 'thumbnail'>

type KindRecorderOptions = {
    kind: RecordingKind
    createSource: () => RecordingSource
    segmentDetails: () => SegmentDetails
    chunkIntervalMs: number // この間隔でデータを受け取って保存する
    onStarted?: (recorder: MediaRecorder) => void // 区間の録画が始まった（区切るたびに呼ばれる）
    onData?: (recorder: MediaRecorder) => void // データが届いた（止まっていないかの見張りに使う）
    onSegmentFinished?: (segment: SegmentSummary) => void
    onSaveFailed?: (error: unknown) => void // 古い録画を消しても保存できなかった
    onEnded?: () => void // stop() を呼ばずに録画が止まった（映像が終わった など）
}

const createKindRecorder = ({
    kind, createSource, segmentDetails, chunkIntervalMs,
    onStarted, onData, onSegmentFinished, onSaveFailed, onEnded,
}: KindRecorderOptions) => {
    let source: RecordingSource | null = null
    let current: MediaRecorder | null = null
    const requestedStops = new WeakSet<MediaRecorder>() // こちらから止めた recorder

    const releaseSource = () => {
        source?.stop()
        source = null
    }

    // 区間を1つ録り始める（失敗したら例外）
    const startSegment = () => {
        const mimeType = getRecordingMimeType()
        const recorder = new MediaRecorder(source!.stream, mimeType ? { mimeType } : {})
        const recordingMimeType = mimeType ?? (recorder.mimeType || 'video/webm')
        const writer = createSegmentWriter({
            segmentId: crypto.randomUUID(),
            kind,
            format: segmentFormatOf(recordingMimeType),
            mimeType: recordingMimeType,
            startedAt: Date.now(),
            ...segmentDetails(),
        })
        const failed = (error: unknown) => {
            if (isQuotaExceeded(error) && recorder === current) onSaveFailed?.(error)
        }
        // 書き込みを直列化し、止めた時に最後のデータの書き込みを待てるようにする
        // 区間を作れなかった場合は、この区間のデータは書き込めないので書き込まない
        let created = true
        let saving: Promise<void> = writer.start().catch((error) => {
            created = false
            console.error('録画の区間を作れませんでした:', error)
            failed(error)
        })

        recorder.onstart = () => {
            if (recorder === current) onStarted?.(recorder)
        }

        recorder.ondataavailable = (event: BlobEvent) => {
            if (event.data.size <= 0) return
            // 録画は止まっていない（保存できたかどうかは別に扱う。保存の失敗で、ライブが止まったと誤って判断しないように）
            if (recorder === current) onData?.(recorder)
            saving = saving
                .then(async () => {
                    if (!created) return
                    await writer.write(event.data)
                })
                .catch((error) => {
                    console.error('録画の保存に失敗しました:', error)
                    failed(error)
                })
        }

        recorder.onstop = async () => {
            // こちらから止めたのでなければ、映像が終わったなどで止まった
            if (recorder === current && !requestedStops.has(recorder)) {
                current = null
                releaseSource()
                onEnded?.()
            }
            // 最後のデータの書き込みを待ってから、区間を確定する
            await saving
            const segment = await writer.finish(Date.now(), recorder.mimeType || undefined).catch((error) => {
                console.error('録画の区間を確定できませんでした:', error)
                return null
            })
            if (segment) onSegmentFinished?.(segment)
        }

        current = recorder
        try {
            recorder.start(chunkIntervalMs)
        } catch (error) {
            current = null
            // 作った区間は、断片がないので確定時に消える
            saving.then(() => writer.finish(Date.now())).catch(() => {})
            throw error
        }
    }

    const stopCurrent = () => {
        const recorder = current
        current = null
        if (recorder && recorder.state !== 'inactive') {
            requestedStops.add(recorder)
            recorder.stop()
        }
    }

    return {
        kind,

        get isRecording() {
            return current !== null
        },

        // 動画の解像度が変わっても録り直さなくてよいか
        get fixedSize() {
            return source?.fixedSize ?? false
        },

        // 動画の解像度が変わっても、録り直すまで録り続けられるか
        get steadySize() {
            return source?.steadySize ?? false
        },

        // 録り始める（映像を作って最初の区間を始める）。失敗したら例外
        start() {
            if (current) return
            source = createSource()
            try {
                startSegment()
            } catch (error) {
                releaseSource()
                throw error
            }
        },

        // 同じ映像のまま、次の区間に区切る（前の区間は確定して保存される）
        split() {
            if (!current) return
            stopCurrent()
            try {
                startSegment()
            } catch (error) {
                console.error('次の区間を録り始められませんでした:', error)
                releaseSource()
                onEnded?.()
            }
        },

        // 止める（今の区間は確定して保存される）
        stop() {
            stopCurrent()
            releaseSource()
        },
    }
}

type KindRecorder = ReturnType<typeof createKindRecorder>

export { createKindRecorder }
export type { KindRecorder, KindRecorderOptions, SegmentDetails }
