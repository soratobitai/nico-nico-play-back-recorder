// 録画を見る時の時間の出し方
import { describe, expect, it } from 'vitest'
import { formatElapsed, formatBroadcastTime } from '@/utils/time-format'

describe('番組の経過時間', () => {
    it('時:分:秒で出す（1時間に満たなくても時を付ける。ニコ生のプレイヤーと同じ）', () => {
        expect(formatElapsed((16 * 3600 + 18 * 60 + 42) * 1000)).toBe('16:18:42')
        expect(formatElapsed(65 * 1000)).toBe('0:01:05')
        expect(formatElapsed((25 * 3600 + 5 * 60) * 1000, { seconds: false })).toBe('25:05')
        expect(formatElapsed(-1000)).toBe('0:00:00') // 番組が始まる前に録った所
    })
})

describe('放送した時刻', () => {
    const now = new Date(2026, 9, 20, 18).getTime()
    it('午前・午後を付け、今日でなければ日付も付ける', () => {
        expect(formatBroadcastTime(new Date(2026, 9, 20, 16, 18, 42).getTime(), { now })).toBe('午後4:18')
        expect(formatBroadcastTime(new Date(2026, 9, 20, 0, 5, 9).getTime(), { now, seconds: true })).toBe('午前0:05:09')
        expect(formatBroadcastTime(new Date(2026, 9, 20, 12, 30).getTime(), { now })).toBe('午後0:30')
        expect(formatBroadcastTime(new Date(2026, 9, 19, 22, 15).getTime(), { now })).toBe('10/19 午後10:15')
    })
})
