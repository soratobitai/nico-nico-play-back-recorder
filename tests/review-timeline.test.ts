import { describe, expect, it } from 'vitest'
import { Timeline, planBuffer, fragmentKey } from '@/utils/review/timeline'
import type { TimelineFragment, TimelineSegment } from '@/utils/library/db'

const init = new Blob(['init'])

// 3秒ごとの断片（区間の中の時刻は from 秒から）
const fragments = (count: number, from = 0, firstIndex = 0): TimelineFragment[] =>
    Array.from({ length: count }, (_, i) => ({ index: firstIndex + i, startTime: from + i * 3, duration: 3, keyframe: true }))

const segment = (segmentId: string, startedAt: number, frags: TimelineFragment[], endedAt: number | null = startedAt + frags.length * 3000): TimelineSegment => ({
    segmentId, kind: 'video', mimeType: 'video/mp4', startedAt, endedAt, init, fragments: frags,
})

const starts = (timeline: Timeline) => timeline.fragments.map(f => [f.segmentId, f.index, f.start])

describe('Timeline（見直し用の時間軸）', () => {
    it('最初の区間は 0 秒から、続けて録った区間は録った時刻のとおりに並べる', () => {
        const timeline = new Timeline()
        timeline.sync([
            segment('A', 100_000, fragments(2)), // 0〜6秒
            segment('B', 106_500, fragments(2)), // A の 0.5 秒後から
        ])

        expect(starts(timeline)).toEqual([['A', 0, 0], ['A', 1, 3], ['B', 0, 6.5], ['B', 1, 9.5]])
        expect(timeline.start).toBe(0)
        expect(timeline.end).toBe(12.5)
    })

    it('長く空いた区間（ページを開き直した など）は、前の区間の終わりに詰める', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(2)), segment('B', 3_700_000, fragments(1))])

        expect(starts(timeline)).toEqual([['A', 0, 0], ['A', 1, 3], ['B', 0, 6]])
        // 録った時刻は区間ごとに正しく求める
        expect(timeline.wallClockAt(1)).toBe(101_000)
        expect(timeline.wallClockAt(7)).toBe(3_701_000)
    })

    it('別のタブで同時に録っていた（大きく重なる）区間は並べない', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(10)), segment('B', 110_000, fragments(5))])

        expect(timeline.placedSegments.map(s => s.segmentId)).toEqual(['A'])
    })

    it('録画中の区間に断片が届くと延び、次の区間の断片が届いたら並べる', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(1), null)])

        timeline.addFragments('A', fragments(1, 3, 1))
        timeline.finishSegment('A', 106_000)
        timeline.addSegment({ segmentId: 'B', kind: 'video', mimeType: 'video/mp4', startedAt: 106_000, endedAt: null, init })
        expect(timeline.placedSegments.map(s => s.segmentId)).toEqual(['A']) // 断片が届くまでは並べない
        timeline.addFragments('B', fragments(1, 0.1))

        expect(starts(timeline)).toEqual([['A', 0, 0], ['A', 1, 3], ['B', 0, 6.1]])
    })

    it('古い断片が消されても、並べた位置は変えない', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(3)), segment('B', 109_000, fragments(2))])

        timeline.sync([segment('A', 100_000, fragments(1, 6, 2)), segment('B', 109_000, fragments(2))])

        expect(starts(timeline)).toEqual([['A', 2, 6], ['B', 0, 9], ['B', 1, 12]])
        expect(timeline.start).toBe(6)
    })

    it('保存先から読み直しても、録画中に届いたばかりの断片は残す', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(2), null)])
        timeline.addFragments('A', fragments(1, 6, 2))

        timeline.sync([segment('A', 100_000, fragments(2), null)])

        expect(timeline.fragments.map(f => f.index)).toEqual([0, 1, 2])
    })

    it('保存先から消された録画中の区間・断片は、読み直したら外す（「すべて消す」で録画中の区間の中身だけ消した・録画一覧で削除した）', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(3), null), segment('B', 200_000, fragments(2), null)])

        // A は中身だけ消された（区間は残る）、B は区間ごと消された
        timeline.sync([segment('A', 100_000, [], null)])
        expect(timeline.isEmpty).toBe(true)
        expect(timeline.segment('B')).toBeUndefined()

        // 読み直した後に録画中の知らせで届いたもの（まだ保存先にない）は残す
        timeline.addFragments('A', fragments(1, 9, 3))
        timeline.sync([segment('A', 100_000, [], null)])
        expect(timeline.fragments.map(f => f.index)).toEqual([3])
        // その次に読み直した時も保存先になければ、消されたもの
        timeline.sync([segment('A', 100_000, [], null)])
        expect(timeline.isEmpty).toBe(true)
    })

    it('録画を終えたと届いた区間は、それより前に読んだ内容で読み直しても録画中に戻さない（消された区間が残り続けないように）', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(2), null)])
        timeline.finishSegment('A', 106_000)

        // 終えたと届く前に読み始めていた内容（まだ録画中）
        timeline.sync([segment('A', 100_000, fragments(2), null)])
        expect(timeline.segment('A')?.endedAt).toBe(106_000)

        // 区間が消されていれば、次に読み直した時に外れる
        timeline.sync([])
        expect(timeline.segment('A')).toBeUndefined()
    })

    it('indexAt は時刻を含む断片、間にある時は次の断片、最後より後なら最後の断片を返す', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(2)), segment('B', 108_000, fragments(2))]) // A: 0〜6、B: 8〜14

        expect(timeline.indexAt(0)).toBe(0)
        expect(timeline.indexAt(3)).toBe(1)
        expect(timeline.indexAt(7)).toBe(2) // 録っていない間
        expect(timeline.indexAt(100)).toBe(3)
        expect(new Timeline().indexAt(0)).toBe(-1)
    })

    it('録った時刻から、時間軸の上の時刻を求める（別の種類に切り替えて同じ場面を見るため）', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(2)), segment('B', 3_700_000, fragments(2))]) // A: 0〜6、B: 6〜12（詰めて並べる）

        expect(timeline.timeAtWallClock(101_500)).toBe(1.5)
        expect(timeline.timeAtWallClock(3_703_000)).toBe(9)
        expect(timeline.timeAtWallClock(50_000)).toBe(0) // 録る前 → 最初
        expect(timeline.timeAtWallClock(200_000)).toBe(6) // 録っていない間 → 次に録った所
        expect(timeline.timeAtWallClock(9_999_999)).toBe(12) // 最後より後 → 終わり
        expect(new Timeline().timeAtWallClock(0)).toBeNull()
        // 行って戻ると同じ時刻
        expect(timeline.timeAtWallClock(timeline.wallClockAt(4.2)!)).toBeCloseTo(4.2, 6)
    })

    it('消されていた断片を外せる', () => {
        const timeline = new Timeline()
        timeline.sync([segment('A', 100_000, fragments(3))])

        timeline.removeFragment('A', 1)

        expect(timeline.fragments.map(f => f.index)).toEqual([0, 2])
    })
})

