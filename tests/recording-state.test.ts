import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecordingStateManager } from '@/utils/recording'
import { setRecorderState } from '@/utils/ui'

vi.mock('@/utils/ui', () => ({
    setRecorderState: vi.fn(),
    getTimeString: () => '0:00',
}))

beforeEach(() => {
    vi.mocked(setRecorderState).mockClear()
})

describe('RecordingStateManager', () => {
    it('初期状態は録画バーの初期表示と同じ「準備中」', () => {
        expect(new RecordingStateManager().getState()).toBe('preparing')
    })

    it('状態を変えると録画バーの表示を更新する（オートスタート OFF の起動時は停止中）', () => {
        const stateManager = new RecordingStateManager()

        stateManager.setState('stopped')

        expect(setRecorderState).toHaveBeenLastCalledWith('stopped')
    })

    it('状態が変わった時だけ表示を更新し、リスナーに通知する', () => {
        const stateManager = new RecordingStateManager()
        const listener = vi.fn()
        stateManager.onChange(listener)

        stateManager.setState('recording')
        stateManager.setState('recording')

        expect(setRecorderState).toHaveBeenCalledTimes(1)
        expect(setRecorderState).toHaveBeenLastCalledWith('recording')
        expect(listener).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalledWith('recording')
    })
})
