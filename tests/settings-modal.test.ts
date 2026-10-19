// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import SettingsModal from '@/entrypoints/content/settings-modal'
import { getUsage } from '@/utils/library/api'
import { MAX_STORAGE_SIZE, RECORD_VIDEO, RECORD_WITH_COMMENTS, RESOLUTION_MODE, FIXED_RESOLUTION_HEIGHT } from '@/utils/storage'

vi.mock('@/utils/library/api', () => ({
    getUsage: vi.fn(async () => ({ bytes: 2 * GB, segments: 1, bytesByKind: { video: 2 * GB, comments: 0, screen: 0 } })),
    clearAll: vi.fn(),
    estimateStorage: vi.fn(async () => ({ usage: 0, quota: 100 * GB })),
}))

const GB = 1024 * 1024 * 1024
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const slider = (id: string) => document.getElementById(id) as HTMLInputElement
const moveSlider = (id: string, value: number, event: 'input' | 'change') => {
    slider(id).value = String(value)
    slider(id).dispatchEvent(new Event(event))
}

let modal: SettingsModal

beforeEach(async () => {
    fakeBrowser.reset()
    vi.mocked(getUsage).mockClear()
    document.body.innerHTML = '<div id="recordedMovieAria"></div>'
    modal = new SettingsModal()
    await flush() // 設定の読み込みを待つ
})

afterEach(() => {
    modal.close()
})

describe('設定画面', () => {
    it('ページを開いただけでは録画を全件読んで使用量を数えず、設定画面を開いた時に数える', async () => {
        expect(getUsage).not.toHaveBeenCalled()

        modal.show()
        await flush()

        expect(getUsage).toHaveBeenCalled()
    })

    it('使用量の表示を更新した後も、スライダーを動かすと「設定上限」の表示が変わる', async () => {
        modal.show()
        await flush() // 使用量の取得と表示の更新を待つ

        moveSlider('storageRange', 5 * GB, 'input')

        expect(document.getElementById('usageStorageGB')?.textContent).toBe('5')
        expect(document.getElementById('storageGB')?.textContent).toBe('5')
    })

    it('スライダーを動かしている間は保存せず、手を離した時に保存する', async () => {
        modal.show()
        await flush()

        moveSlider('storageRange', 5 * GB, 'input')
        await flush()
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(1 * GB)

        moveSlider('storageRange', 5 * GB, 'change')
        await flush()
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(5 * GB)
    })

    it('録画を区切る間隔は設定にない（内部で区切る）', () => {
        modal.show()

        expect(document.getElementById('intervalRange')).toBeNull()
    })

    describe('録画する種類', () => {
        const checkbox = (id: string) => document.getElementById(id) as HTMLInputElement
        const toggle = async (id: string) => {
            checkbox(id).checked = !checkbox(id).checked
            checkbox(id).dispatchEvent(new Event('change'))
            await flush()
        }

        it('初期値は「動画のみ」だけで、「コメント付き」を足すと両方が保存される', async () => {
            modal.show()
            expect(checkbox('recordVideoCheckbox').checked).toBe(true)
            expect(checkbox('recordWithCommentsCheckbox').checked).toBe(false)

            await toggle('recordWithCommentsCheckbox')

            expect(await RECORD_VIDEO.getValue()).toBe(true)
            expect(await RECORD_WITH_COMMENTS.getValue()).toBe(true)
        })

        it('最後の1つは外せない（何も録画しない設定にはできない）', async () => {
            modal.show()

            await toggle('recordVideoCheckbox')

            expect(checkbox('recordVideoCheckbox').checked).toBe(true)
            expect(await RECORD_VIDEO.getValue()).toBe(true)
            expect(document.querySelector('.kinds-message')?.textContent).toContain('少なくとも1つ')

            // 「コメント付き」を選んでからなら、「動画のみ」を外せる
            await toggle('recordWithCommentsCheckbox')
            await toggle('recordVideoCheckbox')
            expect(await RECORD_VIDEO.getValue()).toBe(false)
            expect(await RECORD_WITH_COMMENTS.getValue()).toBe(true)
            expect(document.querySelector('.kinds-message')?.textContent).toBe('')
        })
    })

    describe('解像度が変わった時', () => {
        it('初期値は「録画を分ける」で、解像度は選べない', () => {
            modal.show()

            expect((document.getElementById('resolutionSplitRadio') as HTMLInputElement).checked).toBe(true)
            expect((document.getElementById('fixedResolutionSelect') as HTMLSelectElement).disabled).toBe(true)
        })

        it('「一定の解像度で録る」を選ぶと保存され、解像度を選べるようになる', async () => {
            modal.show()
            const fixed = document.getElementById('resolutionFixedRadio') as HTMLInputElement
            const select = document.getElementById('fixedResolutionSelect') as HTMLSelectElement

            fixed.checked = true
            fixed.dispatchEvent(new Event('change'))
            select.value = '1080'
            select.dispatchEvent(new Event('change'))
            await flush()

            expect(select.disabled).toBe(false)
            expect(await RESOLUTION_MODE.getValue()).toBe('fixed')
            expect(await FIXED_RESOLUTION_HEIGHT.getValue()).toBe(1080)
        })
    })

    it('使用量を読み込めた時は、読み込めなかったお知らせを出さない', async () => {
        modal.show()
        await flush()

        expect((document.querySelector('.usage-error') as HTMLElement).hidden).toBe(true)
    })

    it('使用量を読み込めなかった時は、そう知らせる', async () => {
        vi.mocked(getUsage).mockRejectedValueOnce(new Error('unavailable'))
        modal.show()
        await flush()

        expect((document.querySelector('.usage-error') as HTMLElement).hidden).toBe(false)
    })

    it('ラベルが入力欄と結び付いている（for 属性）', () => {
        modal.show()

        expect(document.querySelector('label[for="storageRange"]')).not.toBeNull()
        expect(document.querySelector('label[htmlFor]')).toBeNull()
    })
})
