import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChunk, saveMergedChunk, getAllChunks, deleteAllChunks, deleteOldestChunks, cleanUpOldChunks } from '@/hooks/indexedDB/recordingDB'
import { mergeStaleChunks, retryOnQuotaExceeded } from '@/utils/recording'
import { extractFirstFrame } from '@/utils/feature'
import { deleteMovieIcon } from '@/utils/ui'

// 容量不足は fake-indexeddb では起きないので、結合後の保存を差し替えて再現する
vi.mock('@/hooks/indexedDB/recordingDB', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/hooks/indexedDB/recordingDB')>()
    return { ...actual, saveMergedChunk: vi.fn(actual.saveMergedChunk) }
})
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

const quotaError = () => new DOMException('storage is full', 'QuotaExceededError')

// 保存済みの録画（Chunks）を size バイトの動画として作る
const putChunk = (sessionId: string, size: number, createdAt: number) =>
    saveChunk('Chunks', sessionId, createdAt, new Blob([new Uint8Array(size)], { type: 'video/mp4' }), null, createdAt, 'user', 'title')
const chunkIds = async () => (await getAllChunks('Chunks')).map(c => c.sessionId)

beforeEach(async () => {
    await deleteAllChunks()
    vi.mocked(deleteMovieIcon).mockClear()
    vi.mocked(saveMergedChunk).mockClear()
    vi.mocked(extractFirstFrame).mockClear()
})

describe('deleteOldestChunks', () => {
    it('古いものから順に、指定サイズ以上になるまで削除する', async () => {
        await putChunk('oldest', 100, 1000)
        await putChunk('middle', 100, 2000)
        await putChunk('newest', 100, 3000)

        const deleted = await deleteOldestChunks('Chunks', 150)

        expect(deleted).toEqual([['oldest', 1000], ['middle', 2000]])
        expect(await chunkIds()).toEqual(['newest'])
    })
})

describe('cleanUpOldChunks', () => {
    it('上限を超えた分だけ古い録画を削除する', async () => {
        await putChunk('oldest', 100, 1000)
        await putChunk('middle', 100, 2000)
        await putChunk('newest', 100, 3000)

        await cleanUpOldChunks('Chunks', 200)

        expect(await chunkIds()).toEqual(['middle', 'newest'])
    })

    it('上限以内なら何も削除しない', async () => {
        await putChunk('only', 100, 1000)

        expect(await cleanUpOldChunks('Chunks', 1000)).toEqual([])
        expect(await chunkIds()).toEqual(['only'])
    })
})

describe('retryOnQuotaExceeded', () => {
    it('容量不足なら古い録画を必要な分だけ削除し、一覧からも消してから再試行する', async () => {
        await putChunk('oldest', 100, 1000)
        await putChunk('newest', 100, 2000)
        const save = vi.fn()
            .mockRejectedValueOnce(quotaError())
            .mockResolvedValueOnce('saved')

        await expect(retryOnQuotaExceeded(50, save)).resolves.toBe('saved')

        expect(save).toHaveBeenCalledTimes(2)
        expect(await chunkIds()).toEqual(['newest'])
        expect(deleteMovieIcon).toHaveBeenCalledWith([['oldest', 1000]])
    })

    it('削除できる録画がなければ容量不足のエラーをそのまま返す', async () => {
        const save = vi.fn().mockRejectedValue(quotaError())

        await expect(retryOnQuotaExceeded(50, save)).rejects.toMatchObject({ name: 'QuotaExceededError' })
        expect(save).toHaveBeenCalledTimes(1)
    })

    it('容量不足以外のエラーでは録画を削除しない', async () => {
        await putChunk('keep', 100, 1000)
        const save = vi.fn().mockRejectedValue(new Error('other'))

        await expect(retryOnQuotaExceeded(50, save)).rejects.toThrow('other')
        expect(await chunkIds()).toEqual(['keep'])
    })
})

describe('結合時の容量不足', () => {
    it('結合後の保存が容量不足で失敗したら、古い録画を消して保存し直す', async () => {
        await putChunk('old-recording', 100, 1000)
        for (let i = 0; i < 3; i++) {
            await saveChunk('Temps', 'segment', i, new Blob([`part-${i}`], { type: 'video/mp4' }), null, 2000 + i, 'user', 'title')
        }
        vi.mocked(saveMergedChunk).mockRejectedValueOnce(quotaError())

        await mergeStaleChunks(3 * 1000)

        expect(saveMergedChunk).toHaveBeenCalledTimes(2)
        expect(await chunkIds()).toEqual(['segment'])
        expect((await getAllChunks('Temps'))).toHaveLength(0)
        expect(deleteMovieIcon).toHaveBeenCalledWith([['old-recording', 1000]])
    })
})
