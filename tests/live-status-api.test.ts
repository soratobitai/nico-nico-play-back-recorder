// @vitest-environment happy-dom
// ライブ状態の取得（視聴ページを取り直して、埋め込みデータの番組の状態を読む）
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkLiveStatus } from '@/services/api'

const respond = (body: string, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('checkLiveStatus', () => {
    it('番組の状態を読む', async () => {
        respond(`<script id="embedded-data" data-props='{"program":{"status":"ON_AIR"}}'></script>`)
        expect(await checkLiveStatus()).toBe('ON_AIR')
    })

    it('番組がない（404・410）は NOT_FOUND（取り直しても変わらないので、取得の失敗とは分ける）', async () => {
        respond('', 404)
        expect(await checkLiveStatus()).toBe('NOT_FOUND')
        respond('', 410)
        expect(await checkLiveStatus()).toBe('NOT_FOUND')
    })

    it('サーバーのエラー・番組情報が読めないページは ERROR（確かめ直す）', async () => {
        respond('', 503)
        expect(await checkLiveStatus()).toBe('ERROR')
        respond('<p>メンテナンス中</p>')
        expect(await checkLiveStatus()).toBe('ERROR')
    })
})
