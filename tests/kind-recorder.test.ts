// 種類ごとの録画（区切りながら録り続ける）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKindRecorder, type KindRecorderOptions } from '@/utils/kind-recorder'
import * as library from '@/utils/library/api'
import type { RecordingSource } from '@/utils/recording-source'

vi.mock('@/utils/ui', () => ({
    setRecorderState: vi.fn(),
    getTimeString: () => '0:00',
}))
vi.mock('@/services/api', () => ({ checkLiveStatus: vi.fn(async () => 'ON_AIR') }))
vi.mock('@/utils/library/api', () => ({
    createSegment: vi.fn(async () => {}),
    setSegmentInit: vi.fn(async () => {}),
    appendFragments: vi.fn(async () => {}),
    finishSegment: vi.fn(async (segmentId: string, endedAt: number) => ({ segmentId, endedAt })),
    freeSpace: vi.fn(async () => ({ freed: 0, deletedSegmentIds: [] })),
    deleteSegments: vi.fn(async () => {}),
}))

// MediaRecorder の代わり（webm だけに対応している）
class FakeRecorder {
    static instances: FakeRecorder[] = []
    static isTypeSupported = (type: string) => type.startsWith('video/webm; codecs="vp9')
    static failNext = false
    state: 'inactive' | 'recording' = 'inactive'
    mimeType: string
    timeslice?: number
    onstart: (() => void) | null = null
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null

    constructor(public stream: MediaStream, options: { mimeType?: string }) {
        if (FakeRecorder.failNext) {
            FakeRecorder.failNext = false
            throw new Error('NotSupportedError')
        }
        this.mimeType = options.mimeType ?? ''
        FakeRecorder.instances.push(this)
    }

    start(timeslice: number) {
        this.timeslice = timeslice
        this.state = 'recording'
        queueMicrotask(() => this.onstart?.())
    }

    emit(text: string) {
        this.ondataavailable?.({ data: new Blob([text]) })
    }

    // 止まると、最後のデータを渡してから onstop が呼ばれる
    stop() {
        if (this.state === 'inactive') return
        this.state = 'inactive'
        setTimeout(() => {
            this.ondataavailable?.({ data: new Blob(['last']) })
            this.onstop?.()
        })
    }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10))

const createSource = () => {
    const source: RecordingSource = { stream: {} as MediaStream, fixedSize: false, steadySize: true, stop: vi.fn() }
    return source
}

const create = (overrides: Partial<KindRecorderOptions> = {}) => {
    const sources: RecordingSource[] = []
    const options: KindRecorderOptions = {
        kind: 'comments',
        createSource: () => {
            const source = createSource()
            sources.push(source)
            return source
        },
        segmentDetails: () => ({ programId: 'lv1', title: 'title', userName: 'user', thumbnail: null }),
        chunkIntervalMs: 3000,
        onStarted: vi.fn(),
        onData: vi.fn(),
        onSegmentFinished: vi.fn(),
        onEnded: vi.fn(),
        ...overrides,
    }
    return { recorder: createKindRecorder(options), options, sources }
}

const createdSegments = () => vi.mocked(library.createSegment).mock.calls.map(([segment]) => segment)

