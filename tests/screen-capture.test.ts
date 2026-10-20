// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { isScreenCaptureSupported, startScreenCapture, regionInFrame } from '@/utils/screen-capture'

describe('startScreenCapture', () => {
    it('この環境（コマを受け取る API などがない）では使えないと判定する', () => {
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

describe('regionInFrame（タブ全体のコマの中の、プレイヤーの位置）', () => {
    const rect = { x: 100, y: 128, width: 1000, height: 562.5 }

    it('コマの大きさと表示領域の大きさの比で、プレイヤーの位置を求める（画面の拡大率が 2 なら 2 倍）', () => {
        const region = regionInFrame({ width: 3200, height: 1800 }, rect, { innerWidth: 1600, innerHeight: 900, clientWidth: 1585 })
        expect(region).toEqual({ x: 200, y: 256, width: 2000, height: 1125 })
    })

    it('縦のスクロールバーがコマに写っていなければ、スクロールバーを除いた幅で求める', () => {
        const region = regionInFrame({ width: 1585, height: 900 }, rect, { innerWidth: 1600, innerHeight: 900, clientWidth: 1585 })
        expect(region).toEqual({ x: 100, y: 128, width: 1000, height: 562.5 })
    })

    it('スクロールして表示領域からはみ出した所は、写っている所だけにする', () => {
        const region = regionInFrame({ width: 1600, height: 900 }, { ...rect, y: -100 }, { innerWidth: 1600, innerHeight: 900, clientWidth: 1600 })
        expect(region).toEqual({ x: 100, y: 0, width: 1000, height: 462.5 })
        expect(regionInFrame({ width: 1600, height: 900 }, { ...rect, y: 1000 }, { innerWidth: 1600, innerHeight: 900, clientWidth: 1600 }).height).toBe(0)
    })
})
