// @vitest-environment happy-dom
// 録画を見る画面の保存のボタン: スクリーンショット・この場面の前後を動画で保存
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountReviewView } from '@/utils/review/view'
import type { Timeline } from '@/utils/review/timeline'
import type { TimelineFragment, TimelineSegment } from '@/utils/library/db'
import { downloadBlob } from '@/utils/feature'
import { buildClipFile, type ClipFile } from '@/utils/review/clip'

vi.mock('@/utils/feature', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/utils/feature')>()), downloadBlob: vi.fn() }))
vi.mock('@/utils/review/clip', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/utils/review/clip')>()), buildClipFile: vi.fn() }))

type FakePlayer = { timeline: Timeline, position: number, seek: ReturnType<typeof vi.fn> }
const players: FakePlayer[] = []
vi.mock('@/utils/review/player', () => ({
    createReviewPlayer: vi.fn(({ timeline }: { timeline: Timeline }) => {
        const player: FakePlayer & { destroy: () => void, update: () => void, cacheFragment: () => void } = {
            timeline, position: 0,
            seek: vi.fn((t: number) => { player.position = Math.min(Math.max(t, timeline.start), timeline.end) }),
            destroy: () => {}, update: () => {}, cacheFragment: () => {},
        }
        players.push(player)
        return player
    }),
}))

const fragments = (count: number): TimelineFragment[] =>
    Array.from({ length: count }, (_, i) => ({ index: i, startTime: i * 3, duration: 3, keyframe: true }))
const segment = (kind: 'video' | 'comments', startedAt: number, count: number): TimelineSegment => ({
    segmentId: 'A', kind, mimeType: 'video/mp4', startedAt, endedAt: null, init: new Blob(['init']), fragments: fragments(count),
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const current = () => players[players.length - 1]
const at930 = new Date(2026, 9, 21, 9, 30, 0).getTime()

// root: 画面を作る所（プレイバックの窓の代わりに、iframe の中にも作れる）
const mount = async (kind: 'video' | 'comments', readFragments = async () => [] as (Blob | null)[], root = document.getElementById('root')!) => {
    const view = mountReviewView({
        root, mode: 'library', readTimeline: async () => [segment(kind, at930, 30)], readFragments, screenshotName: () => 'user_title',
    })
    await flush()
    const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!
    return { root, view, $, flashText: () => $<HTMLElement>('.flash').textContent }
}

beforeEach(() => {
    players.length = 0
    vi.mocked(downloadBlob).mockClear()
    vi.mocked(buildClipFile).mockReset()
    document.body.innerHTML = '<div id="root"></div>'
})
// テストが途中で失敗しても、差し替えた canvas・console を次のテストに残さない
afterEach(() => {
    vi.restoreAllMocks()
})

describe('スクリーンショット', () => {
    it('今表示している場面を、録画の解像度の PNG で、配信者_タイトル_場面の時刻 の名前で保存する', async () => {
        const drawImage = vi.fn()
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback) { callback(new Blob(['png'], { type: 'image/png' })) })
        const { root, view, $, flashText } = await mount('comments')
        const video = root.querySelector('video')!
        Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true })
        Object.defineProperty(video, 'videoWidth', { get: () => 1280, configurable: true })
        Object.defineProperty(video, 'videoHeight', { get: () => 720, configurable: true })
        current().seek(6)

        $<HTMLButtonElement>('.shot').click()

        expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1280, 720)
        // 時刻は、保存した時ではなく場面の時刻。コメントなし以外は種類を付ける（録画一覧の「保存」と同じ）
        // ボタンを押したページ（プレイバックでは窓）でダウンロードを始める
        expect(downloadBlob).toHaveBeenCalledWith(expect.anything(), 'user_title_2026-10-21 093006_コメントあり.png', document)
        expect(flashText()).toBe('スクリーンショットを保存しました')
        view.destroy()
    })

    it('場面の読み込み中は、保存せずにお知らせする', async () => {
        const { view, $, flashText } = await mount('video')

        $<HTMLButtonElement>('.shot').click()

        expect(downloadBlob).not.toHaveBeenCalled()
        expect(flashText()).toBe('読み込み中です。少し待ってから押してください')
        view.destroy()
    })

    it('録画がない時は、保存のボタンを押せないように見せる', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => [], readFragments: async () => [] })
        await flush()
        expect(root.querySelector('.shot')!.getAttribute('aria-disabled')).toBe('true')
        expect(root.querySelector('.clip')!.getAttribute('aria-disabled')).toBe('true')
        view.destroy()
    })
})

