import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRecordingMimeType, segmentFormatOf } from '@/utils/recording'
import { getVideoExtension } from '@/utils/feature'

vi.mock('@/utils/ui', () => ({
    setRecorderState: vi.fn(),
    getTimeString: () => '0:00',
}))
vi.mock('@/services/api', () => ({ checkLiveStatus: vi.fn(async () => 'ON_AIR') }))

// 指定した形式だけに対応している MediaRecorder にする
const supportOnly = (...supported: string[]) => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (type: string) => supported.includes(type) })
}

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('getRecordingMimeType', () => {
    it('mp4 に対応していれば mp4 で録画する', () => {
        supportOnly('video/mp4; codecs="avc1.640028, mp4a.40.2"', 'video/webm; codecs="vp9, opus"')
        expect(getRecordingMimeType()).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"')
    })

    it('mp4 に対応していなければ webm で録画する', () => {
        supportOnly('video/webm; codecs="vp8, opus"')
        expect(getRecordingMimeType()).toBe('video/webm; codecs="vp8, opus"')
    })

    it('どれにも対応していなければ指定しない（ブラウザの標準の形式になる）', () => {
        supportOnly()
        expect(getRecordingMimeType()).toBeUndefined()
    })
})

describe('segmentFormatOf（保存の形式）', () => {
    it('mp4 は断片に分けて保存し、webm などはそのまま保存する', () => {
        expect(segmentFormatOf('video/mp4; codecs="avc1.640028, mp4a.40.2"')).toBe('fmp4')
        expect(segmentFormatOf('video/webm; codecs="vp9, opus"')).toBe('opaque')
        expect(segmentFormatOf('')).toBe('opaque')
    })
})

describe('getVideoExtension', () => {
    it('動画の形式からダウンロード時の拡張子を決める', () => {
        expect(getVideoExtension('video/webm;codecs=vp9,opus')).toBe('webm')
        expect(getVideoExtension('video/mp4')).toBe('mp4')
        expect(getVideoExtension('')).toBe('mp4') // 形式が分からない古いデータ
    })
})
