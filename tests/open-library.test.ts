// ライブラリのページを開く（既に開いていれば、そのページを使う）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { openLibrary, libraryUrl, SHOW_PROGRAM_MESSAGE } from '@/utils/library/open-library'

afterEach(() => {
    vi.restoreAllMocks()
    fakeBrowser.reset()
})

describe('openLibrary', () => {
    it('ライブラリのページが開いていれば、番組を表示してもらい、新しいタブは開かない', async () => {
        const send = vi.spyOn(chrome.runtime, 'sendMessage').mockResolvedValue(true as never)
        const create = vi.spyOn(chrome.tabs, 'create')

        await openLibrary('lv1')

        expect(send).toHaveBeenCalledWith({ type: SHOW_PROGRAM_MESSAGE, programId: 'lv1' })
        expect(create).not.toHaveBeenCalled()
    })

    it('開いていなければ、番組を選んだ状態で新しいタブに開く', async () => {
        vi.spyOn(chrome.runtime, 'sendMessage').mockRejectedValue(new Error('Receiving end does not exist.') as never)
        const create = vi.spyOn(chrome.tabs, 'create').mockResolvedValue(undefined as never)

        await openLibrary('lv1')

        expect(create).toHaveBeenCalledWith({ url: libraryUrl('lv1') })
        expect(libraryUrl('lv1')).toMatch(/\/library\.html#lv1$/)
        expect(libraryUrl()).toMatch(/\/library\.html$/)
    })
})
