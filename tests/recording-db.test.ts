import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChunk, getAllChunks, getChunksCount, getLatestChunks, getOlderChunks, deleteAllChunks } from '@/hooks/indexedDB/recordingDB'
import { formatDate, formatDateForFileName } from '@/utils/feature'

const putTemp = (sessionId: string, chunkIndex: number) =>
    saveChunk('Temps', sessionId, chunkIndex, new Blob(['x'], { type: 'video/mp4' }), null, Date.now(), 'user', 'title')
const putRecording = (createdAt: number) =>
    saveChunk('Chunks', `S${createdAt}`, createdAt, new Blob(['x'], { type: 'video/mp4' }), null, createdAt, 'user', 'title')

describe('録画一覧の読み込み', () => {
    beforeEach(async () => {
        await deleteAllChunks()
        // キーの順（sessionId 順）と作成時刻の順が違うように保存する
        for (const createdAt of [3000, 1000, 5000, 2000, 4000]) {
            await putRecording(createdAt)
        }
    })

    it('getAllChunks は作成時刻の古い順', async () => {
        expect((await getAllChunks('Chunks')).map(c => c.createdAt)).toEqual([1000, 2000, 3000, 4000, 5000])
    })

    it('getLatestChunks は新しい順に指定件数', async () => {
        expect((await getLatestChunks('Chunks', 2)).map(c => c.createdAt)).toEqual([5000, 4000])
    })

    it('getOlderChunks は指定時刻より古いものを新しい順に指定件数', async () => {
        expect((await getOlderChunks('Chunks', 4000, 2)).map(c => c.createdAt)).toEqual([3000, 2000])
    })

    it('deleteAllChunks は録画と一時データをすべて削除し、削除が確定してから返る', async () => {
        await putTemp('S-temp', 0)

        await deleteAllChunks()

        expect(await getChunksCount('Chunks')).toBe(0)
        expect(await getChunksCount('Temps')).toBe(0)
    })
})

describe('日時の整形', () => {
    const date = new Date(2025, 0, 2, 3, 4, 5).getTime()

    it('表示用は時刻を「:」で区切る', () => {
        expect(formatDate(date)).toBe('2025-01-02 03:04:05')
    })

    it('ファイル名用は「:」を使わない', () => {
        expect(formatDateForFileName(date)).toBe('2025-01-02 030405')
    })
})

describe('IndexedDB の接続', () => {
    it('操作のたびに開き直さず、接続を使い回す', async () => {
        await putTemp('warm-up', 0) // 最初の接続を開いておく
        const open = vi.spyOn(indexedDB, 'open')

        await putTemp('S1', 0)
        await getAllChunks('Temps')
        await getChunksCount('Chunks')

        expect(open).not.toHaveBeenCalled()
        open.mockRestore()
    })

    it('他から DB の削除を求められたら接続を閉じて妨げず、次の操作で開き直す', async () => {
        await putTemp('S2', 0)

        // 接続を閉じなければ削除は blocked のまま終わらない
        const deleted = await new Promise<string>((resolve) => {
            const request = indexedDB.deleteDatabase('RecordingDB')
            request.onsuccess = () => resolve('deleted')
            request.onblocked = () => resolve('blocked')
        })
        expect(deleted).toBe('deleted')

        // 開き直してストアも作り直される
        await putTemp('S3', 0)
        expect((await getAllChunks('Temps')).map(c => c.sessionId)).toEqual(['S3'])
    })
})
