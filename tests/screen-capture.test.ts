// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isScreenCaptureSupported, startScreenCapture } from '@/utils/screen-capture'
import { insertRecordedMovieAria, setScreenCaptureButton } from '@/utils/ui'

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

describe('画面ごと録画ボタン', () => {
    const button = () => document.getElementById('screenCaptureButton') as HTMLButtonElement

    beforeEach(() => {
        vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } })
        document.body.innerHTML = '<div class="___control-area___x"></div>'
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('使えない環境ではボタンを表示しない', async () => {
        await insertRecordedMovieAria(() => {}, () => {}, () => {}, () => {}, null, null)

        expect(button().hidden).toBe(true)
    })

    it('使える環境ではボタンを表示し、押すと切り替えの処理を呼ぶ', async () => {
        const toggle = vi.fn()
        await insertRecordedMovieAria(() => {}, () => {}, () => {}, () => {}, toggle, null)

        expect(button().hidden).toBe(false)
        expect(button().textContent).toBe('画面録画')
        button().click()
        expect(toggle).toHaveBeenCalledTimes(1)
    })

    it('画面ごと録画中は「画面録画中」と表示し、やめると元に戻す', async () => {
        await insertRecordedMovieAria(() => {}, () => {}, () => {}, () => {}, () => {}, null)

        setScreenCaptureButton(true)
        expect(button().textContent).toBe('画面録画中')
        expect(button().classList.contains('active')).toBe(true)

        setScreenCaptureButton(false)
        expect(button().textContent).toBe('画面録画')
        expect(button().classList.contains('active')).toBe(false)
    })
})
