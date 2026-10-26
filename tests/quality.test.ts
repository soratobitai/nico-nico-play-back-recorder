// 録画の画質の表し方（録画バーと録画一覧）
import { describe, expect, it } from 'vitest'
import { describeQuality, mainSources } from '@/utils/quality'

const p720 = { width: 1280, height: 720 }
const p480 = { width: 854, height: 480 }
const p288 = { width: 512, height: 288 }
const p1080 = { width: 1920, height: 1080 }

describe('describeQuality', () => {
    it('配信のままの大きさで録った時（配信の大きさが分からない・同じ）は、録画の高さだけ', () => {
        expect(describeQuality(p720)).toEqual({ label: '720p', detail: '1280×720' })
        expect(describeQuality(p720, [p720])).toEqual({ label: '720p', detail: '1280×720' })
    })

    it('配信より大きく描き直して録った時は、配信の画質から引き伸ばしたと出す', () => {
        expect(describeQuality(p720, [p288])).toEqual({ label: '288p→720p', detail: '1280×720（配信の 512×288 を引き伸ばして録画）' })
    })

    it('配信より小さく描き直して録った時は、縮小したと出す', () => {
        expect(describeQuality(p720, [p1080])).toEqual({ label: '1080p→720p', detail: '1280×720（配信の 1920×1080 を縮小して録画）' })
    })

    it('途中で配信の画質が変わった時は、配信の画質を低い順に並べる（同じ大きさは1回）', () => {
        expect(describeQuality(p720, [p720, p288, p480, p288])).toEqual({
            label: '288p/480p/720p→720p',
            detail: '1280×720（配信の 512×288・854×480・1280×720 を描き直して録画）',
        })
    })
})

describe('mainSources', () => {
    it('大きさごとに長さを合わせ、短い間だけだった大きさ（番組を開いた直後の数秒など）を除く', () => {
        expect(mainSources([
            { ...p288, seconds: 3 }, { ...p720, seconds: 297 }, { ...p288, seconds: 4 },
        ])).toEqual([{ ...p720, seconds: 297 }])
        expect(mainSources([
            { ...p288, seconds: 6 }, { ...p720, seconds: 200 }, { ...p288, seconds: 6 },
        ])).toEqual([{ ...p288, seconds: 12 }, { ...p720, seconds: 200 }])
    })

    it('どの大きさも短ければ、最も長いものを残す（録り始めたばかりの録画）', () => {
        expect(mainSources([{ ...p288, seconds: 2 }, { ...p720, seconds: 5 }])).toEqual([{ ...p720, seconds: 5 }])
        expect(mainSources([])).toEqual([])
    })

    it('渡した長さは書き換えない', () => {
        const sources = [{ ...p288, seconds: 6 }, { ...p288, seconds: 6 }]
        mainSources(sources)
        expect(sources).toEqual([{ ...p288, seconds: 6 }, { ...p288, seconds: 6 }])
    })
})
