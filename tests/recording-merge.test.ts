import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveChunk, saveMergedChunk, getAllChunks, deleteAllChunks } from '@/hooks/indexedDB/recordingDB'
import { mergeStaleChunks, mergeChunksBySession, holdSegmentLock } from '@/utils/recording'
import { extractFirstFrame } from '@/utils/feature'
import { insertRecordedMovie } from '@/utils/ui'
import { setLocks } from './helpers/locks'

// 動画のデコードや DOM 操作は Node では動かないのでスタブにする
vi.mock('@/utils/feature', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/feature')>()),
    extractFirstFrame: vi.fn(),
}))
vi.mock('@/utils/ui', () => ({
    insertRecordedMovie: vi.fn(),
    deleteMovieIcon: vi.fn(),
    setRecordingStatus: vi.fn(),
    getTimeString: () => '00:00',
}))
vi.mock('@/services/api', () => ({ checkLiveStatus: vi.fn(async () => 'ON_AIR') }))

const SAVE_CHUNK_INTERVAL_MS = 3 * 1000
const OLD = Date.now() - 60 * 1000

// 一時データ（Temps）にチャンクを n 個保存する
const putTemps = async (sessionId: string, n: number, createdAt: number, content = 'ok') => {
    for (let i = 0; i < n; i++) {
        const blob = new Blob([`${content}-${i}`], { type: 'video/mp4' })
        await saveChunk('Temps', sessionId, i, blob, null, createdAt + i, 'user', 'title')
    }
}
const tempsOf = async (sessionId: string) => (await getAllChunks('Temps')).filter(c => c.sessionId === sessionId)
const chunksOf = async (sessionId: string) => (await getAllChunks('Chunks')).filter(c => c.sessionId === sessionId)
// ロックの取得など、保留中の処理を進める
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(async () => {
    await deleteAllChunks()
    vi.mocked(insertRecordedMovie).mockClear()
    // 動画の中身で結果を切り替える: BAD = 読み込めない動画、SLOW = サムネイル取得のタイムアウト、THROW = 例外
    vi.mocked(extractFirstFrame).mockImplementation(async (blob: Blob) => {
        const text = await blob.text()
        if (text.includes('BAD')) return ''
        if (text.includes('SLOW')) return null
        if (text.includes('THROW')) throw new Error('unexpected')
        return 'data:image/jpeg;base64,THUMB'
    })
})

