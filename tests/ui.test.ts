// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertRecorderBar, setRecorderState, setKindChips, setKindRecording, showBarHint, setScreenCaptureButton, setPlaybackButton, getTimeString } from '@/utils/ui'
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

    it('ダブルクリックの2回目は無視する（止めた録画をすぐにまた始めない）', () => {
        const start = vi.fn()
        const stop = vi.fn()
        insertRecorderBar(options({ start, stop }))
        const button = $<HTMLButtonElement>('#recordButton')
        setRecorderState('recording')

        button.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }))
        setRecorderState('stopped')
        button.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }))
        expect(stop).toHaveBeenCalledTimes(1)
        expect(start).not.toHaveBeenCalled()
    })

    it('バーのボタンの上で押したスペースは、ニコ生のショートカット（再生・一時停止）に届けない', () => {
        insertRecorderBar(options())
        const onWindow = vi.fn()
        window.addEventListener('keydown', onWindow)
        $<HTMLButtonElement>('#settingsButton').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
        $<HTMLButtonElement>('#settingsButton').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
        window.removeEventListener('keydown', onWindow)
        expect(onWindow.mock.calls.map(([event]) => event.key)).toEqual(['a'])
    })

    it('保存エラーの時は、バーを赤くして理由を出す（録る種類のチップは隠す）', () => {
        insertRecorderBar(options())

        setRecorderState('error')

        expect($('#playbackRecorderBar').dataset.state).toBe('error')
        expect($('#recordStatus').textContent).toBe('保存エラー')
        expect($('#recorderError').textContent).toContain('空き容量が足りず録画を止めました')
        expect($<HTMLButtonElement>('#recordButton').disabled).toBe(false) // もう一度録画を始められる
        // 理由は長いので、入り切らない時はマウスを乗せると全文が出る
        expect($('#recorderError').title).toContain('古い録画を削除するか')
    })

    it('状態と録画ボタンには説明を付ける（狭い時は文字を隠して丸やアイコンだけになるため）', () => {
        insertRecorderBar(options())
        setRecorderState('preparing')
        expect($('.npr-status').title).toContain('動画の読み込みを待っています')

        setRecorderState('recording')
        expect($('.npr-status').title).toBe('録画中')
        expect($('#recordButton').title).toBe('録画を止めます')
        setRecorderState('stopped')
        expect($('#recordButton').title).toBe('録画を始めます')
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

    it('録る種類のチップに、その種類を今録っているかを出す', () => {
        insertRecorderBar(options())
        const chip = (kind: string) => $(`.npr-chip[data-kind="${kind}"]`)
        expect([chip('video').dataset.recording, chip('comments').dataset.recording]).toEqual(['false', 'false'])

        setKindRecording({ video: true, comments: false })
        expect([chip('video').dataset.recording, chip('comments').dataset.recording]).toEqual(['true', 'false'])
        expect(chip('video').title).toContain('（録画中）')
        expect(chip('comments').title).not.toContain('（録画中）')

        setKindRecording({ video: false, comments: false })
        expect(chip('video').dataset.recording).toBe('false')
        expect(chip('video').title).not.toContain('（録画中）')
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

    describe('画面録画のボタン', () => {
        it('使えない環境では出さない', () => {
            insertRecorderBar(options())

            expect($<HTMLButtonElement>('#screenCaptureButton').hidden).toBe(true)
        })

        it('使える環境では出し、押すと切り替えの処理を呼ぶ。録画中は押された表示になる', () => {
            const toggleScreenCapture = vi.fn()
            insertRecorderBar(options({ toggleScreenCapture }))
            const chip = $<HTMLButtonElement>('#screenCaptureButton')

            expect(chip.hidden).toBe(false)
            expect(chip.textContent?.trim()).toBe('画面録画')
            expect(chip.closest('[role="group"]')).toBeNull() // 録る種類のチップとは別に置く
            chip.click()
            expect(toggleScreenCapture).toHaveBeenCalledTimes(1)

            setScreenCaptureButton(true)
            expect(chip.getAttribute('aria-pressed')).toBe('true')
            expect(chip.textContent?.trim()).toBe('画面録画中')
            // 読み上げの名前は「画面録画」のまま（「中」は見た目だけ。録っているかは「押されている」で伝わる）
            expect(chip.querySelector('.npr-screen-state')?.getAttribute('aria-hidden')).toBe('true')
            setScreenCaptureButton(false)
            expect(chip.getAttribute('aria-pressed')).toBe('false')
            expect(chip.textContent?.trim()).toBe('画面録画')
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

        expect(getProgramData()).toMatchObject({ userName: 'username', title: 'title1', beginAt: null })
    })

    it('番組 ID は、埋め込みデータの今の放送の番組 ID（チャンネルの URL で開いた時も lv…）。なければ URL から', () => {
        document.body.innerHTML = '<script id="embedded-data" data-props="{&quot;program&quot;:{&quot;nicoliveProgramId&quot;:&quot;lv351605487&quot;}}"></script>'
        history.replaceState(null, '', '/watch/ch2646230')
        expect(getProgramData().programId).toBe('lv351605487')

        document.body.innerHTML = ''
        history.replaceState(null, '', '/watch/lv123')
        expect(getProgramData().programId).toBe('lv123')
    })

    it('番組が始まった時刻を、埋め込みデータ（なければ番組情報の開始日時）から読む', () => {
        document.head.innerHTML = '<script type="application/ld+json">{"startDate": "2026-10-20T00:00:00+09:00"}</script>'
        document.body.innerHTML = '<script id="embedded-data" data-props="{&quot;program&quot;:{&quot;beginTime&quot;:1792422000}}"></script>'
        expect(getProgramData().beginAt).toBe(1792422000 * 1000)

        document.body.innerHTML = ''
        expect(getProgramData().beginAt).toBe(Date.parse('2026-10-20T00:00:00+09:00'))

        document.head.innerHTML = ''
        expect(getProgramData().beginAt).toBeNull()
    })

    it('番組情報がない・壊れているページでも例外にならず、ユーザー名を空にする', () => {
        document.head.innerHTML = '<script type="application/ld+json">{ broken</script>'
        expect(getProgramData().userName).toBe('')

        document.head.innerHTML = ''
        expect(getProgramData().userName).toBe('')
    })
})