describe('この場面の前後を動画で保存', () => {
    it('見ている場面の前後30秒ずつを切り出して、配信者_タイトル_切り出した始めの時刻 の名前で保存する', async () => {
        const clip = new Blob(['mp4'])
        vi.mocked(buildClipFile).mockResolvedValue({ blob: clip, startedAt: new Date(2026, 9, 21, 9, 30, 36).getTime(), duration: 60.2 })
        const readFragments = async () => []
        const { view, $, flashText } = await mount('video', readFragments)
        current().seek(66)

        $<HTMLButtonElement>('.clip').click()
        expect(flashText()).toBe('動画を作っています…')
        await flush()

        expect(buildClipFile).toHaveBeenCalledWith(current().timeline, 66, 30, readFragments)
        expect(downloadBlob).toHaveBeenCalledWith(clip, 'user_title_2026-10-21 093036.mp4', document)
        expect(flashText()).toBe('60秒の動画を保存しました')
        view.destroy()
    })

    it('作っている間は、もう一度押しても作らない（フォーカスは外さない）', async () => {
        let finish: (file: ClipFile) => void = () => {}
        vi.mocked(buildClipFile).mockReturnValue(new Promise(resolve => { finish = resolve }))
        const { view, $, flashText } = await mount('comments')
        const button = $<HTMLButtonElement>('.clip')

        button.click()
        button.click()
        expect(buildClipFile).toHaveBeenCalledTimes(1)
        expect(button.getAttribute('aria-disabled')).toBe('true')
        expect(button.disabled).toBe(false)

        // 作っている間にスクリーンショットのお知らせが出ても、消える時に「作っています」へ戻す
        vi.useFakeTimers()
        $<HTMLButtonElement>('.shot').click()
        vi.advanceTimersByTime(2500)
        expect(flashText()).toBe('動画を作っています…')
        vi.useRealTimers()

        finish({ blob: new Blob(['mp4']), startedAt: at930, duration: 30 })
        await flush()
        expect(downloadBlob).toHaveBeenCalledWith(expect.anything(), 'user_title_2026-10-21 093000_コメントあり.mp4', document)
        expect(flashText()).toBe('30秒の動画を保存しました')
        expect(button.hasAttribute('aria-disabled')).toBe(false)
        view.destroy()
    })

    it('作れなかった時と、切り出せる録画がなかった時はお知らせする', async () => {
        const { view, $, flashText } = await mount('video')
        vi.spyOn(console, 'error').mockImplementation(() => {})

        vi.mocked(buildClipFile).mockRejectedValueOnce(new Error('broken'))
        $<HTMLButtonElement>('.clip').click()
        await flush()
        expect(flashText()).toBe('動画を保存できませんでした')

        vi.mocked(buildClipFile).mockResolvedValueOnce(null)
        $<HTMLButtonElement>('.clip').click()
        await flush()
        expect(flashText()).toBe('保存できる場面がありません')
        expect(downloadBlob).not.toHaveBeenCalled()
        view.destroy()
    })

    it('ダウンロードは、ボタンを押したページ（プレイバックの窓）で始める', async () => {
        vi.mocked(buildClipFile).mockResolvedValue({ blob: new Blob(['mp4']), startedAt: at930, duration: 30 })
        const iframe = document.createElement('iframe')
        document.body.append(iframe)
        const pipDocument = iframe.contentDocument!
        const root = pipDocument.createElement('div')
        pipDocument.body.append(root)
        const { view, $ } = await mount('video', undefined, root)

        $<HTMLButtonElement>('.clip').click()
        await flush()

        expect(vi.mocked(downloadBlob).mock.lastCall?.[2]).toBe(pipDocument)
        expect(pipDocument).not.toBe(document)
        view.destroy()
    })
})

describe('保存のボタンのフォーカス', () => {
    it('マウスで押してもフォーカスを移さない（押した後のスペースで、もう一度保存されないように）', async () => {
        const { view, $ } = await mount('video')
        for (const selector of ['.shot', '.clip']) {
            const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
            $<HTMLButtonElement>(selector).dispatchEvent(event)
            expect(event.defaultPrevented).toBe(true)
        }
        view.destroy()
    })
})
