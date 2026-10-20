// 録画を見る画面の操作の行が入りきらない時に、いらないものから順に隠す
// （隠すものを .review の data-hide に並べ、style.ts の .review[data-hide~="…"] で隠す）
// 入りきるかは、幅だけでなく、時間の文字の長さ・種類の数などでも変わるので、それらが変わった時にも確かめ直す

// 隠す順（いらないものから）
const HIDE_ORDER = [
    'labels', // 「10秒」「音を出す」の文字
    'skip', // 10秒戻る・進む（←・→でも操作できる）
    'play', // 再生・一時停止（動画を押す・スペースでも操作できる）
    'program', // 番組の経過時間
    'ago', // ライブからどれだけ前か
    'live-label', // 「ライブ」の文字（丸だけにする）
    'behind', // 2段目（その場面の時刻）
    'tight', // ボタンの間を詰める
    'scroll', // それでも入りきらなければ、重ねずに横にスクロールする
] as const

// 中身が、行の3つの場所（左・真ん中・右）のそれぞれからはみ出していないか（大きさが 0 の隠れたものは数えない）
const groupsFit = (row: Element) => [...row.children].every((group) => {
    const box = group.getBoundingClientRect()
    return [...group.children].every((child) => {
        const rect = child.getBoundingClientRect()
        return rect.width === 0 || (rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5)
    })
})
// 折り返して、隠れる2行目に回っているか（1行の高さの入れ物の下の端より下にあるか。文字の大きさが違うと、同じ行でも上の端はそろわない）
const wrapped = (element: Element, line: Element) => element.getBoundingClientRect().top >= line.getBoundingClientRect().bottom - 1

const createRowFitter = (container: HTMLElement) => {
    const $ = (selector: string) => container.querySelector<HTMLElement>(selector)!
    const row = $('.row')
    const timeMain = $('.time-main')
    const clock = $('.clock')
    const programTime = $('.program-time')
    const behind = $('.behind')
    const sceneTime = $('.scene-time')
    const ago = $('.ago')

    const fits = (hidden: readonly string[]) => {
        if (!groupsFit(row)) return false
        // 録画の時間が切れていない
        if (clock.getBoundingClientRect().right > timeMain.getBoundingClientRect().right + 0.5) return false
        // 番組の経過時間・ライブからどれだけ前かは、その番になるまでは折り返して隠れていない（真ん中のボタンより先に隠れないように）
        if (!hidden.includes('program') && programTime.textContent && wrapped(programTime, timeMain)) return false
        if (!hidden.includes('ago') && !behind.hidden && ago.textContent && wrapped(ago, behind)) return false
        // その場面の時刻が … で切れていない
        if (!hidden.includes('behind') && !behind.hidden && sceneTime.scrollWidth > sceneTime.clientWidth + 0.5) return false
        return true
    }

    // いったん全部出してから、入りきるまで順に隠す（描く前に行うので、ちらつかない）
    const fit = () => {
        if (container.getBoundingClientRect().width === 0) return
        const focused = container.ownerDocument.activeElement
        const hidden: string[] = []
        container.dataset.hide = ''
        for (const name of HIDE_ORDER) {
            if (fits(hidden)) break
            hidden.push(name)
            container.dataset.hide = hidden.join(' ')
        }
        // フォーカスのあるボタンを隠したら、シークバーへ移す（ページの先頭へ外れないように）
        // （プレイバックのウィンドウの要素は、そのウィンドウの HTMLElement で見分ける）
        const OwnHTMLElement = container.ownerDocument.defaultView?.HTMLElement ?? HTMLElement
        if (focused instanceof OwnHTMLElement && focused !== container && container.contains(focused) && focused.getBoundingClientRect().width === 0) {
            $('.seek').focus({ preventScroll: true })
        }
    }

    // 次に描く前に1回だけ確かめる（プレイバックのウィンドウでは、そのウィンドウの描画に合わせる）
    const win = (container.ownerDocument.defaultView ?? window) as Window & typeof globalThis
    let frame = 0
    const schedule = () => {
        if (frame) return
        frame = win.requestAnimationFrame(() => {
            frame = 0
            fit()
        })
    }
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null
    observer?.observe(container)
    void container.ownerDocument.fonts?.ready.then(schedule)
    schedule()

    return {
        schedule,
        destroy() {
            observer?.disconnect()
            if (frame) win.cancelAnimationFrame(frame)
        },
    }
}

export { createRowFitter, HIDE_ORDER }
