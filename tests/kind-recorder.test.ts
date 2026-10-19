// 種類ごとの録画（区切りながら録り続ける）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKindRecorder, type KindRecorderOptions } from '@/utils/kind-recorder'
import * as library from '@/utils/library/api'
import type { RecordingSource } from '@/utils/recording-source'

vi.mock('@/utils/ui', () => ({
    removeSegmentItems: vi.fn(),
    setRecordingStatus: vi.fn(),
    getTimeString: () => '00:00',
}))
vi.mock('@/services/api', () => ({ checkLiveStatus: vi.fn(async () => 'ON_AIR') }))
vi.mock('@/utils/library/api', () => ({
    createSegment: vi.fn(async () => {}),
    setSegmentInit: vi.fn(async () => {}),
    appendFragments: vi.fn(async () => {}),
    finishSegment: vi.fn(async (segmentId: string, endedAt: number) => ({ segmentId, endedAt })),
    freeSpace: vi.fn(async () => ({ freed: 0, deletedSegmentIds: [] })),
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
    const source: RecordingSource = { stream: {} as MediaStream, fixedSize: false, stop: vi.fn() }
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

    it('映像の解像度が固定かどうかを、映像から知らせる', () => {
        const { recorder } = create({ createSource: () => ({ ...createSource(), fixedSize: true }) })

        expect(recorder.fixedSize).toBe(false) // 録り始めるまでは映像がない
        recorder.start()
        expect(recorder.fixedSize).toBe(true)
    })
})
