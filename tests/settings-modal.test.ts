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
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const wheel = (deltaY: number, init: WheelEventInit = {}) => {
    const event = new WheelEvent('wheel', { deltaY, cancelable: true, ...init })
    // happy-dom の WheelEvent は ctrlKey を受け取らないので付ける
    if (init.ctrlKey) Object.defineProperty(event, 'ctrlKey', { value: true })
    return slider('storageRange').dispatchEvent(event)
}
const dialog = () => document.getElementById('settingsModal')!
// 暗くした所（ダイアログ自身）で押して離す
const clickBackdrop = (detail = 1) => {
    dialog().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    dialog().dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true, detail }))
}
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
        slider('storageRange').focus()
        wheel(100)
        await wait(700)
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(49 * GB)
    })

    describe('容量の上限を今の使用量より下げる時（超えた分の古い録画がすぐに消える）', () => {
        // 使用量は 2 GB（getUsage の代わり）。上限を 1 GB に下げると 1 GB 分消える
        beforeEach(async () => {
            await MAX_STORAGE_SIZE.setValue(10 * GB)
            await flush()
            modal.show()
            await flush()
        })

        it('確かめて、やめたら保存せずにスライダーを元に戻す', async () => {
            const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
            moveSlider('storageRange', 1 * GB, 'change')
            await flush()

            expect(confirm).toHaveBeenCalledWith(expect.stringContaining('削除されます'))
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(10 * GB)
            expect(slider('storageRange').value).toBe(String(10 * GB))
            expect(document.getElementById('storageGB')?.textContent).toBe('10')
            confirm.mockRestore()
        })

        it('よければ保存する。使用量より上なら確かめない', async () => {
            const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
            moveSlider('storageRange', 1 * GB, 'change')
            await flush()
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(1 * GB)

            moveSlider('storageRange', 3 * GB, 'change')
            await flush()
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(3 * GB)
            expect(confirm).toHaveBeenCalledTimes(1)
            confirm.mockRestore()
        })
    })

    it('使用量が分からない間（読み込めなかった）に上限を下げる時も、量を書かずに確かめる', async () => {
        vi.mocked(getUsage).mockRejectedValueOnce(new Error('unavailable'))
        await MAX_STORAGE_SIZE.setValue(10 * GB)
        await flush()
        modal.show()
        await flush()
        const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)

        moveSlider('storageRange', 1 * GB, 'change')
        await flush()

        expect(confirm).toHaveBeenCalledWith(expect.stringContaining('削除されることがあります'))
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(10 * GB)
        confirm.mockRestore()
    })

    describe('容量の上限のスライダーのホイール（上限を下げると古い録画が消えるので、うっかり動かさない）', () => {
        beforeEach(async () => {
            await MAX_STORAGE_SIZE.setValue(30 * GB)
            await flush()
            modal.show()
            await flush()
        })

        it('スライダーを選んでいない時は、上を通ってスクロールしても動かさない', async () => {
            for (let i = 0; i < 10; i++) wheel(100)
            await wait(700)

            expect(slider('storageRange').value).toBe(String(30 * GB))
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(30 * GB)
        })

        it('選んでいる時は、ホイール1回で1目盛り。タッチパッドの細かい動きは足し合わせ、横のスクロールでは動かさない', async () => {
            slider('storageRange').focus()
            for (let i = 0; i < 10; i++) wheel(4) // 40 ピクセル分では、まだ動かさない
            wheel(0, { deltaX: 100 })
            expect(slider('storageRange').value).toBe(String(30 * GB))

            wheel(-100)
            wheel(-100)
            expect(slider('storageRange').value).toBe(String(31 * GB)) // 40 + (-200) = -160 → 1目盛り上げる
            await wait(700) // 保存を待つ（次のテストに持ち越さない）
        })

        it('ホイールで動かした後につまんで動かし始めたら、その前に保存しておく（動かしている途中の値で保存しない）', async () => {
            slider('storageRange').focus()
            wheel(100)
            slider('storageRange').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
            await flush()
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(29 * GB)

            moveSlider('storageRange', 5 * GB, 'input') // つまんで動かしている途中
            await wait(700)
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(29 * GB)
        })

        it('ホイールで動かしてすぐ閉じたら、閉じる時に保存する（閉じた後に古い値で保存しない）', async () => {
            slider('storageRange').focus()
            wheel(100)
            modal.close()
            await flush()
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(29 * GB)
        })

        it('Ctrl+ホイール（拡大・縮小）では動かさない', () => {
            slider('storageRange').focus()
            wheel(100, { ctrlKey: true })
            expect(slider('storageRange').value).toBe(String(30 * GB))
        })

        it('動かしている間は保存せず、動かし終えてから1回だけ保存する', async () => {
            slider('storageRange').focus()
            wheel(100)
            wheel(100)
            await flush()
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(30 * GB)

            await wait(700)
            expect(await MAX_STORAGE_SIZE.getValue()).toBe(28 * GB)
        })
    })

    it('録画を区切る間隔は設定にない（内部で区切る）', () => {
        modal.show()

        expect(document.getElementById('intervalRange')).toBeNull()
    })

    it('画面の中央にダイアログで開き、もう一度押す・閉じるボタン・Esc・ダイアログの外のクリックで閉じる', () => {
        modal.show()
        expect(dialog().tagName).toBe('DIALOG')
        expect(dialog().parentElement).toBe(document.body) // 録画バーの中ではなく、ページの上に開く
        expect(document.getElementById('settingsButton')?.getAttribute('aria-expanded')).toBe('true')

        modal.show()
        expect(document.getElementById('settingsModal')).toBeNull()
        expect(document.getElementById('settingsButton')?.getAttribute('aria-expanded')).toBe('false')

        modal.show()
        ;(document.querySelector('.npr-settings-close') as HTMLButtonElement).click()
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show()
        dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show()
        clickBackdrop()
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show()
        ;(document.querySelector('.npr-settings-body') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) // ダイアログの中
        expect(document.getElementById('settingsModal')).not.toBeNull()
    })

    it('開いている間のキー操作はページに伝えない（スペースでプレイヤーが一時停止したり、↑↓で音量が変わったりしないように）', () => {
        const pageKeys = vi.fn()
        document.addEventListener('keydown', pageKeys)
        modal.show()

        for (const key of [' ', 'ArrowUp', 'ArrowDown']) dialog().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))

        expect(pageKeys).not.toHaveBeenCalled()
        expect(document.getElementById('settingsModal')).not.toBeNull()
        document.removeEventListener('keydown', pageKeys)
    })

    it('設定画面の中で押して、暗くした所で離しても閉じない（文字を選んでいた時など）', () => {
        modal.show()

        document.querySelector('.npr-settings-body')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
        dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }))

        expect(document.getElementById('settingsModal')).not.toBeNull()
    })

    it('暗くした所で押して、設定画面の中で離しても閉じない', () => {
        modal.show()

        dialog().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
        document.querySelector('.npr-settings-body')!.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
        dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }))

        expect(document.getElementById('settingsModal')).not.toBeNull()
    })

    it('開いている時に暗くした所の歯車をダブルクリックしたら、1回目で閉じて、2回目ではまた開かない', () => {
        modal.show()
        clickBackdrop(1)
        expect(document.getElementById('settingsModal')).toBeNull()

        modal.show(new MouseEvent('click', { detail: 2 }))
        expect(document.getElementById('settingsModal')).toBeNull()
        modal.show(new MouseEvent('click', { detail: 1 }))
        expect(document.getElementById('settingsModal')).not.toBeNull()
    })

    it('歯車のダブルクリックの2回目は、開いたダイアログに当たっても無視する（すぐ閉じたり、設定を変えたりしない）', () => {
        modal.show()

        clickBackdrop(2)
        expect(document.getElementById('settingsModal')).not.toBeNull()
        const comments = document.getElementById('recordCommentsCheckbox') as HTMLInputElement
        comments.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }))
        expect(comments.checked).toBe(false)

        // ふつうのクリックは効く
        clickBackdrop(1)
        expect(document.getElementById('settingsModal')).toBeNull()
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

        it('他のタブの設定画面で変えたら、開いている設定画面も合わせる', async () => {
            modal.show()

            await RECORD_WITH_COMMENTS.setValue(true)
            await flush()

            expect(checkbox('recordCommentsCheckbox').checked).toBe(true)
        })

        it('変えた種類を、設定画面を開いたタブに知らせる（そのタブにもすぐ使う）', async () => {
            modal.close()
            const onRecordKindsChange = vi.fn()
            modal = new SettingsModal({ onRecordKindsChange })
            await flush()
            modal.show()

            toggle('recordCommentsCheckbox')
            await flush()
            expect(onRecordKindsChange).toHaveBeenLastCalledWith({ video: true, comments: true })

            // 両方は外せない（知らせない）
            toggle('recordVideoCheckbox')
            toggle('recordCommentsCheckbox')
            await flush()
            expect(onRecordKindsChange).toHaveBeenLastCalledWith({ video: false, comments: true })
            expect(onRecordKindsChange).toHaveBeenCalledTimes(2)
        })

        it('閉じた時に知らせる（変えた種類を、閉じた時にタブの録画に反映する）', async () => {
            modal.close()
            const onClose = vi.fn()
            modal = new SettingsModal({ onClose })
            await flush()
            modal.show()
            expect(onClose).not.toHaveBeenCalled()
            modal.close()
            modal.close() // 閉じている時は知らせない
            expect(onClose).toHaveBeenCalledTimes(1)
        })

        it('画面録画はスイッチにせず、録画バーの「画面録画」で始めることだけ説明する', async () => {
            modal.close()
            modal = new SettingsModal({ screenCaptureSupported: true })
            await flush()
            modal.show()

            expect(document.getElementById('recordScreenCheckbox')).toBeNull()
            expect(document.querySelectorAll('[aria-labelledby="nprKindsTitle"] input[type="checkbox"]')).toHaveLength(2)
            expect(document.querySelector('.npr-kind-screen')?.textContent).toContain('録画バーの「画面録画」を押して始めます')
            // 画面のままを録るので、カーソルや重なったものも入ることを知らせる
            expect(document.querySelector('.npr-kind-screen')?.textContent).toContain('マウスのカーソルや、プレイヤーに重なって表示されたもの')
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
        it('初期値は「画質が変わった所で分ける」で、大きさは選べない', () => {
            modal.show()

            expect((document.getElementById('resolutionSplitRadio') as HTMLInputElement).checked).toBe(true)
            expect((document.getElementById('fixedResolutionSelect') as HTMLSelectElement).disabled).toBe(true)
        })

        it('「1本の録画にそろえる」を選ぶと保存され、大きさを選べるようになる', async () => {
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
