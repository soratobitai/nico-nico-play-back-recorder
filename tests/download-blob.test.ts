// @vitest-environment happy-dom
// Blob のダウンロード: ニコ生のページ・プレイバックの窓からは、拡張機能のページ（bridge）で始める
// （ニコ生のサイトの「自動ダウンロード」がブロックでも、続けて保存できるように）。
// bridge を使えない時は、ボタンを押したページ（プレイバックでは窓）で始め、窓が閉じられていたら、このページで始める
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob } from '@/utils/feature'
import { handleBridgeRequest } from '@/utils/library/handler'
import * as client from '@/utils/library/client'

vi.mock('@/utils/library/client', () => ({ getBridge: vi.fn() }))

const call = vi.fn()
let clicked: { document: Document, download: string }[] = []
beforeEach(() => {
    clicked = []
    call.mockReset().mockResolvedValue(undefined)
    vi.mocked(client.getBridge).mockReset().mockResolvedValue({ call } as never)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push({ document: this.ownerDocument, download: this.download })
    })
})
afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
})

describe('downloadBlob', () => {
    it('拡張機能のページ（bridge）に保存を頼み、このページからは保存しない', async () => {
        const blob = new Blob(['a'])

        await downloadBlob(blob, 'a.png')

        expect(call).toHaveBeenCalledWith({ type: 'download', blob, filename: 'a.png' })
        expect(clicked).toEqual([])
    })

    it('bridge を使えない時（拡張機能が更新された後など）は、指定したページで始める（指定しなければ、このページ）', async () => {
        vi.mocked(client.getBridge).mockRejectedValue(new Error('unavailable'))
        const iframe = document.createElement('iframe')
        document.body.append(iframe)
        const other = iframe.contentDocument!

        await downloadBlob(new Blob(['a']), 'a.png', other)
        await downloadBlob(new Blob(['b']), 'b.png')

        expect(clicked).toEqual([{ document: other, download: 'a.png' }, { document, download: 'b.png' }])
        expect(other.querySelector('a')).toBeNull()
    })

    it('bridge で保存できず、指定したページも閉じられていたら（窓を閉じた後に作り終えた時など）、このページで始める', async () => {
        call.mockRejectedValue(new Error('broken'))
        const closed = document.implementation.createHTMLDocument('closed')

        await downloadBlob(new Blob(['a']), 'a.mp4', closed)

        expect(clicked).toEqual([{ document, download: 'a.mp4' }])
    })
})

describe('bridge での保存', () => {
    it('頼まれたファイルを、bridge のページで保存する', async () => {
        await handleBridgeRequest({ type: 'download', blob: new Blob(['a']), filename: 'a.png' })

        expect(clicked).toEqual([{ document, download: 'a.png' }])
    })

    it('ファイルの形がおかしい依頼は、保存せずにエラーにする', async () => {
        await expect(handleBridgeRequest({ type: 'download', blob: 'x' as unknown as Blob, filename: 'a.png' })).rejects.toThrow()
        await expect(handleBridgeRequest({ type: 'download', blob: new Blob(['a']), filename: '' })).rejects.toThrow()

        expect(clicked).toEqual([])
    })
})
