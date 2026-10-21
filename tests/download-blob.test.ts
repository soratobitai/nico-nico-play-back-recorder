// @vitest-environment happy-dom
// Blob のダウンロード: ボタンを押したページ（プレイバックの窓など）で始める。窓が閉じられていたら、このページで始める
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBlob } from '@/utils/feature'

let clicked: { document: Document, download: string }[] = []
beforeEach(() => {
    clicked = []
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
    it('指定したページで始める（指定しなければ、このページ）', () => {
        const iframe = document.createElement('iframe')
        document.body.append(iframe)
        const other = iframe.contentDocument!

        downloadBlob(new Blob(['a']), 'a.png', other)
        downloadBlob(new Blob(['b']), 'b.png')

        expect(clicked).toEqual([{ document: other, download: 'a.png' }, { document, download: 'b.png' }])
        expect(other.querySelector('a')).toBeNull()
    })

    it('指定したページが閉じられていたら（窓を閉じた後に作り終えた時など）、このページで始める', () => {
        const closed = document.implementation.createHTMLDocument('closed')

        downloadBlob(new Blob(['a']), 'a.mp4', closed)

        expect(clicked).toEqual([{ document, download: 'a.mp4' }])
    })
})
