// ニコ生のページから bridge につなぐ
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let client: typeof import('@/utils/library/client')

beforeEach(async () => {
    vi.resetModules()
    client = await import('@/utils/library/client')
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('getBridge', () => {
    it('つなぐ途中のエラー（background から返事がない など）は、やり取りできないエラーにする（一時保存に回し、移している分を捨てない）', async () => {
        vi.stubGlobal('chrome', {
            runtime: {
                id: 'extension',
                sendMessage: vi.fn(async () => { throw new Error('Could not establish connection. Receiving end does not exist.') }),
                getURL: (path: string) => `chrome-extension://extension${path}`,
            },
        })

        await expect(client.getBridge()).rejects.toBeInstanceOf(client.BridgeUnavailableError)
    })

    it('返事が空でも、やり取りできないエラーにする', async () => {
        vi.stubGlobal('chrome', {
            runtime: {
                id: 'extension',
                sendMessage: vi.fn(async () => undefined),
                getURL: (path: string) => `chrome-extension://extension${path}`,
            },
        })

        await expect(client.getBridge()).rejects.toBeInstanceOf(client.BridgeUnavailableError)
    })
})
