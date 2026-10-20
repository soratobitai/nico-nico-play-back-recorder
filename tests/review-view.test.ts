// @vitest-environment happy-dom
// 録画を見る画面: 再生できない所（壊れた録画）に当たったら、その区間の残りを飛ばして続ける
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountReviewView } from '@/utils/review/view'
import { createReviewPlayer } from '@/utils/review/player'
import type { Timeline } from '@/utils/review/timeline'
import type { TimelineFragment, TimelineSegment } from '@/utils/library/db'

// MediaSource を使う再生の代わり（作られた時の時間軸と、移った位置を覚える）
type OnError = (error: unknown, fragment: Timeline['fragments'][number]) => void
type FakePlayer = { timeline: Timeline, onError: OnError, position: number, seek: ReturnType<typeof vi.fn>, destroy: ReturnType<typeof vi.fn> }
const players: FakePlayer[] = []
vi.mock('@/utils/review/player', () => ({
    createReviewPlayer: vi.fn(({ timeline, onError }: { timeline: Timeline, onError: OnError }) => {
        const player: FakePlayer & { update: () => void, cacheFragment: () => void } = {
            timeline,
            onError,
            position: 0,
            seek: vi.fn((t: number) => { player.position = t }),
            destroy: vi.fn(),
            update: () => {},
            cacheFragment: () => {},
        }
        players.push(player)
        return player
    }),
}))

const fragments = (count: number): TimelineFragment[] =>
    Array.from({ length: count }, (_, i) => ({ index: i, startTime: i * 3, duration: 3, keyframe: true }))
const segment = (segmentId: string, startedAt: number, count: number): TimelineSegment => ({
    segmentId, kind: 'video', mimeType: 'video/mp4', startedAt, endedAt: startedAt + count * 3000, init: new Blob(['init']), fragments: fragments(count),
})
// A: 0〜9秒（3断片）、B: 9.5〜15.5秒（2断片）
const recordings = () => [segment('A', 100_000, 3), segment('B', 109_500, 2)]

const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const current = () => players[players.length - 1]
const decodeError = (root: HTMLElement) => {
    const video = root.querySelector('video')!
    Object.defineProperty(video, 'error', { value: { code: 3 }, configurable: true })
    video.dispatchEvent(new Event('error'))
}
const keys = (timeline: Timeline) => timeline.fragments.map(f => `${f.segmentId}${f.index}`)

beforeEach(() => {
    players.length = 0
    vi.mocked(createReviewPlayer).mockClear()
    document.body.innerHTML = '<div id="root"></div>'
})

describe('再生できない所を飛ばす', () => {
    it('壊れた所から区間の終わりまでを外し、再生し直して次の再生できる所へ進む', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const first = current()
        first.position = 4 // A の2つ目の断片（3〜6秒）を再生中に壊れていた

        decodeError(root)

        expect(first.destroy).toHaveBeenCalled()
        const second = current()
        expect(second).not.toBe(first)
        expect(keys(second.timeline)).toEqual(['A0', 'B0', 'B1'])
        expect(second.seek).toHaveBeenLastCalledWith(3) // 外した所（録っていない間と同じ扱い）から次へ進む

        // 保存先から読み直しても、外した所は戻さない
        await view.refresh()
        expect(keys(current().timeline)).toEqual(['A0', 'B0', 'B1'])
        view.destroy()
    })

    it('先の方の断片を読み込めなかった時は、その区間の残りを外して、今の位置から続ける', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const first = current()
        first.position = 4 // A を再生中に、先の B の断片を読み込めなかった
        const broken = first.timeline.fragments.find(f => f.segmentId === 'B' && f.index === 1)!

        first.onError(new Error('append'), broken)

        expect(keys(current().timeline)).toEqual(['A0', 'A1', 'A2', 'B0'])
        expect(current().seek).toHaveBeenLastCalledWith(4)
        view.destroy()
    })

    it('何度も続く場合は飛ばし続けず、再生できなかったことを知らせる', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({
            root, mode: 'library', readFragments: async () => [],
            readTimeline: async () => Array.from({ length: 8 }, (_, i) => segment(`S${i}`, 100_000 + i * 10_000, 3)),
        })
        await flush()

        for (let i = 0; i < 5; i++) {
            current().position = i * 10 + 1
            decodeError(root)
        }
        expect(root.querySelector<HTMLElement>('.message')!.hidden).toBe(true)
        expect(createReviewPlayer).toHaveBeenCalledTimes(6)

        current().position = 51
        decodeError(root)
        expect(createReviewPlayer).toHaveBeenCalledTimes(6)
        expect(root.querySelector('.message')!.textContent).toContain('再生できませんでした')
        view.destroy()
    })
})

