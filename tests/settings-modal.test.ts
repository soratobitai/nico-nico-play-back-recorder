// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import SettingsModal from '@/entrypoints/content/settings-modal'
import { getUsage, clearAll } from '@/utils/library/api'
import { MAX_STORAGE_SIZE, RESOLUTION_MODE, FIXED_RESOLUTION_HEIGHT, RECORD_VIDEO, RECORD_WITH_COMMENTS } from '@/utils/storage'

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
    vi.mocked(clearAll).mockClear()
    document.body.innerHTML = '<div id="playbackRecorderBar"></div><button id="settingsButton"></button>'
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

    it('他のタブで設定が変わったら、開いている設定画面と覚えている値を合わせる（古い上限を書き戻さない）', async () => {
        modal.show()
        await flush()

        await MAX_STORAGE_SIZE.setValue(50 * GB) // 他のタブで上限を上げた
        await flush()
        expect(slider('storageRange').value).toBe(String(50 * GB))
        expect(document.getElementById('storageGB')?.textContent).toBe('50')

        // ホイールで1つ下げると、50 GB から下げる（このタブを開いた時の 1 GB からではない）
        slider('storageRange').dispatchEvent(new WheelEvent('wheel', { deltaY: 1, cancelable: true }))
        await flush()
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(49 * GB)
    })

    it('録画を区切る間隔は設定にない（内部で区切る）', () => {
        modal.show()

        expect(document.getElementById('intervalRange')).toBeNull()
    })

    it('画面の中央にダイアログで開き、もう一度押す・閉じるボタン・Esc・ダイアログの外のクリックで閉じる', () => {
        modal.show()
        const dialog = document.getElementById('settingsModal')!
        expect(dialog.tagName).toBe('DIALOG')
        expect(dialog.parentElement).toBe(document.body) // 録画バーの中ではなく、ページの上に開く
        expect(document.getElementById('settingsButton')?.getAttribute('aria-expanded')).toBe('true')

        modal.show()
        expect(document.getElementById('settingsModal')).toBeNull()
        expect(document.getElementById('settingsButton')?.getAttribute('aria-expanded')).toBe('false')

        modal.show()
        ;(document.querySelector('.npr-settings-close') as HTMLButtonElement).click()
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show()
        document.getElementById('settingsModal')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) // 暗くした所
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show()
        ;(document.querySelector('.npr-settings-body') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) // ダイアログの中
        expect(document.getElementById('settingsModal')).not.toBeNull()
    })

    describe('録画する種類', () => {
        const checkbox = (id: string) => document.getElementById(id) as HTMLInputElement
        const toggle = (id: string) => {
            checkbox(id).checked = !checkbox(id).checked
            checkbox(id).dispatchEvent(new Event('change'))
        }

        it('コメントなし・コメントありを選べ、選ぶと保存する（録画バーのチップと同じ設定）', async () => {
            modal.show()
            expect([checkbox('recordVideoCheckbox').checked, checkbox('recordCommentsCheckbox').checked]).toEqual([true, false])

            toggle('recordCommentsCheckbox')
            await flush()

            expect(await RECORD_WITH_COMMENTS.getValue()).toBe(true)
        })

        it('コメントなし・コメントありの両方は外せない（少なくとも1つは録る）', async () => {
            modal.show()

            toggle('recordVideoCheckbox')
            await flush()

            expect(checkbox('recordVideoCheckbox').checked).toBe(true)
            expect(await RECORD_VIDEO.getValue()).toBe(true)
            expect(document.querySelector('.npr-kinds-message')?.textContent).toContain('少なくとも1つ')
        })

        it('録画バーのチップで切り替えたら、開いている設定画面も合わせる', async () => {
            modal.show()

            await RECORD_WITH_COMMENTS.setValue(true)
            await flush()

            expect(checkbox('recordCommentsCheckbox').checked).toBe(true)
        })

        it('画面録画はスイッチにせず、録画バーの「画面録画」で始めることだけ説明する', async () => {
            modal.close()
            modal = new SettingsModal({ screenCaptureSupported: true })
            await flush()
            modal.show()

            expect(document.getElementById('recordScreenCheckbox')).toBeNull()
            expect(document.querySelectorAll('[aria-labelledby="nprKindsTitle"] input[type="checkbox"]')).toHaveLength(2)
            expect(document.querySelector('.npr-kind-screen')?.textContent).toContain('録画バーの「画面録画」を押して始めます')
        })

        it('画面録画を使えない環境では、使えないことだけ出す', () => {
            modal.show()

            expect(document.querySelector('.npr-kind-screen')?.textContent).toContain('この環境では使えません')
        })
    })

    it('すべての録画を削除する前に確かめる（やめたら削除しない）', async () => {
        const confirm = vi.spyOn(window, 'confirm')
        modal.show()
        const button = document.getElementById('clearButton') as HTMLButtonElement

        confirm.mockReturnValueOnce(false)
        button.click()
        await flush()
        expect(clearAll).not.toHaveBeenCalled()

        confirm.mockReturnValueOnce(true)
        button.click()
        await flush()
        expect(clearAll).toHaveBeenCalledTimes(1)
        confirm.mockRestore()
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
