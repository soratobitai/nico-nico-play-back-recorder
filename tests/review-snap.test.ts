// 録画を見る時に移る位置を、読み込める所に合わせる（録っていない間・断片の終わりの端数を避ける）
import { describe, expect, it } from 'vitest'
import { Timeline } from '@/utils/review/timeline'
import { snapToRecorded, stuckJumpTarget } from '@/utils/review/player'
import type { TimelineFragment, TimelineSegment } from '@/utils/library/db'

const fragment = (index: number, startTime: number, duration: number): TimelineFragment => ({ index, startTime, duration, keyframe: true })
const segment = (segmentId: string, startedAt: number, fragments: TimelineFragment[]): TimelineSegment => ({
    segmentId, kind: 'video', mimeType: 'video/mp4', startedAt, endedAt: startedAt + 60_000, init: new Blob(['init']), fragments,
})

// A: 0〜7.5秒（最後の断片は録画を止めた所で短い 6〜7.5）、9.7秒あけて B: 17.2〜26.2秒
const timeline = () => {
    const t = new Timeline()
    t.sync([
        segment('A', 100_000, [fragment(0, 0, 3), fragment(1, 3, 3), fragment(2, 6, 1.5)]),
        segment('B', 117_200, [fragment(0, 0, 3), fragment(1, 3, 3), fragment(2, 6, 3)]),
    ])
    return t
}

describe('snapToRecorded', () => {
    it('録った所はそのまま。録っていない間なら、次に録った所へ', () => {
        expect(snapToRecorded(timeline(), 4)).toBe(4)
        expect(snapToRecorded(timeline(), 12)).toBe(17.2)
    })

    it('戻る時に録っていない間に当たったら、間を除いて、録った時間で数えて戻る（間の前の断片が短くても、その前までさかのぼる）', () => {
        // B の 24.2 秒から10秒戻る: B の始め（17.2）までで7秒、残りの3秒を A の終わり（7.5）から数える → 4.5
        expect(snapToRecorded(timeline(), 14.2, true)).toBeCloseTo(4.5)
        // 戻りきったら、いちばん前
        expect(snapToRecorded(timeline(), 8, true)).toBe(0)
    })

    it('戻る時に、間の前の断片の終わりの端数に当たる時は、端数の手前へ（次の録った所へ進めて戻れなくならないように）', () => {
        expect(snapToRecorded(timeline(), 17, true)).toBe(7) // 間の中、A の終わりから 0.2 秒
        expect(snapToRecorded(timeline(), 7.3, true)).toBe(7) // A の終わりの端数の中
        expect(snapToRecorded(timeline(), 7.3)).toBe(17.2) // 進む時は次の録った所へ
    })
})

