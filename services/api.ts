const checkLiveStatus = async () => {
    const url = location.href

    try {
        const res = await fetch(url, {
            headers: {
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache'
            },
            // 通信が応答しないまま止まると、録画の監視（再確認や停止）も止まってしまうので打ち切る
            signal: AbortSignal.timeout(10 * 1000),
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const html = await res.text()
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const jsonScript = doc.querySelector('#embedded-data')
        const data = JSON.parse(jsonScript?.getAttribute('data-props') ?? '{}')
        const status = data?.program?.status

        // メンテナンス画面などで番組情報が取れない場合も取得失敗として扱う
        return status ?? 'ERROR'

    } catch (error) {
        console.error('ライブ状態の取得に失敗しました:', error)
        return 'ERROR'
    }
}

export { checkLiveStatus }