beforeEach(() => {
    vi.clearAllMocks()
    FakeRecorder.instances = []
    vi.stubGlobal('MediaRecorder', FakeRecorder)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('createKindRecorder', () => {
    it('映像を作って録り始め、その種類の区間として保存する', async () => {
        const { recorder, options, sources } = create()

        recorder.start()
        await flush()
        FakeRecorder.instances[0].emit('a')
        await flush()

        expect(recorder.isRecording).toBe(true)
        expect(sources).toHaveLength(1)
        expect(FakeRecorder.instances[0].timeslice).toBe(3000)
        expect(options.onStarted).toHaveBeenCalledTimes(1)
        expect(options.onStarted).toHaveBeenCalledWith(FakeRecorder.instances[0]) // 見張りを始められるように
        expect(createdSegments()[0]).toMatchObject({ kind: 'comments', programId: 'lv1', format: 'opaque' })
        expect(library.appendFragments).toHaveBeenCalledTimes(1)
        expect(options.onData).toHaveBeenCalledWith(FakeRecorder.instances[0])
    })

    it('区切ると、同じ映像のまま次の区間を録り始め、前の区間は確定する', async () => {
        const { recorder, options, sources } = create()
        recorder.start()
        await flush()

        recorder.split()
        await flush()

        expect(sources).toHaveLength(1) // 映像は作り直さない
        expect(sources[0].stop).not.toHaveBeenCalled()
        expect(FakeRecorder.instances).toHaveLength(2)
        const [first, second] = createdSegments()
        expect(second.segmentId).not.toBe(first.segmentId)
        expect(library.finishSegment).toHaveBeenCalledWith(first.segmentId, expect.any(Number), expect.anything())
        expect(options.onSegmentFinished).toHaveBeenCalledTimes(1)
        expect(options.onEnded).not.toHaveBeenCalled()
        expect(recorder.isRecording).toBe(true)
    })

    it('録画中の区間が消されていたら（録画一覧で削除された など）、すぐ次の区間に区切って録り続ける', async () => {
        const { recorder, sources } = create()
        recorder.start()
        await flush()
        vi.mocked(library.appendFragments).mockRejectedValueOnce(Object.assign(new Error('録画の区間が見つかりません'), { name: 'SegmentNotFoundError' }))
        FakeRecorder.instances[0].emit('a')
        await flush()
        await flush()

        expect(FakeRecorder.instances).toHaveLength(2)
        expect(createdSegments()).toHaveLength(2)
        expect(sources).toHaveLength(1)
        expect(recorder.isRecording).toBe(true)
        // 次の区間には、そのまま保存する
        FakeRecorder.instances[1].emit('b')
        await flush()
        expect(vi.mocked(library.appendFragments).mock.calls.at(-1)?.[0]).toBe(createdSegments()[1].segmentId)
    })

    it('前の区間の最後のデータは、確定する前に保存する', async () => {
        const { recorder } = create()
        recorder.start()
        await flush()

        recorder.split()
        await flush()

        const [appended] = vi.mocked(library.appendFragments).mock.invocationCallOrder
        const [finished] = vi.mocked(library.finishSegment).mock.invocationCallOrder
        expect(appended).toBeLessThan(finished)
    })

    it('止めると、区間を確定して映像を解放する（止まったことは知らせない）', async () => {
        const { recorder, options, sources } = create()
        recorder.start()
        await flush()

        recorder.stop()
        await flush()

        expect(recorder.isRecording).toBe(false)
        expect(sources[0].stop).toHaveBeenCalledTimes(1)
        expect(library.finishSegment).toHaveBeenCalledTimes(1)
        expect(options.onEnded).not.toHaveBeenCalled()
    })

    it('区間を残さずに止めると、最後のデータの書き込みを待ってから区間を消す（確定しない）', async () => {
        const { recorder, options, sources } = create()
        recorder.start()
        await flush()
        const [segment] = createdSegments()

        recorder.discard()
        await flush()

        expect(recorder.isRecording).toBe(false)
        expect(sources[0].stop).toHaveBeenCalledTimes(1)
        expect(library.finishSegment).not.toHaveBeenCalled()
        expect(library.deleteSegments).toHaveBeenCalledWith([segment.segmentId])
        const [appended] = vi.mocked(library.appendFragments).mock.invocationCallOrder
        const [deleted] = vi.mocked(library.deleteSegments).mock.invocationCallOrder
        expect(appended).toBeLessThan(deleted)
        expect(options.onSegmentFinished).not.toHaveBeenCalled()
        expect(options.onEnded).not.toHaveBeenCalled()
    })

    it('今の区間を録り始めた時刻を覚えておき、区切ると次の区間の時刻になる', async () => {
        const { recorder } = create()
        expect(recorder.segmentStartedAt).toBeNull()
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
        recorder.start()
        expect(recorder.segmentStartedAt).toBe(1000)
        expect(createdSegments()[0].startedAt).toBe(1000)

        await flush()
        now.mockReturnValue(5000)
        recorder.split()
        expect(recorder.segmentStartedAt).toBe(5000)
        now.mockRestore()
        recorder.stop()
        await flush()
    })

    it('映像が終わるなどして勝手に止まったら、映像を解放して知らせる', async () => {
        const { recorder, options, sources } = create()
        recorder.start()
        await flush()

        FakeRecorder.instances[0].stop()
        await flush()

        expect(recorder.isRecording).toBe(false)
        expect(sources[0].stop).toHaveBeenCalledTimes(1)
        expect(options.onEnded).toHaveBeenCalledTimes(1)
        expect(library.finishSegment).toHaveBeenCalledTimes(1)
    })

    it('録り始められなければ、映像を解放して例外にする', () => {
        const { recorder, sources } = create()
        FakeRecorder.failNext = true

        expect(() => recorder.start()).toThrow()
        expect(recorder.isRecording).toBe(false)
        expect(sources[0].stop).toHaveBeenCalledTimes(1)
    })

    it('保存に失敗しても、データが届いていれば見張りに知らせる（ライブが止まったと誤って判断しない）', async () => {
        vi.mocked(library.appendFragments).mockRejectedValueOnce(Object.assign(new Error('unknown'), { name: 'UnknownError' }))
        const { recorder, options } = create({ onSaveFailed: vi.fn() })
        recorder.start()
        await flush()

        FakeRecorder.instances[0].emit('a')
        await flush()

        expect(options.onData).toHaveBeenCalledWith(FakeRecorder.instances[0])
        expect(options.onSaveFailed).not.toHaveBeenCalled() // 容量不足でなければ止めない
    })

    it('区切った後は、前の recorder のデータでは見張りに知らせない', async () => {
        const { recorder, options } = create()
        recorder.start()
        await flush()
        const old = FakeRecorder.instances[0]

        recorder.split()
        await flush()
        vi.mocked(options.onData!).mockClear()
        old.emit('late')
        await flush()

        expect(options.onData).not.toHaveBeenCalled()
    })

    it('区切ると、新しい区間の recorder で録り始めたことを知らせる（データが届く前から見張れるように）', async () => {
        const { recorder, options } = create()
        recorder.start()
        await flush()

        recorder.split()
        await flush()

        expect(options.onStarted).toHaveBeenCalledTimes(2)
        expect(options.onStarted).toHaveBeenLastCalledWith(FakeRecorder.instances[1])
    })

    it('容量不足で区間を作れなかったら、古い録画を消して作り直す', async () => {
        vi.mocked(library.createSegment).mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
        vi.mocked(library.freeSpace).mockResolvedValueOnce({ freed: 1000, deletedSegmentIds: [] })
        const { recorder, options } = create({ onSaveFailed: vi.fn() })
        recorder.start()
        await flush()
        FakeRecorder.instances[0].emit('a')
        await flush()

        expect(library.createSegment).toHaveBeenCalledTimes(2)
        expect(library.appendFragments).toHaveBeenCalledTimes(1)
        expect(options.onSaveFailed).not.toHaveBeenCalled()
    })

    it('古い録画を消しても区間を作れなければ、保存できないことを知らせ、その区間のデータは書き込まない', async () => {
        // 消せる録画がない（freeSpace が何も消さない）
        vi.mocked(library.createSegment).mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'))
        const { recorder, options } = create({ onSaveFailed: vi.fn() })
        recorder.start()
        await flush()
        FakeRecorder.instances[0].emit('a')
        await flush()

        expect(options.onSaveFailed).toHaveBeenCalledTimes(1)
        expect(library.appendFragments).not.toHaveBeenCalled()
    })

    it('映像の解像度が固定かどうかを、映像から知らせる', () => {
        const { recorder } = create({ createSource: () => ({ ...createSource(), fixedSize: true }) })

        expect(recorder.fixedSize).toBe(false) // 録り始めるまでは映像がない
        recorder.start()
        expect(recorder.fixedSize).toBe(true)
    })
})
