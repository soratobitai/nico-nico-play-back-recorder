// ニコ生のプレイヤーの再生が落ち着いているか（録画を始める前に待つ）
// 録画を始める（エンコーダーを用意する）瞬間に、低スペックの PC ではプレイヤーが一瞬止まることがある。
// ページを開いた直後など、プレイヤーの先読みが少なく不安定な間に止まると、ニコ生の通信モードが「低遅延重視」だと
// 止まっては先へ飛ぶのを繰り返し、ページを開き直すまで続くことがある。そこで、止まらずに続けて再生してから録り始める

// これだけ続けて止まらずに再生していたら、落ち着いているとする
const STABLE_PLAYBACK_MS = 5 * 1000
// 再生が進んでいるかを確かめる間隔
const STABLE_POLL_MS = 500
// HTMLMediaElement.HAVE_FUTURE_DATA（少し先まで読み込んである）
const HAVE_FUTURE_DATA = 3

const watchPlaybackStability = (video: HTMLVideoElement, stableMs = STABLE_PLAYBACK_MS) => {
    // 最後に止まっていた（再生が進んでいなかった）時刻。見始めた時は、まだ落ち着いていないとする
    let unstableAt = Date.now()
    let lastTime = video.currentTime
    const mark = () => {
        unstableAt = Date.now()
    }
    // 読み込み待ち・先へ飛んだ・一時停止・読み込み直しは、すぐに分かる
    for (const type of ['waiting', 'seeking', 'pause', 'emptied']) video.addEventListener(type, mark)
    // 出来事のないまま止まっている時のために、再生が進んでいるかも確かめる
    setInterval(() => {
        const progressing = !video.paused && video.readyState >= HAVE_FUTURE_DATA && video.currentTime !== lastTime
        lastTime = video.currentTime
        if (!progressing) mark()
    }, STABLE_POLL_MS)

    const isStable = () => Date.now() - unstableAt >= stableMs

    return {
        isStable,
        // 落ち着くまで待つ（maxMs 待っても落ち着かなければ、待つのをやめて true）。cancelled() が true になったら false
        waitUntilStable: (maxMs: number, cancelled: () => boolean) => new Promise<boolean>((resolve) => {
            const deadline = Date.now() + maxMs
            const poll = () => {
                if (cancelled()) return resolve(false)
                if (isStable() || Date.now() >= deadline) return resolve(true)
                setTimeout(poll, STABLE_POLL_MS)
            }
            poll()
        }),
    }
}

type PlaybackStability = ReturnType<typeof watchPlaybackStability>

export { watchPlaybackStability, STABLE_PLAYBACK_MS }
export type { PlaybackStability }
