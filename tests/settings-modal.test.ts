// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import SettingsModal from '@/entrypoints/content/settings-modal'
import { getStorageUsage } from '@/hooks/indexedDB/recordingDB'
import { MAX_STORAGE_SIZE, RESTART_MEDIARECORDER_INTERVAL_MS } from '@/utils/storage'

vi.mock('@/hooks/indexedDB/recordingDB', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/hooks/indexedDB/recordingDB')>()
    return { ...actual, getStorageUsage: vi.fn(async () => 2 * GB) }
})

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
    vi.mocked(getStorageUsage).mockClear()
    document.body.innerHTML = '<div id="recordedMovieAria"></div>'
    modal = new SettingsModal()
    await flush() // 設定の読み込みを待つ
})

afterEach(() => {
    modal.close()
})

describe('設定画面', () => {
    it('ページを開いただけでは録画を全件読んで使用量を数えず、設定画面を開いた時に数える', async () => {
        expect(getStorageUsage).not.toHaveBeenCalled()

        modal.show()
        await flush()

        expect(getStorageUsage).toHaveBeenCalled()
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
        moveSlider('intervalRange', 10 * 60 * 1000, 'input')
        await flush()
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(1 * GB)
        expect(await RESTART_MEDIARECORDER_INTERVAL_MS.getValue()).toBe(1 * 60 * 1000)
        expect(document.getElementById('intervalMinutes')?.textContent).toBe('10')

        moveSlider('storageRange', 5 * GB, 'change')
        moveSlider('intervalRange', 10 * 60 * 1000, 'change')
        await flush()
        expect(await MAX_STORAGE_SIZE.getValue()).toBe(5 * GB)
        expect(await RESTART_MEDIARECORDER_INTERVAL_MS.getValue()).toBe(10 * 60 * 1000)
    })

    it('ラベルが入力欄と結び付いている（for 属性）', () => {
        modal.show()

        expect(document.querySelector('label[for="storageRange"]')).not.toBeNull()
        expect(document.querySelector('label[htmlFor]')).toBeNull()
    })
})
