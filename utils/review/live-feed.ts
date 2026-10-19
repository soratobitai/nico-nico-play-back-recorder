// 録画中の区間に書き込んだデータを、同じページのプレイバックのウィンドウへ知らせる
// （録画中の最新の部分を、保存先から読み直さずにすぐ見られるように）
import type { NewSegment, NewFragment } from '../library/db'

type LiveFeedEvent =
    | { type: 'init', segment: NewSegment, init: Blob }
    | { type: 'fragments', segmentId: string, fragments: NewFragment[] }
    | { type: 'finish', segmentId: string, endedAt: number }

type LiveFeedListener = (event: LiveFeedEvent) => void

const listeners = new Set<LiveFeedListener>()

const publishLiveFeed = (event: LiveFeedEvent) => {
    for (const listener of listeners) {
        try {
            listener(event)
        } catch (error) {
            console.error('プレイバックのウィンドウへの通知に失敗しました:', error)
        }
    }
}

// 知らせを受け取る。返す関数を呼ぶと受け取るのをやめる
const subscribeLiveFeed = (listener: LiveFeedListener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export { publishLiveFeed, subscribeLiveFeed }
export type { LiveFeedEvent }
