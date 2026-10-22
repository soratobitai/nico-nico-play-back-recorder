// 拡張機能側の保存先へ移すもの（一時保存した書き込み・以前のバージョンの録画）
import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { setPendingSigningKey, savePendingRequest, flushPendingRequests, clearPendingRequests } from '@/utils/library/pending'
import { migrateLegacyRecordings, importLegacyRecordings, summarizeLegacyRecordings, type LegacyImportProgress } from '@/utils/library/migrate'
import { handleBridgeRequest } from '@/utils/library/handler'
import { clearAll, listAllSegments, buildDownloadFiles } from '@/utils/library/db'
import { saveChunk, getAllChunks, hasLegacyDatabase, deleteLegacyDatabase } from '@/hooks/indexedDB/recordingDB'
import { splitFmp4Blob } from '@/utils/fmp4'
import type { BridgeRequest } from '@/utils/library/protocol'

const fixture = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures/recorder-sample.mp4')))
const fixtureBlob = new Blob([fixture], { type: 'video/mp4' })

const databaseExists = async (name: string) => (await indexedDB.databases()).some(db => db.name === name)
const deleteDatabase = (name: string) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
})

class Discardable extends Error {}
class Unavailable extends Error {}
const isDiscardable = (error: unknown) => error instanceof Discardable
const finish = (segmentId: string): BridgeRequest => ({ type: 'finishSegment', segmentId, endedAt: 0 })
const flush = (send: (request: BridgeRequest) => Promise<unknown>) => flushPendingRequests({ send, isDiscardable })

