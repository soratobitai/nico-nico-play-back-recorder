// 録画を見る時に移る位置を、読み込める所に合わせる（録っていない間・断片の終わりの端数を避ける）
import { describe, expect, it } from 'vitest'
import { Timeline } from '@/utils/review/timeline'
import { snapToRecorded } from '@/utils/review/player'
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
