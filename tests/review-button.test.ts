// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { insertRecordedMovieAria, setReviewButton } from '@/utils/ui'
import { isReviewSupported } from '@/utils/review/window'

describe('見直しボタン', () => {
    const button = () => document.getElementById('reviewButton') as HTMLButtonElement

    beforeEach(() => {
        vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } })
        document.body.innerHTML = '<div class="___control-area___x"></div>'
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('この環境（Document Picture-in-Picture がない）では使えないと判定する', () => {
        expect(isReviewSupported()).toBe(false)
    })

    it('使えない環境ではボタンを表示しない', async () => {
        await insertRecordedMovieAria(() => {}, () => {}, () => {}, () => {}, null, null)

        expect(button().hidden).toBe(true)
    })

    it('使える環境ではボタンを表示し、押すとウィンドウを開く処理を呼ぶ', async () => {
        const toggle = vi.fn()
        await insertRecordedMovieAria(() => {}, () => {}, () => {}, () => {}, null, toggle)

        expect(button().hidden).toBe(false)
        expect(button().textContent).toBe('見直す')
        button().click()
        expect(toggle).toHaveBeenCalledTimes(1)
    })

    it('ウィンドウを開いている間は「見直し中」と表示し、閉じると元に戻す', async () => {
        await insertRecordedMovieAria(() => {}, () => {}, () => {}, () => {}, null, () => {})

        setReviewButton(true)
        expect(button().textContent).toBe('見直し中')
        expect(button().classList.contains('active')).toBe(true)

        setReviewButton(false)
        expect(button().textContent).toBe('見直す')
        expect(button().classList.contains('active')).toBe(false)
    })
})
