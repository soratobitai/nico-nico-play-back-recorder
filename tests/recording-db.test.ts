// 以前のバージョンの録画の保存先（拡張機能側へ移すために読み出す・消す）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChunk, getAllChunks, deleteChunkByKeys, hasLegacyDatabase, deleteLegacyDatabase } from '@/hooks/indexedDB/recordingDB'
import { formatDateForFileName } from '@/utils/feature'

const putTemp = (sessionId: string, chunkIndex: number) =>
    saveChunk('Temps', sessionId, chunkIndex, new Blob(['x'], { type: 'video/mp4' }), null, Date.now(), 'user', 'title')
const putRecording = (createdAt: number) =>
    saveChunk('Chunks', `S${createdAt}`, createdAt, new Blob(['x'], { type: 'video/mp4' }), null, createdAt, 'user', 'title')

describe('以前の録画の読み出しと削除', () => {
    beforeEach(async () => {
        await deleteLegacyDatabase()
    })

    it('getAllChunks は作成時刻の古い順', async () => {
        // キーの順（sessionId 順）と作成時刻の順が違うように保存する
        for (const createdAt of [3000, 1000, 5000, 2000, 4000]) await putRecording(createdAt)

        expect((await getAllChunks('Chunks')).map(c => c.createdAt)).toEqual([1000, 2000, 3000, 4000, 5000])
    })

    it('deleteChunkByKeys は指定したものだけを消し、消し終えてから返る', async () => {
        await putRecording(1000)
        await putRecording(2000)

        await deleteChunkByKeys('Chunks', [['S1000', 1000]])

        expect((await getAllChunks('Chunks')).map(c => c.createdAt)).toEqual([2000])
    })

    it('保存先があるかを調べ、まるごと消せる', async () => {
        expect(await hasLegacyDatabase()).toBe(false)
        await putTemp('S', 0)
        expect(await hasLegacyDatabase()).toBe(true)

        await deleteLegacyDatabase()

        expect(await hasLegacyDatabase()).toBe(false)
    })
})

describe('日時の整形', () => {
    const date = new Date(2025, 0, 2, 3, 4, 5).getTime()

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
        await getAllChunks('Chunks')

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
