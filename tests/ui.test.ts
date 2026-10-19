// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertRecorderBar, setRecorderState, setKindChips, showBarHint, setScreenCaptureButton, setPlaybackButton, getTimeString } from '@/utils/ui'
import { isPlaybackSupported } from '@/utils/review/window'
import { getProgramData } from '@/utils/feature'

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!

const options = (overrides: Partial<Parameters<typeof insertRecorderBar>[0]> = {}) => ({
    start: vi.fn(),
    stop: vi.fn(),
    showSettings: vi.fn(),
    toggleKind: vi.fn(),
    toggleScreenCapture: null,
    togglePlayback: null,
    openRecordings: vi.fn(),
    ...overrides,
})

beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div class="___control-area___x"></div>'
})

describe('録画バー', () => {
    it('プレイヤーの操作部分の下に作り、初めは「準備中」で録画開始を押せない', () => {
        insertRecorderBar(options())

        const bar = $('#playbackRecorderBar')
        expect(bar.previousElementSibling?.className).toContain('control-area')
        expect(bar.dataset.state).toBe('preparing')
        expect($('#recordStatus').textContent).toBe('準備中')
        expect($<HTMLButtonElement>('#recordButton').disabled).toBe(true)
    })

    it('最近の録画の列は置かない（録画は録画一覧のページで見る）', () => {
        insertRecorderBar(options())

        expect(document.querySelector('.recordedMovieBox, .recordedMovie, #video-modal')).toBeNull()
    })

    it('録画開始と停止は1つのボタンで切り替わる', () => {
        const start = vi.fn()
        const stop = vi.fn()
        insertRecorderBar(options({ start, stop }))
        const button = $<HTMLButtonElement>('#recordButton')

        setRecorderState('stopped')
        expect(button.textContent?.trim()).toBe('録画開始')
        button.click()
        expect(start).toHaveBeenCalledTimes(1)

        setRecorderState('recording')
        expect($('#recordStatus').textContent).toBe('録画中')
        expect(button.textContent?.trim()).toBe('停止')
        button.click()
        expect(stop).toHaveBeenCalledTimes(1)
    })

    it('保存エラーの時は、バーを赤くして理由を出す（録る種類のチップは隠す）', () => {
        insertRecorderBar(options())

        setRecorderState('error')

        expect($('#playbackRecorderBar').dataset.state).toBe('error')
        expect($('#recordStatus').textContent).toBe('保存エラー')
        expect($('#recorderError').textContent).toContain('空き容量が足りず録画を止めました')
        expect($<HTMLButtonElement>('#recordButton').disabled).toBe(false) // もう一度録画を始められる
    })

    it('録る種類のチップは設定の通りに押された表示になり、押すと切り替えの処理を呼ぶ', () => {
        const toggleKind = vi.fn()
        insertRecorderBar(options({ toggleKind }))

        setKindChips({ video: true, comments: false })
        expect($('.npr-chip[data-kind="video"]').getAttribute('aria-pressed')).toBe('true')
        expect($('.npr-chip[data-kind="comments"]').getAttribute('aria-pressed')).toBe('false')

        $<HTMLButtonElement>('.npr-chip[data-kind="comments"]').click()
        expect(toggleKind).toHaveBeenCalledWith('comments')
    })

    it('短いお知らせを出せる', () => {
        insertRecorderBar(options())

        showBarHint('少なくとも1つは録画します')

        expect($('.npr-hint').textContent).toBe('少なくとも1つは録画します')
        expect($('.npr-hint').classList.contains('is-visible')).toBe(true)
    })

    it('録画一覧・設定・スクリーンショットのボタン', () => {
        const openRecordings = vi.fn()
        const showSettings = vi.fn()
        insertRecorderBar(options({ openRecordings, showSettings }))

        $<HTMLButtonElement>('#recordingsButton').click()
        $<HTMLButtonElement>('#settingsButton').click()

        expect($('#recordingsButton').textContent?.trim()).toBe('録画一覧')
        expect(openRecordings).toHaveBeenCalledTimes(1)
        expect(showSettings).toHaveBeenCalledTimes(1)
        expect($('#capButton').getAttribute('aria-label')).toBe('スクリーンショット')
    })

    describe('演出あり（画面ごとの録画）のチップ', () => {
        it('使えない環境では出さない', () => {
            insertRecorderBar(options())

            expect($<HTMLButtonElement>('#screenCaptureButton').hidden).toBe(true)
        })

        it('使える環境では出し、押すと切り替えの処理を呼ぶ。録画中は押された表示になる', () => {
            const toggleScreenCapture = vi.fn()
            insertRecorderBar(options({ toggleScreenCapture }))
            const chip = $<HTMLButtonElement>('#screenCaptureButton')

            expect(chip.hidden).toBe(false)
            expect(chip.querySelector('.npr-long')?.firstChild?.textContent).toBe('演出あり')
            chip.click()
            expect(toggleScreenCapture).toHaveBeenCalledTimes(1)

            setScreenCaptureButton('on')
            expect(chip.getAttribute('aria-pressed')).toBe('true')
            setScreenCaptureButton('off')
            expect(chip.getAttribute('aria-pressed')).toBe('false')
        })

        it('設定で「演出あり」を選んでいて、まだ始めていない時は、押すよう促す表示にする', () => {
            insertRecorderBar(options({ toggleScreenCapture: vi.fn() }))
            const chip = $<HTMLButtonElement>('#screenCaptureButton')

            setScreenCaptureButton('ready')

            expect(chip.classList.contains('is-ready')).toBe(true)
            expect(chip.getAttribute('aria-pressed')).toBe('false')
            expect(chip.title).toContain('クリックして')
            setScreenCaptureButton('on')
            expect(chip.classList.contains('is-ready')).toBe(false)
        })
    })

    describe('プレイバックのボタン', () => {
        it('この環境（Document Picture-in-Picture がない）では使えないと判定し、ボタンを出さない', () => {
            expect(isPlaybackSupported()).toBe(false)
            insertRecorderBar(options())

            expect($<HTMLButtonElement>('#playbackButton').hidden).toBe(true)
        })

        it('使える環境では出し、押すとウィンドウを開く処理を呼ぶ。開いている間は押された表示になる', () => {
            const togglePlayback = vi.fn()
            insertRecorderBar(options({ togglePlayback }))
            const button = $<HTMLButtonElement>('#playbackButton')

            expect(button.hidden).toBe(false)
            expect(button.textContent?.trim()).toBe('プレイバック')
            button.click()
            expect(togglePlayback).toHaveBeenCalledTimes(1)

            setPlaybackButton(true)
            expect(button.getAttribute('aria-pressed')).toBe('true')
            setPlaybackButton(false)
            expect(button.getAttribute('aria-pressed')).toBe('false')
        })
    })
})

describe('getTimeString（録画時間）', () => {
    it('1時間までは分:秒、それより長ければ時:分:秒', () => {
        const now = Date.now()
        vi.spyOn(Date, 'now').mockReturnValue(now)

        expect(getTimeString(now - 65 * 1000)).toBe('1:05')
        expect(getTimeString(now - (3600 + 125) * 1000)).toBe('1:02:05')
        vi.restoreAllMocks()
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
