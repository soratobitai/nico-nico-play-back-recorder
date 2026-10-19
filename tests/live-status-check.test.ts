import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTimeoutCheck } from '@/utils/recording'
import { checkLiveStatus } from '@/services/api'

vi.mock('@/utils/ui', () => ({
    insertRecordedMovie: vi.fn(),
    removeSegmentItems: vi.fn(),
    setRecordingStatus: vi.fn(),
    getTimeString: () => '00:00',
}))
vi.mock('@/services/api', () => ({ checkLiveStatus: vi.fn() }))

const SAVE_CHUNK_INTERVAL_MS = 3 * 1000

// 録画中の MediaRecorder の代わり
const fakeRecorder = (state: RecordingState = 'recording') => {
    const recorder = {
        state,
        stop: vi.fn(() => { recorder.state = 'inactive' }),
    }
    return recorder as typeof recorder & MediaRecorder
}

beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(checkLiveStatus).mockReset()
})

afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
})

describe('resetTimeoutCheck（チャンクが届かなくなった時の監視）', () => {
    it('放送が終了していたら録画を止める', async () => {
        vi.mocked(checkLiveStatus).mockResolvedValue('ENDED')
        const recorder = fakeRecorder()

        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS)
        await vi.advanceTimersByTimeAsync(9 * 1000)

        expect(recorder.stop).toHaveBeenCalledTimes(1)
    })

    it('ライブ状態を取得できない時は録画を止めず、間隔を伸ばしながら再確認する', async () => {
        vi.mocked(checkLiveStatus).mockResolvedValue('ERROR')
        const recorder = fakeRecorder()

        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS)

        // 9秒 → 18秒 → 36秒 → 60秒（上限）→ 60秒 の間隔で確認する
        await vi.advanceTimersByTimeAsync(9 * 1000)
        expect(checkLiveStatus).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(18 * 1000 - 1)
        expect(checkLiveStatus).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(checkLiveStatus).toHaveBeenCalledTimes(2)
        await vi.advanceTimersByTimeAsync(36 * 1000)
        expect(checkLiveStatus).toHaveBeenCalledTimes(3)
        await vi.advanceTimersByTimeAsync(60 * 1000)
        expect(checkLiveStatus).toHaveBeenCalledTimes(4)
        await vi.advanceTimersByTimeAsync(60 * 1000)
        expect(checkLiveStatus).toHaveBeenCalledTimes(5)

        expect(recorder.stop).not.toHaveBeenCalled()
    })

    it('取得できなかった後に放送終了が分かれば録画を止める', async () => {
        vi.mocked(checkLiveStatus).mockResolvedValueOnce('ERROR').mockResolvedValue('ENDED')
        const recorder = fakeRecorder()

        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS)
        await vi.advanceTimersByTimeAsync((9 + 18) * 1000)

        expect(recorder.stop).toHaveBeenCalledTimes(1)
    })

    it('チャンクが届いて監視し直したら、再確認の間隔は元に戻る', async () => {
        vi.mocked(checkLiveStatus).mockResolvedValue('ERROR')
        const recorder = fakeRecorder()

        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS)
        await vi.advanceTimersByTimeAsync(9 * 1000) // 1回失敗（次は18秒後の予定）

        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS) // チャンクが届いた
        await vi.advanceTimersByTimeAsync(9 * 1000)

        expect(checkLiveStatus).toHaveBeenCalledTimes(2)
    })

    it('既に停止している recorder ではライブ状態を確認しない', async () => {
        const recorder = fakeRecorder('inactive')

        resetTimeoutCheck(recorder, SAVE_CHUNK_INTERVAL_MS)
        await vi.advanceTimersByTimeAsync(9 * 1000)

        expect(checkLiveStatus).not.toHaveBeenCalled()
    })
})
