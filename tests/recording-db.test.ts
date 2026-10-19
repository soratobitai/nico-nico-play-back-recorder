import { describe, expect, it, vi } from 'vitest'
import { saveChunk, getAllChunks, getChunksCount } from '@/hooks/indexedDB/recordingDB'

const putTemp = (sessionId: string, chunkIndex: number) =>
    saveChunk('Temps', sessionId, chunkIndex, new Blob(['x'], { type: 'video/mp4' }), null, Date.now(), 'user', 'title')

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
