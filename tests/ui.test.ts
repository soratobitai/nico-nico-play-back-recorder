// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModal, openModalWithVideo, insertRecordedMovie } from '@/utils/ui'
import { getProgramData } from '@/utils/feature'
import { getSegmentFile } from '@/utils/library/api'
import type { SegmentSummary } from '@/utils/library/db'

// 保存先（拡張機能側）の代わり
vi.mock('@/utils/library/api', () => ({
    getSegmentFile: vi.fn(),
    listSegments: vi.fn(async () => []),
    countSegments: vi.fn(async () => 0),
    deleteSegments: vi.fn(),
}))

const summary = (segmentId: string, startedAt: number, userName = 'user', title = 'title'): SegmentSummary => ({
    segmentId, programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', title, userName,
    startedAt, endedAt: startedAt + 1000, thumbnail: 'data:image/jpeg;base64,THUMB', bytes: 1, fragmentCount: 1, duration: 1,
})

const saved = new Map<string, SegmentSummary>()
const putRecording = (segmentId: string, startedAt: number, userName: string, title: string) => {
    saved.set(segmentId, summary(segmentId, startedAt, userName, title))
}

const byId = (id: string) => document.getElementById(id)!

beforeEach(async () => {
    saved.clear()
    vi.mocked(getSegmentFile).mockImplementation(async (segmentId: string) => ({ blob: new Blob([segmentId]), segment: saved.get(segmentId)! }))
    document.head.innerHTML = ''
    document.body.innerHTML = '<div id="recordedMovieAria"><div class="recordedMovieBox"></div></div>'
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('再生用のモーダル', () => {
    beforeEach(() => {
        createModal()
        let n = 0
        vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:video-${++n}`)
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    })

    it('日付・ユーザー名・タイトルを文字列として表示する（HTML として解釈しない）', async () => {
        await putRecording('A', new Date(2025, 0, 2, 3, 4, 5).getTime(), '<b>user</b>', 'タイトル')

        await openModalWithVideo('A', document.body)

        expect(byId('modal-user-name').textContent).toBe('2025-01-02 03:04:05 <b>user</b>')
        expect(byId('modal-user-name').querySelector('b')).toBeNull()
        expect(byId('modal-title').textContent).toBe('タイトル')
    })

    it('ユーザー名やタイトルがない動画を開くと、前の動画の表示を残さない', async () => {
        await putRecording('A', 1000, 'user-A', 'title-A')
        await putRecording('B', 2000, '', '')

        await openModalWithVideo('A', document.body)
        await openModalWithVideo('B', document.body)

        expect(byId('modal-user-name').textContent).not.toContain('user-A')
        expect(byId('modal-title').textContent).toBe('')
    })

    it('別の動画に切り替えた時と閉じた時に、前の動画の URL を解放する', async () => {
        await putRecording('A', 1000, 'user', 'title')
        await putRecording('B', 2000, 'user', 'title')
        const video = byId('video-player') as HTMLVideoElement

        await openModalWithVideo('A', document.body)
        expect(video.getAttribute('src')).toBe('blob:video-1')

        await openModalWithVideo('B', document.body)
        expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:video-1')
        expect(video.getAttribute('src')).toBe('blob:video-2')

        byId('close-modal').click()
        expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:video-2')
        expect(video.hasAttribute('src')).toBe(false)
    })
})

describe('録画一覧', () => {
    const startedAtList = () =>
        Array.from(document.querySelectorAll<HTMLElement>('.recordedMovie')).map(element => Number(element.dataset.startedAt))

    it('右端に追加する録画は、保存の完了順が前後しても開始時刻の順に並べる', () => {
        insertRecordedMovie(summary('A', 1000), 'end')
        insertRecordedMovie(summary('C', 3000), 'end')
        insertRecordedMovie(summary('B', 2000), 'end') // 先に始めた録画の保存が後で終わった

        expect(startedAtList()).toEqual([1000, 2000, 3000])
    })

    it('同じ録画をもう一度追加すると、重ねずに置き換える', () => {
        insertRecordedMovie(summary('A', 1000, 'old'), 'end')
        insertRecordedMovie(summary('A', 1000, 'new'), 'end')

        expect(startedAtList()).toEqual([1000])
    })
})

describe('getProgramData', () => {
    it('番組情報からユーザー名とタイトルを取り、ファイル名に使えない文字を除く', () => {
        document.head.innerHTML = `
            <script type="application/ld+json">{"author": {"name": "user/name"}}</script>
            <meta property="og:title" content="title:1">`

        expect(getProgramData()).toEqual({ userName: 'username', title: 'title1' })
    })

    it('番組情報がない・壊れているページでも例外にならず、ユーザー名を空にする', () => {
        document.head.innerHTML = '<script type="application/ld+json">{ broken</script>'
        expect(getProgramData().userName).toBe('')

        document.head.innerHTML = ''
        expect(getProgramData().userName).toBe('')
    })
})