describe('閉じた後', () => {
    it('録画を読み終える前に閉じられたら、読み終えても再生を始めず、変化も知らせない', async () => {
        const root = document.getElementById('root')!
        let resolve: (segments: TimelineSegment[]) => void = () => {}
        const onChange = vi.fn()
        // コメント付きだけの番組（見る種類が変わるので、新しく再生を作る）
        const view = mountReviewView({
            root, mode: 'library', readFragments: async () => [], onChange,
            readTimeline: () => new Promise(r => { resolve = r }),
        })
        view.show('comments', 100_000, true)
        const created = vi.mocked(createReviewPlayer).mock.calls.length

        view.destroy()
        onChange.mockClear()
        resolve(recordings().map(s => ({ ...s, kind: 'comments' as const })))
        await flush()

        expect(createReviewPlayer).toHaveBeenCalledTimes(created)
        expect(onChange).not.toHaveBeenCalled()
    })
})

describe('再生の作り方', () => {
    it('録画中の番組を追いかけるプレイバック（live）では、区間の切り替わりで動画を終わりにしない', async () => {
        const root = document.getElementById('root')!
        const live = mountReviewView({ root, mode: 'live', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        expect(vi.mocked(createReviewPlayer).mock.calls.at(-1)![0]).toMatchObject({ endAtLast: false })
        live.destroy()

        const library = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        expect(vi.mocked(createReviewPlayer).mock.calls.at(-1)![0]).toMatchObject({ endAtLast: true })
        library.destroy()
    })

    it('10秒戻る時は、録っていない間に当たったら間の前へ戻る（backward）', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        current().position = 12

        root.querySelector<HTMLButtonElement>('.back')!.click()
        expect(current().seek).toHaveBeenLastCalledWith(2, { backward: true })
        root.querySelector<HTMLButtonElement>('.forward')!.click()
        expect(current().seek).toHaveBeenLastCalledWith(12, { backward: false })
        view.destroy()
    })
})

describe('シークバー', () => {
    it('動かして元の値に戻して離しても（change が届かなくても）、離した所で終え、表示が止まったままにならない', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const seek = root.querySelector<HTMLInputElement>('.seek')!
        current().position = 4
        seek.value = '4'

        seek.dispatchEvent(new Event('input')) // 動かして元の値に戻した
        seek.dispatchEvent(new Event('pointerup'))
        await flush()
        expect(current().seek).toHaveBeenLastCalledWith(4)

        // 10秒進むと、シークバーも進む
        root.querySelector<HTMLButtonElement>('.forward')!.click()
        root.querySelector('video')!.dispatchEvent(new Event('timeupdate'))
        expect(seek.value).toBe('14')
        view.destroy()
    })

    it('クリックやドラッグで、離した後に change が届く時は、1回だけ移る', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const seek = root.querySelector<HTMLInputElement>('.seek')!
        seek.value = '10'
        seek.dispatchEvent(new Event('input'))
        current().seek.mockClear() // 動かしている間の移動（コマを出す）は数えない
        seek.dispatchEvent(new Event('pointerup'))
        seek.dispatchEvent(new Event('change'))
        await flush()

        expect(current().seek).toHaveBeenCalledTimes(1)
        expect(current().seek).toHaveBeenLastCalledWith(10)
        view.destroy()
    })

    it('掴んで動かしている間は止めて、その位置のコマを出す。前の位置を出し終えるまで次へは移らず、最新の位置へ移る', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const seek = root.querySelector<HTMLInputElement>('.seek')!
        const video = root.querySelector('video')!
        Object.defineProperty(video, 'paused', { value: false, configurable: true }) // 再生中
        const pause = vi.spyOn(video, 'pause').mockImplementation(() => {})
        const play = vi.spyOn(video, 'play').mockResolvedValue()
        current().seek.mockClear()

        for (const value of ['2', '5', '7']) {
            seek.value = value
            seek.dispatchEvent(new Event('input'))
        }
        expect(pause).toHaveBeenCalled()
        expect(current().seek.mock.calls.map(([t]) => t)).toEqual([2]) // 2 のコマを出している間は移らない

        video.dispatchEvent(new Event('seeked'))
        expect(current().seek.mock.calls.map(([t]) => t)).toEqual([2, 7]) // 出し終えたら、最新の位置へ

        seek.dispatchEvent(new Event('change'))
        expect(current().seek).toHaveBeenLastCalledWith(7)
        expect(play).toHaveBeenCalled() // 動かす前に再生していたので、続けて再生する
        view.destroy()
    })

    it('止めていた時は、動かし終えても止めたまま', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const seek = root.querySelector<HTMLInputElement>('.seek')!
        const play = vi.spyOn(root.querySelector('video')!, 'play').mockResolvedValue()

        seek.value = '3'
        seek.dispatchEvent(new Event('input'))
        seek.dispatchEvent(new Event('change'))

        expect(current().seek).toHaveBeenLastCalledWith(3)
        expect(play).not.toHaveBeenCalled()
        view.destroy()
    })

    it('録画一覧のタイムラインを掴んで動かしている間も、その場面のコマを出し、離したらそこから再生する', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const play = vi.spyOn(root.querySelector('video')!, 'play').mockResolvedValue()
        current().seek.mockClear()

        view.scrub('video', 104_000) // A の4秒目
        expect(current().seek).toHaveBeenLastCalledWith(4)
        view.endScrub('video', 110_000) // B の始め（9.5秒）より後
        expect(current().seek).toHaveBeenLastCalledWith(10)
        expect(play).toHaveBeenCalled()
        view.destroy()
    })

    it('値を変えて change だけが届いた時も（支援技術などで）、その位置へ移る', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const seek = root.querySelector<HTMLInputElement>('.seek')!

        seek.value = '10'
        seek.dispatchEvent(new Event('change'))

        expect(current().seek).toHaveBeenLastCalledWith(10)
        view.destroy()
    })
})