// ページのスクリプトが、一時保存の DB に直接書き込む
const addRaw = async (value: unknown) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('PlaybackPending', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('requests', { autoIncrement: true })
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('requests', 'readwrite')
        tx.objectStore('requests').add(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
    db.close()
}

describe('一時保存した書き込み', () => {
    beforeEach(async () => {
        await deleteDatabase('PlaybackPending')
        await setPendingSigningKey(new Uint8Array(32).fill(7))
    })

    it('保存した順に送り、送れたものは消す', async () => {
        await savePendingRequest(finish('A'))
        await savePendingRequest(finish('B'))
        const sent: BridgeRequest[] = []

        expect(await flush(async request => { sent.push(request) })).toEqual({ sent: 2, complete: true })
        expect(sent).toEqual([finish('A'), finish('B')])
        expect(await flush(async request => { sent.push(request) })).toEqual({ sent: 0, complete: true })
    })

    it('送れなかった（やり取りできない・容量不足 など）ら、残りは消さずに次の機会に送る', async () => {
        await savePendingRequest(finish('A'))
        await savePendingRequest(finish('B'))
        await savePendingRequest(finish('C'))
        const sent: string[] = []
        const send = (failOn: string) => async (request: BridgeRequest) => {
            const { segmentId } = request as { segmentId: string }
            if (segmentId === failOn) throw new Unavailable()
            sent.push(segmentId)
        }

        expect(await flush(send('B'))).toEqual({ sent: 1, complete: false })
        expect(await flush(send(''))).toEqual({ sent: 2, complete: true })
        expect(sent).toEqual(['A', 'B', 'C'])
    })

    it('送っても意味がないエラー（区間が消されていた など）になった書き込みは捨てて先へ進む', async () => {
        await savePendingRequest(finish('A'))
        await savePendingRequest(finish('B'))
        const sent: string[] = []

        await flush(async (request) => {
            const { segmentId } = request as { segmentId: string }
            if (segmentId === 'A') throw new Discardable('not found')
            sent.push(segmentId)
        })

        expect(sent).toEqual(['B'])
        expect(await flush(async () => {})).toEqual({ sent: 0, complete: true })
    })

    it('ページのスクリプトが入れた依頼（印がない・印が違う・録画中の書き込みでない）は、送らずに捨てる', async () => {
        await savePendingRequest(finish('A'))
        await addRaw({ type: 'clearAll' }) // 以前の形（印なし）
        await addRaw({ request: { type: 'clearAll' }, signature: new ArrayBuffer(32) })
        await addRaw({ request: finish('B'), signature: new ArrayBuffer(32) }) // 印が違う
        // 鍵を知らないので、正しい印は作れない。印の付いた本物の依頼を書き換えても、印が合わなくなる
        const sent: BridgeRequest[] = []

        expect(await flush(async request => { sent.push(request) })).toEqual({ sent: 1, complete: true })
        expect(sent).toEqual([finish('A')])
    })

    it('鍵が違えば（別の鍵で付けた印）、送らない', async () => {
        await savePendingRequest(finish('A'))
        await setPendingSigningKey(new Uint8Array(32).fill(9))
        const sent: BridgeRequest[] = []

        expect(await flush(async request => { sent.push(request) })).toEqual({ sent: 0, complete: true })
        expect(sent).toEqual([])
    })

    it('すべての録画を削除する時は、録画のデータ（断片）だけ消し、区間を作る依頼などは残す（録画中の区間の続きを保存できるように）', async () => {
        const create: BridgeRequest = { type: 'createSegment', segment: { segmentId: 'A', programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', title: '', userName: '', startedAt: 0, thumbnail: null } }
        const init: BridgeRequest = { type: 'setSegmentInit', segmentId: 'A', init: new Blob(['init']) }
        const append: BridgeRequest = { type: 'appendFragments', segmentId: 'A', fragments: [] }
        for (const request of [create, init, append, finish('A')]) await savePendingRequest(request)

        await clearPendingRequests()

        const sent: string[] = []
        await flush(async (request) => { sent.push(request.type) })
        expect(sent).toEqual(['createSegment', 'setSegmentInit', 'finishSegment'])
    })

    it('一時保存したことがなければ、DB を作らない', async () => {
        expect(await flush(async () => {})).toEqual({ sent: 0, complete: true })
        expect(await databaseExists('PlaybackPending')).toBe(false)
    })
})

describe('以前のバージョンの録画を移す', () => {
    // 拡張機能側の保存先（bridge）に直接つないだ call
    const call = handleBridgeRequest as Parameters<typeof migrateLegacyRecordings>[0]
    const minutesAgo = (minutes: number) => Date.now() - minutes * 60 * 1000

    beforeEach(async () => {
        await clearAll()
        await deleteLegacyDatabase()
    })

    it('結合済みの録画と、取り残された一時データを移し、以前の保存先を消す', async () => {
        await saveChunk('Chunks', 'S1', 0, fixtureBlob, 'data:image/jpeg;base64,THUMB', 5000, 'user', 'title')
        // 録画中に約3秒ごとに届いた一時データ（つなぐと1本の MP4 になる）
        const parts = [fixture.subarray(0, 50000), fixture.subarray(50000, 120000), fixture.subarray(120000)]
        for (const [i, part] of parts.entries()) {
            await saveChunk('Temps', 'S2', i, new Blob([part], { type: 'video/mp4' }), null, minutesAgo(10) + i * 3000, 'user2', 'title2')
        }

        expect(await migrateLegacyRecordings(call)).toBe(2)

        const segments = await listAllSegments()
        expect(segments.map(s => [s.title, s.userName, s.format])).toEqual(expect.arrayContaining([
            ['title', 'user', 'fmp4'], ['title2', 'user2', 'fmp4'],
        ]))
        const expected = (await splitFmp4Blob(fixtureBlob)).fragments.length
        for (const segment of segments) {
            expect(segment.fragmentCount).toBe(expected)
            const [file] = await buildDownloadFiles([segment.segmentId])
            expect((await splitFmp4Blob(file.blob)).fragments).toHaveLength(expected)
        }
        const fromChunks = segments.find(s => s.title === 'title')!
        expect(fromChunks.endedAt).toBe(5000)
        expect(fromChunks.thumbnail).toBe('data:image/jpeg;base64,THUMB')
        expect(await hasLegacyDatabase()).toBe(false)
    })

    it('途中で中断して移し直しても、同じ録画を2本にしない（途中まで移した区間を置き換える）', async () => {
        await saveChunk('Chunks', 'S1', 0, fixtureBlob, null, 5000, 'user', 'title')
        // 1回目は断片を送った後、確定する前に中断した（以前の保存先には残っている）
        const interrupted: typeof call = async (request) => {
            if (request.type === 'finishSegment') throw new Error('タブが閉じられた')
            return call(request)
        }
        await expect(migrateLegacyRecordings(interrupted)).rejects.toThrow()

        expect(await migrateLegacyRecordings(call)).toBe(1)

        const segments = await listAllSegments()
        expect(segments).toHaveLength(1)
        expect(segments[0].fragmentCount).toBe((await splitFmp4Blob(fixtureBlob)).fragments.length)
    })

    it('MP4 として読めない録画（webm）は、そのまま1つの断片として移す', async () => {
        const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: 'video/webm' })
        await saveChunk('Chunks', 'S1', 0, webm, null, 5000, 'user', 'title')

        await migrateLegacyRecordings(call)

        const [segment] = await listAllSegments()
        expect(segment.format).toBe('opaque')
        const [file] = await buildDownloadFiles([segment.segmentId])
        expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(new Uint8Array(await webm.arrayBuffer()))
    })

    it('古いバージョンがまだ録画中かもしれない一時データには触らず、以前の保存先も残す', async () => {
        await saveChunk('Temps', 'S1', 0, fixtureBlob, null, Date.now(), 'user', 'title')

        expect(await migrateLegacyRecordings(call)).toBe(0)

        expect(await listAllSegments()).toEqual([])
        expect(await getAllChunks('Temps')).toHaveLength(1)
        expect(await hasLegacyDatabase()).toBe(true)
    })

    it('他のタブで移している最中なら、同じ録画を二重に移さない', async () => {
        await saveChunk('Chunks', 'S1', 0, fixtureBlob, null, 5000, 'user', 'title')

        const counts = await Promise.all([migrateLegacyRecordings(call), migrateLegacyRecordings(call)])

        expect(counts.sort()).toEqual([0, 1])
        expect(await listAllSegments()).toHaveLength(1)
    })

    it('取り込む本数と大きさを数え、進み具合を知らせ、やめると言われたら1本を移し終えてからやめる', async () => {
        for (let i = 0; i < 3; i++) await saveChunk('Chunks', 'S1', i, fixtureBlob, null, 5000 + i, 'user', 'title')
        expect(await summarizeLegacyRecordings()).toEqual({ count: 3, bytes: fixtureBlob.size * 3 })

        const progress: LegacyImportProgress[] = []
        const result = await importLegacyRecordings(call, {
            onProgress: p => progress.push(p),
            isCancelled: () => progress.some(p => p.done === 1),
        })

        expect(result).toEqual({ migrated: 1, cancelled: true, busy: false, remaining: { count: 2, bytes: fixtureBlob.size * 2 } })
        expect(progress[0]).toMatchObject({ done: 0, total: 3, bytesDone: 0, bytesTotal: fixtureBlob.size * 3 })
        expect(progress.at(-1)).toMatchObject({ done: 1, bytesDone: fixtureBlob.size })
        // 途中の進み具合（断片をまとめて送るたび）も知らせる
        expect(progress.some(p => p.done === 0 && p.bytesDone > 0)).toBe(true)
        // 残りは以前の保存先に残り、続きから取り込める
        expect(await summarizeLegacyRecordings()).toEqual({ count: 2, bytes: fixtureBlob.size * 2 })
        expect(await importLegacyRecordings(call)).toEqual({ migrated: 2, cancelled: false, busy: false, remaining: null })
        expect(await hasLegacyDatabase()).toBe(false)
        expect(await listAllSegments()).toHaveLength(3)
        expect(await summarizeLegacyRecordings()).toBeNull()
    })

    it('以前の保存先がなければ何もせず、作りもしない', async () => {
        expect(await migrateLegacyRecordings(call)).toBe(0)
        expect(await hasLegacyDatabase()).toBe(false)
    })
})
