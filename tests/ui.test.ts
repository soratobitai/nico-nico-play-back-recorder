// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChunk, deleteAllChunks } from '@/hooks/indexedDB/recordingDB'
import { createModal, openModalWithVideo, insertRecordedMovie } from '@/utils/ui'
import { getProgramData } from '@/utils/feature'

const putRecording = (sessionId: string, createdAt: number, userName: string | null, title: string | null) =>
    saveChunk('Chunks', sessionId, createdAt, new Blob([sessionId], { type: 'video/mp4' }), 'data:image/jpeg;base64,THUMB', createdAt, userName, title)

const byId = (id: string) => document.getElementById(id)!

beforeEach(async () => {
    await deleteAllChunks()
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

        await openModalWithVideo(['A', new Date(2025, 0, 2, 3, 4, 5).getTime()], document.body)

        expect(byId('modal-user-name').textContent).toBe('2025-01-02 03:04:05 <b>user</b>')
        expect(byId('modal-user-name').querySelector('b')).toBeNull()
        expect(byId('modal-title').textContent).toBe('タイトル')
    })

    it('ユーザー名やタイトルがない動画を開くと、前の動画の表示を残さない', async () => {
        await putRecording('A', 1000, 'user-A', 'title-A')
        await putRecording('B', 2000, null, null)

        await openModalWithVideo(['A', 1000], document.body)
        await openModalWithVideo(['B', 2000], document.body)

        expect(byId('modal-user-name').textContent).not.toContain('user-A')
        expect(byId('modal-title').textContent).toBe('')
    })

    it('別の動画に切り替えた時と閉じた時に、前の動画の URL を解放する', async () => {
        await putRecording('A', 1000, 'user', 'title')
        await putRecording('B', 2000, 'user', 'title')
        const video = byId('video-player') as HTMLVideoElement

        await openModalWithVideo(['A', 1000], document.body)
        expect(video.getAttribute('src')).toBe('blob:video-1')

        await openModalWithVideo(['B', 2000], document.body)
        expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:video-1')
        expect(video.getAttribute('src')).toBe('blob:video-2')

        byId('close-modal').click()
        expect(URL.revokeObjectURL).toHaveBeenLastCalledWith('blob:video-2')
        expect(video.hasAttribute('src')).toBe(false)
    })
})

describe('録画一覧', () => {
    const createdAtList = () =>
        Array.from(document.querySelectorAll<HTMLElement>('.recordedMovie')).map(element => Number(element.dataset.createdAt))
    const recording = (createdAt: number) => ({
        sessionId: `S${createdAt}`, chunkIndex: createdAt, blob: new Blob(), imgUrl: 'data:image/jpeg;base64,THUMB', createdAt, userName: 'user', title: 'title',
    })

    it('右端に追加する録画は、結合の完了順が前後しても作成時刻の順に並べる', async () => {
        await insertRecordedMovie(recording(1000), 'end')
        await insertRecordedMovie(recording(3000), 'end')
        await insertRecordedMovie(recording(2000), 'end') // 先に録画した区間の結合が後で終わった

        expect(createdAtList()).toEqual([1000, 2000, 3000])
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
