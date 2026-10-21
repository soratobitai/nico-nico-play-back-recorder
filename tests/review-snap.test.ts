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
        expect(stuckJumpTarget(boundary(), 8.4, [range(0, 8.9), range(9, 18)])).toBeCloseTo(9.01)
    })

    it('録っていない間が長くても（壊れて外した所・消された所）、その先が読み込まれていれば飛ぶ', () => {
        const t = continuous()
        for (const index of [2, 3, 4, 5, 6]) t.removeFragment('A', index) // 6〜21秒がない
        expect(stuckJumpTarget(t, 5.5, [range(0, 6), range(21, 24)])).toBeCloseTo(21.01)
        // その先がまだ読み込まれていなければ、待つ
        expect(stuckJumpTarget(t, 5.5, [range(0, 6)])).toBeNull()
    })

    it('同じ区間の続きを読み込んでいる途中なら、先の読み込み済みの所へ飛ばない（録った場面を見落とさない）', () => {
        expect(stuckJumpTarget(continuous(), 5.5, [range(0, 6), range(9, 24)])).toBeNull()
    })

    it('映像と音声の境目のずれなどの、ごく小さな隙間は飛ぶ', () => {
        expect(stuckJumpTarget(continuous(), 5.5, [range(0, 5.95), range(6.2, 24)])).toBeCloseTo(6.21)
    })

    it('最新の所（先に何もない）では飛ばない', () => {
        expect(stuckJumpTarget(continuous(), 23.5, [range(0, 24)])).toBeNull()
    })
})
