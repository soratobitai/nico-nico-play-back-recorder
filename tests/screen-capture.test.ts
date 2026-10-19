// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { isScreenCaptureSupported, startScreenCapture } from '@/utils/screen-capture'

describe('startScreenCapture', () => {
    it('この環境（Region Capture などの API がない）では使えないと判定する', () => {
        expect(isScreenCaptureSupported()).toBe(false)
    })

    it('プレイヤーが見つからない・使えない環境では、共有の確認を出さずに例外にする', async () => {
        const getDisplayMedia = vi.fn()
        vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getDisplayMedia } })

        await expect(startScreenCapture(720, () => {})).rejects.toThrow()

        expect(getDisplayMedia).not.toHaveBeenCalled()
        vi.unstubAllGlobals()
    })
})
