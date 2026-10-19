import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChunk, getAllChunks, deleteAllChunks } from '@/hooks/indexedDB/recordingDB'
import { getRecordingMimeType, mergeStaleChunks } from '@/utils/recording'
import { getVideoExtension } from '@/utils/feature'

vi.mock('@/utils/feature', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/feature')>()),
    extractFirstFrame: vi.fn(async () => 'data:image/jpeg;base64,THUMB'),
}))
vi.mock('@/utils/ui', () => ({
    insertRecordedMovie: vi.fn(),
    deleteMovieIcon: vi.fn(),
    setRecordingStatus: vi.fn(),
    getTimeString: () => '00:00',
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

describe('getVideoExtension', () => {
    it('動画の形式からダウンロード時の拡張子を決める', () => {
        expect(getVideoExtension('video/webm;codecs=vp9,opus')).toBe('webm')
        expect(getVideoExtension('video/mp4')).toBe('mp4')
        expect(getVideoExtension('')).toBe('mp4') // 形式が分からない古いデータ
    })
})

describe('結合した動画の形式', () => {
    beforeEach(async () => {
        await deleteAllChunks()
    })

    it('webm で録画したチャンクは webm の動画として結合する', async () => {
        for (let i = 0; i < 3; i++) {
            await saveChunk('Temps', 'webm-segment', i, new Blob([`part-${i}`], { type: 'video/webm' }), null, 1000 + i, 'user', 'title')
        }

        await mergeStaleChunks(3 * 1000)

        const [chunk] = await getAllChunks('Chunks')
        expect(chunk.blob.type).toBe('video/webm')
    })
})