describe('mergeStaleChunks', () => {
    it('ロックのない放置区間を1本の動画に結合し、一時データを消す', async () => {
        await putTemps('S1', 3, OLD)

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        const chunks = await chunksOf('S1')
        expect(chunks).toHaveLength(1)
        expect(chunks[0]).toMatchObject({ imgUrl: 'data:image/jpeg;base64,THUMB', userName: 'user', title: 'title' })
        expect(await chunks[0].blob.text()).toBe('ok-0ok-1ok-2')
        expect(await tempsOf('S1')).toHaveLength(0)
    })

    it('作成時刻が前後していても、録画した順（通し番号順）に結合する', async () => {
        // PC の時計が途中で戻った場合を想定
        const createdAt = [OLD + 2000, OLD + 1000, OLD + 3000]
        for (let i = 0; i < 3; i++) {
            await saveChunk('Temps', 'S-clock', i, new Blob([`ok-${i}`], { type: 'video/mp4' }), null, createdAt[i], 'user', 'title')
        }

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        const [chunk] = await chunksOf('S-clock')
        expect(await chunk.blob.text()).toBe('ok-0ok-1ok-2')
    })

    it('録画中（ロック保持中）の区間は古く見えても結合せず、解放後に結合する', async () => {
        await putTemps('S2', 3, OLD)
        const release = holdSegmentLock('S2')
        await flush()

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)
        expect(await tempsOf('S2')).toHaveLength(3)
        expect(await chunksOf('S2')).toHaveLength(0)

        release()
        await flush()
        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)
        expect(await tempsOf('S2')).toHaveLength(0)
        expect(await chunksOf('S2')).toHaveLength(1)
    })

    it('最近のチャンクがある区間は結合しない', async () => {
        await putTemps('S3', 3, Date.now())

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        expect(await tempsOf('S3')).toHaveLength(3)
        expect(await chunksOf('S3')).toHaveLength(0)
    })

    it('同時に実行しても重複して保存しない', async () => {
        await putTemps('S4', 3, OLD)

        await Promise.all([mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS), mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)])

        expect(await chunksOf('S4')).toHaveLength(1)
        expect(await tempsOf('S4')).toHaveLength(0)
    })

    it('動画として読み込めない区間は保存せずに破棄する', async () => {
        await putTemps('S5', 3, OLD, 'BAD')

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        expect(await tempsOf('S5')).toHaveLength(0)
        expect(await chunksOf('S5')).toHaveLength(0)
    })

    it('サムネイルが取得できなかった区間はデフォルト画像（imgUrl=null）で保存する', async () => {
        await putTemps('S6', 3, OLD, 'SLOW')

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        const chunks = await chunksOf('S6')
        expect(chunks).toHaveLength(1)
        expect(chunks[0].imgUrl).toBeNull()
        expect(await tempsOf('S6')).toHaveLength(0)
    })

    it('チャンクが2個以下の区間は破棄する', async () => {
        await putTemps('S7', 2, OLD)

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        expect(await tempsOf('S7')).toHaveLength(0)
        expect(await chunksOf('S7')).toHaveLength(0)
    })

    it('1つの区間で失敗しても、その区間の一時データを残して他の区間は処理する', async () => {
        await putTemps('S-fail', 3, OLD, 'THROW')
        await putTemps('S-ok', 3, OLD)

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        expect(await tempsOf('S-fail')).toHaveLength(3)
        expect(await chunksOf('S-ok')).toHaveLength(1)
    })

    it('Web Locks がない環境でも時間の判定で結合する', async () => {
        setLocks(undefined)
        await putTemps('S10', 3, OLD)

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)

        expect(await chunksOf('S10')).toHaveLength(1)
        expect(await tempsOf('S10')).toHaveLength(0)
    })

    it('Web Locks が失敗する環境でも時間の判定で結合する', async () => {
        setLocks({ request: () => Promise.reject(new DOMException('denied', 'SecurityError')) })
        await putTemps('S11', 3, OLD)
        const release = holdSegmentLock('S11') // 取得に失敗しても例外にならない
        await flush()

        await mergeStaleChunks(SAVE_CHUNK_INTERVAL_MS)
        release()

        expect(await chunksOf('S11')).toHaveLength(1)
        expect(await tempsOf('S11')).toHaveLength(0)
    })
})

describe('mergeChunksBySession', () => {
    it('自分の区間のロックを持ったままでも結合でき、一覧に追加する', async () => {
        await putTemps('S8', 3, Date.now())
        const release = holdSegmentLock('S8')
        await flush()

        await mergeChunksBySession('S8')
        release()

        expect(await chunksOf('S8')).toHaveLength(1)
        expect(await tempsOf('S8')).toHaveLength(0)
        expect(insertRecordedMovie).toHaveBeenCalledTimes(1)
    })
})

describe('saveMergedChunk', () => {
    it('途中で失敗したら Chunks への保存も取り消し、一時データを残す', async () => {
        await putTemps('S9', 3, Date.now())
        const invalidKey = {} as IDBValidKey

        await expect(
            saveMergedChunk('S9', 999, new Blob(['x']), null, Date.now(), 'u', 't', [['S9', 0], invalidKey])
        ).rejects.toThrow()

        expect(await chunksOf('S9')).toHaveLength(0)
        expect(await tempsOf('S9')).toHaveLength(3)
    })
})