describe('stuckJumpTarget（再生が進まない時に飛ぶ先）', () => {
    const range = (start: number, end: number) => ({ start, end })
    const all = () => true
    // 読み込んだ範囲（ranges）に入っている断片だけを、読み込んだとする
    const loadedIn = (ranges: { start: number, end: number }[]) => (f: { start: number, end: number }) => ranges.some(r => f.start >= r.start - 0.05 && f.end <= r.end + 0.05)
    // A: 0〜8.9秒、区間の切り替わりの0.1秒の隙間をあけて B: 9〜18秒
    const boundary = () => {
        const t = new Timeline()
        t.sync([
            segment('A', 100_000, [fragment(0, 0, 3), fragment(1, 3, 3), fragment(2, 6, 2.9)]),
            segment('B', 109_000, [fragment(0, 0, 3), fragment(1, 3, 3), fragment(2, 6, 3)]),
        ])
        return t
    }
    // 続けて録った 0〜24秒
    const continuous = () => {
        const t = new Timeline()
        t.sync([segment('A', 100_000, Array.from({ length: 8 }, (_, i) => fragment(i, i * 3, 3)))])
        return t
    }

    it('区間の切り替わりの隙間の手前（読み込んだ範囲の終わりより少し前）で止まったら、次の区間へ飛ぶ', () => {
        expect(stuckJumpTarget(boundary(), 8.4, [range(0, 8.9), range(9, 18)], all)).toBeCloseTo(9.01)
    })

    it('隙間の前の最後の断片が短くても、読み込んだ範囲の終わりから見て、隙間の先へ飛ぶ', () => {
        // A の最後の断片が 0.2 秒だけで、録り直しで 1.3 秒あいて B が始まる。Chrome は A の 2つ目の断片の中（5.7）で止まる
        const t = new Timeline()
        t.sync([
            segment('A', 100_000, [fragment(0, 0, 3), fragment(1, 3, 3), fragment(2, 6, 0.2)]),
            segment('B', 107_500, [fragment(0, 0, 3), fragment(1, 3, 3)]),
        ])
        expect(stuckJumpTarget(t, 5.7, [range(0, 6.2), range(7.5, 13.5)], all)).toBeCloseTo(7.51)
    })

    it('録っていない間が長くても（壊れて外した所・消された所）、その先が読み込まれていれば飛ぶ', () => {
        const t = continuous()
        for (const index of [2, 3, 4, 5, 6]) t.removeFragment('A', index) // 6〜21秒がない
        expect(stuckJumpTarget(t, 5.5, [range(0, 6), range(21, 24)], all)).toBeCloseTo(21.01)
        // その先がまだ読み込まれていなければ、待つ
        expect(stuckJumpTarget(t, 5.5, [range(0, 6)], all)).toBeNull()
    })

    it('同じ区間の続きを読み込んでいる途中なら、先の読み込み済みの所へ飛ばない（録った場面を見落とさない）', () => {
        const ranges = [range(0, 6), range(9, 24)]
        expect(stuckJumpTarget(continuous(), 5.5, ranges, loadedIn(ranges))).toBeNull()
    })

    it('隙間の先の区間がまだ読み込まれていなければ、前に読み込んで残っている遠くの範囲へは飛ばない', () => {
        // A: 0〜12、B: 15〜45（まだ読み込んでいない）、前に読み込んだ 45〜75 が残っている
        const t = new Timeline()
        t.sync([
            segment('A', 100_000, Array.from({ length: 4 }, (_, i) => fragment(i, i * 3, 3))),
            segment('B', 115_000, Array.from({ length: 20 }, (_, i) => fragment(i, i * 3, 3))),
        ])
        const ranges = [range(0, 12), range(45, 75)]
        expect(stuckJumpTarget(t, 11.5, ranges, loadedIn(ranges))).toBeNull()
    })

    it('少し重なった区間で、読み込んだのに抜けた所（後から読み込んだ断片で消えた所）は飛ぶ', () => {
        // A の最後の断片（6〜6.2）が、0.3 秒重なって始まった B の最初の断片（5.9〜8.9）の中にある。
        // B0 を読み込んだ後に A2 を読み込むと、B0 の 6.2 から後が消える（B0 は読み込み済みのまま）
        const t = new Timeline()
        t.sync([
            segment('A', 100_000, [fragment(0, 0, 3), fragment(1, 3, 3), fragment(2, 6, 0.2)]),
            segment('B', 105_900, [fragment(0, 0, 3), fragment(1, 3, 3)]),
        ])
        expect(stuckJumpTarget(t, 5.7, [range(0, 6.2), range(8.9, 11.9)], all)).toBeCloseTo(8.91)
    })

    it('映像と音声の境目のずれなどの、ごく小さな隙間は飛ぶ', () => {
        expect(stuckJumpTarget(continuous(), 5.5, [range(0, 5.95), range(6.2, 24)], all)).toBeCloseTo(6.21)
    })

    it('最新の所（先に何もない）や、読み込んだ範囲の途中で止まった時は飛ばない', () => {
        expect(stuckJumpTarget(continuous(), 23.5, [range(0, 24)], all)).toBeNull()
        expect(stuckJumpTarget(continuous(), 2, [range(0, 12), range(15, 24)], all)).toBeNull()
    })
})
