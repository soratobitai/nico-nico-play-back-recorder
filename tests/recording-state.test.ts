import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordingStateManager } from '@/utils/recording'
import { setRecordingStatus } from '@/utils/ui'

vi.mock('@/utils/ui', () => ({
    setRecordingStatus: vi.fn(),
    insertRecordedMovie: vi.fn(),
    getTimeString: () => '00:00',
}))

beforeEach(() => {
    vi.mocked(setRecordingStatus).mockClear()
})

describe('RecordingStateManager', () => {
    it('初期状態は画面の初期表示と同じ「準備中」', () => {
        expect(new RecordingStateManager().getState()).toBe('preparing')
    })

    it('初期状態から停止中にすると、録画開始ボタンが押せる表示に更新される（オートスタート OFF の起動時）', () => {
        const stateManager = new RecordingStateManager()

        stateManager.setState('stopped')

        expect(setRecordingStatus).toHaveBeenLastCalledWith(true, false, '停止中')
    })

    it('状態が変わった時だけ表示を更新し、リスナーに通知する', () => {
        const stateManager = new RecordingStateManager()
        const listener = vi.fn()
        stateManager.onChange(listener)

        stateManager.setState('recording')
        stateManager.setState('recording')

        expect(setRecordingStatus).toHaveBeenCalledTimes(1)
        expect(setRecordingStatus).toHaveBeenLastCalledWith(false, true, '🔴録画中')
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith('recording')
    })
})