describe('planBuffer（読み込む断片を決める）', () => {
    const window = { ahead: 10, keepBehind: 6, keepAhead: 20 }
    const timeline = new Timeline()
    timeline.sync([segment('A', 100_000, fragments(10))]) // 0〜30秒

    it('再生位置から ahead 秒先までの断片を、読み込み済みのものを除いて読む', () => {
        const plan = planBuffer(timeline, 4, new Set([fragmentKey({ segmentId: 'A', index: 2 })]), window)

        expect(plan.append.map(f => f.index)).toEqual([1, 3, 4])
    })

    it('再生位置より前と先の離れた部分は、断片の境目で捨てる', () => {
        const plan = planBuffer(timeline, 15, new Set(), window)

        expect(plan.removeBefore).toBe(9) // 15 - 6 = 9 を含む断片の始まり
        expect(plan.removeFrom).toBeNull() // 35 秒より先の断片はない
        expect(planBuffer(timeline, 2, new Set(), window).removeFrom).toBe(24)
        expect(planBuffer(timeline, 2, new Set(), window).removeBefore).toBeNull()
    })

    it('キーフレームから始まらない断片から読む時は、キーフレームの断片までさかのぼる', () => {
        const noKey = new Timeline()
        noKey.sync([segment('A', 100_000, fragments(4).map((f, i) => ({ ...f, keyframe: i === 0 })))])

        expect(planBuffer(noKey, 7, new Set(), window).append.map(f => f.index)).toEqual([0, 1, 2, 3])
        // 直前の断片を読み込み済みなら、続けて読めるのでさかのぼらない
        expect(planBuffer(noKey, 7, new Set(['A:1']), window).append.map(f => f.index)).toEqual([2, 3])
    })

    it('再生位置が録っていない長い間にあれば、次に録った所から ahead 秒先まで読み、それを捨てない', () => {
        const holed = new Timeline()
        holed.sync([segment('A', 100_000, fragments(10))])
        for (let index = 2; index <= 7; index++) holed.removeFragment('A', index) // 6〜24秒が空く（区間を消した・壊れていた など）

        const plan = planBuffer(holed, 7, new Set(), window)

        expect(plan.append.map(f => f.index)).toEqual([8, 9]) // 24 秒から 34 秒まで
        expect(plan.removeFrom).toBeNull()
    })
})
