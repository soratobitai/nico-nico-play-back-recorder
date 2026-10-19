// ニコ生のページから保存先を使う: 拡張機能側に保存できない間の一時保存
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewSegment, NewFragment } from '@/utils/library/db'

vi.mock('@/utils/library/client', () => {
    class BridgeUnavailableError extends Error {}
    return { getBridge: vi.fn(), BridgeUnavailableError, isExtensionContextValid: vi.fn(() => true) }
})
vi.mock('@/utils/library/pending', () => ({
    savePendingRequest: vi.fn(async () => {}),
    flushPendingRequests: vi.fn(),
    clearPendingRequests: vi.fn(),
}))

// 一時保存した量などはページごと（モジュールごと）に数えるので、テストごとに読み込み直す
let api: typeof import('@/utils/library/api')
let client: typeof import('@/utils/library/client')
let pending: typeof import('@/utils/library/pending')
const call = vi.fn()

const segment = (segmentId: string): NewSegment => ({
    segmentId, programId: 'lv1', kind: 'video', format: 'fmp4', mimeType: 'video/mp4', title: '', userName: '', startedAt: 0, thumbnail: null,
})
const fragment = (index: number, size = 100): NewFragment => ({
    index, blob: new Blob([new Uint8Array(size)]), moofSize: 0, startTime: index, duration: 1, wallClock: index,
})
const pendingTypes = () => vi.mocked(pending.savePendingRequest).mock.calls.map(([request]) => request.type)

beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    api = await import('@/utils/library/api')
    client = await import('@/utils/library/client')
    pending = await import('@/utils/library/pending')
    call.mockReset()
    vi.mocked(client.getBridge).mockResolvedValue({ call } as never)
})

describe('一時保存', () => {
    it('区間を作る依頼を一時保存したら、その区間の続きは、一時保存した分を先に移せた時だけ直接保存する（順番が入れ替わって捨てられないように）', async () => {
        call.mockRejectedValueOnce(new client.BridgeUnavailableError('timeout'))
        await api.createSegment(segment('A'))

        // まだ移せない間は、続きも一時保存する
        vi.mocked(pending.flushPendingRequests).mockResolvedValueOnce({ sent: 0, complete: false })
        await api.appendFragments('A', [fragment(0)])
        expect(pendingTypes()).toEqual(['createSegment', 'appendFragments'])
        expect(call).toHaveBeenCalledTimes(1)

        // 一時保存した分をすべて移せたら、続きは直接保存する
        vi.mocked(pending.flushPendingRequests).mockResolvedValueOnce({ sent: 2, complete: true })
        await api.appendFragments('A', [fragment(1)])
        await api.finishSegment('A', 1000)

        expect(pendingTypes()).toEqual(['createSegment', 'appendFragments'])
        expect(call.mock.calls.map(([request]) => request.type)).toEqual(['createSegment', 'appendFragments', 'finishSegment'])
    })

    it('拡張機能が更新された後は、一時保存は上限まで。超えたら容量不足にする（録画を止めてお知らせする）', async () => {
        api.setPendingLimit(250)
        vi.mocked(client.isExtensionContextValid).mockReturnValue(false)
        vi.mocked(client.getBridge).mockRejectedValue(new client.BridgeUnavailableError('invalidated'))
        await api.createSegment(segment('A'))
        await api.appendFragments('A', [fragment(0), fragment(1)])

        await expect(api.appendFragments('A', [fragment(2)])).rejects.toMatchObject({ name: 'QuotaExceededError' })
        // 区間の確定は小さいので、上限を超えていても一時保存する
        await api.finishSegment('A', 1000)
        expect(pendingTypes()).toEqual(['createSegment', 'appendFragments', 'finishSegment'])
    })
})