describe('時間の表示', () => {
    it('録画を始めてからの時間を大きく出し、横に番組の経過時間、2段目にその場面の時刻を出す', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', programBeginAt: 40_000, recordingStartedAt: 70_000, readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()

        // A の始め（100 秒）は、録画を始めて（70 秒）から 30 秒、番組が始まって（40 秒）から 1 分
        expect(root.querySelector('.clock')!.textContent).toBe('0:30')
        expect(root.querySelector('.program-time')!.textContent).toBe('（番組 0:01:00）')
        expect(root.querySelector('.behind')!.textContent).toMatch(/^(\d+\/\d+ )?午[前後]\d+:\d\d時点$/)
        expect(root.querySelector('.seek')!.getAttribute('aria-valuetext')).toMatch(/^録画 0:30（番組 0:01:00） .+時点$/)
        view.destroy()
    })

    it('録画を始めた時刻を指定しなければ最初に録った所から数え、番組が始まった時刻が分からなければ番組の経過時間を出さない', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        expect(root.querySelector('.clock')!.textContent).toBe('0:00')
        expect(root.querySelector('.program-time')!.textContent).toBe('')
        view.destroy()
    })

    it('プレイバックのウィンドウでは、時刻の横にライブからどれだけ前かを出す', async () => {
        const root = document.getElementById('root')!
        let now = 0
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
        try {
            const view = mountReviewView({ root, mode: 'live', readTimeline: async () => recordings(), readFragments: async () => [] })
            await flush()
            const wallClock = current().timeline.wallClockAt(current().position)!
            const video = root.querySelector('video')!

            now = wallClock + 5 * 60_000 + 30_000
            video.dispatchEvent(new Event('timeupdate'))
            expect(root.querySelector('.behind')!.textContent).toMatch(/^(\d+\/\d+ )?午[前後]\d+:\d\d時点（5:30前）$/)

            now = wallClock + 5_000
            video.dispatchEvent(new Event('timeupdate'))
            expect(root.querySelector('.behind')!.textContent).toMatch(/時点（ライブ）$/)
            view.destroy()
        } finally {
            spy.mockRestore()
        }
    })
})

describe('動画を押す', () => {
    it.each(['library', 'live'] as const)('動画を押すと再生・一時停止する（%s）', async (mode) => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode, readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const video = root.querySelector('video')!
        const play = vi.spyOn(video, 'play').mockResolvedValue()
        const pause = vi.spyOn(video, 'pause').mockImplementation(() => {})
        Object.defineProperty(video, 'paused', { value: true, configurable: true }) // 止めている

        video.click()
        expect(play).toHaveBeenCalledTimes(1)
        Object.defineProperty(video, 'paused', { value: false, configurable: true })
        video.click()
        expect(pause).toHaveBeenCalledTimes(1)
        view.destroy()
    })
})

describe('キー操作', () => {
    it('ボタンの上のスペースはそのボタンを押す（再生・一時停止にしない）', async () => {
        const root = document.getElementById('root')!
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => recordings(), readFragments: async () => [] })
        await flush()
        const video = root.querySelector('video')!
        const play = vi.spyOn(video, 'play').mockResolvedValue()
        const mute = root.querySelector<HTMLButtonElement>('.mute')!

        const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
        mute.dispatchEvent(event)

        expect(play).not.toHaveBeenCalled()
        expect(event.defaultPrevented).toBe(false)

        // ページ（body）の上なら、再生する
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
        expect(play).toHaveBeenCalled()
        view.destroy()
    })
})

describe('見ている録画が消された時', () => {
    it('見ている種類の録画が全部消されたら、残っている種類へ移る', async () => {
        const root = document.getElementById('root')!
        const comments = () => recordings().map(s => ({ ...s, segmentId: `c${s.segmentId}`, kind: 'comments' as const }))
        let stored = [...recordings(), ...comments()]
        const onChange = vi.fn()
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => stored, readFragments: async () => [], onChange })
        await flush()
        view.show('comments', 101_000, false)
        expect(onChange.mock.lastCall![0].kind).toBe('comments')

        stored = recordings()
        await view.refresh()
        expect(onChange.mock.lastCall![0]).toMatchObject({ kind: 'video', kinds: ['video'] })
        expect(current().timeline.fragments.every(f => f.segmentId === 'A' || f.segmentId === 'B')).toBe(true)
        view.destroy()
    })

    it('見ている区間が消されたら、再生を作り直して、残っている次の所から見る', async () => {
        const root = document.getElementById('root')!
        let stored = recordings()
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => stored, readFragments: async () => [] })
        await flush()
        current().seek(1) // A の中
        const created = players.length

        stored = recordings().filter(s => s.segmentId !== 'A')
        await view.refresh()
        expect(players.length).toBe(created + 1)
        expect(current().position).toBeCloseTo(9.5) // B の始め
        view.destroy()
    })

    it('見ていない区間が消されただけなら、再生を作り直さない', async () => {
        const root = document.getElementById('root')!
        let stored = recordings()
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => stored, readFragments: async () => [] })
        await flush()
        current().seek(10) // B の中
        const created = players.length

        stored = recordings().filter(s => s.segmentId !== 'A')
        await view.refresh()
        expect(players.length).toBe(created)
        view.destroy()
    })
})

describe('プレイバックのウィンドウで見る種類', () => {
    it('今録っている（最も新しい所まである）種類で開き、ライブに戻る時も今録っている種類へ', async () => {
        const root = document.getElementById('root')!
        // コメントなしは前に録り終えていて、今はコメントありだけを録っている
        const stored = [...recordings(), { ...segment('C', 700_000, 3), kind: 'comments' as const, endedAt: null }]
        const onChange = vi.fn()
        const view = mountReviewView({ root, mode: 'live', readTimeline: async () => stored, readFragments: async () => [], onChange })
        await flush()
        expect(onChange.mock.lastCall![0].kind).toBe('comments')

        root.querySelector<HTMLButtonElement>('.kind-video')!.click()
        expect(onChange.mock.lastCall![0].kind).toBe('video')
        root.querySelector<HTMLButtonElement>('.live')!.click()
        expect(onChange.mock.lastCall![0].kind).toBe('comments')
        view.destroy()
    })
})

describe('録画の時間の基準', () => {
    it('容量の上限で古い断片が消されても、区間が残っている間は同じ場面の時間が変わらない（録画一覧と同じ、区間の始まりから数える）', async () => {
        const root = document.getElementById('root')!
        let stored = recordings()
        const view = mountReviewView({ root, mode: 'library', readTimeline: async () => stored, readFragments: async () => [] })
        await flush()
        current().seek(10) // B の中（録り始めてから 10 秒）
        view.refresh()
        await flush()
        const clock = () => root.querySelector('.clock')!.textContent
        expect(clock()).toBe('0:10')

        stored = [{ ...segment('A', 100_000, 3), fragments: fragments(3).slice(2) }, segment('B', 109_500, 2)]
        await view.refresh()
        expect(clock()).toBe('0:10')
        view.destroy()
    })
})
