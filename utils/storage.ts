export const MAX_STORAGE_SIZE = storage.defineItem<number>(
    'local:MAX_STORAGE_SIZE',
    {
        fallback: 1 * 1024 * 1024 * 1024, // 1GB
    }
)

export const AUTO_START = storage.defineItem<boolean>(
    'local:AUTO_START',
    {
        fallback: true,
    }
)

export const AUTO_RELOAD_ON_FAILURE = storage.defineItem<boolean>(
    'local:AUTO_RELOAD_ON_FAILURE',
    {
        fallback: false,
    }
)

export const UI_COLLAPSED = storage.defineItem<boolean>(
    'local:UI_COLLAPSED',
    {
        fallback: false,
    }
)

// 録画する種類（ON の種類は、別々の録画として同時に録る）
// コメントなし・コメントありは、少なくとも1つは ON にする
// コメントなし（映像と音声をそのまま）
export const RECORD_VIDEO = storage.defineItem<boolean>(
    'local:RECORD_VIDEO',
    {
        fallback: true,
    }
)
// コメントあり（流れるコメントを重ねる）
export const RECORD_WITH_COMMENTS = storage.defineItem<boolean>(
    'local:RECORD_WITH_COMMENTS',
    {
        fallback: false,
    }
)
// 画面録画（プレイヤーの画面をそのまま録る）は設定にしない。ブラウザの決まりで自動では始められないので、
// ページを開くたびに録画バーのボタンで始める

// 動画の解像度が変わった時
// split: 録画を分けて、元の解像度のまま録る / fixed: 一定の解像度（FIXED_RESOLUTION_HEIGHT）に描き直して録り続ける
export type ResolutionMode = 'split' | 'fixed'
export const RESOLUTION_MODE = storage.defineItem<ResolutionMode>(
    'local:RESOLUTION_MODE',
    {
        fallback: 'split',
    }
)
// 一定の解像度で録る時の高さ（幅は 16:9）
export const FIXED_RESOLUTION_HEIGHT = storage.defineItem<number>(
    'local:FIXED_RESOLUTION_HEIGHT',
    {
        fallback: 720,
    }
)

// 一時保存（ニコ生のページの IndexedDB）に書く依頼に付ける印の鍵（base64。ニコ生のページのスクリプトは読めない。utils/library/pending.ts）
export const PENDING_SIGNING_KEY = storage.defineItem<string | null>(
    'local:PENDING_SIGNING_KEY',
    {
        fallback: null,
    }
)

// プレイバックのウィンドウの大きさ（最後に変えた大きさを、開く時に頼む大きさで。変えたことがなければ null）
// 他のタブで開く時に、この大きさで開く（位置は Chrome が決める。utils/review/window.ts）
export type PlaybackWindowSize = { width: number, height: number }
export const PLAYBACK_WINDOW_SIZE = storage.defineItem<PlaybackWindowSize | null>(
    'local:PLAYBACK_WINDOW_SIZE',
    {
        fallback: null,
    }
)
// プレイバックのウィンドウの、開く時に頼んだ大きさと外側の大きさの差（タイトルバーと枠の分。測ったことがなければ null）
export const PLAYBACK_WINDOW_FRAME = storage.defineItem<PlaybackWindowSize | null>(
    'local:PLAYBACK_WINDOW_FRAME',
    {
        fallback: null,
    }
)

// 以前のバージョン（1.2.2 まで）の録画が、ニコ生のサイトデータに残っているか（数と大きさ。なければ null）
// ニコ生のページを開いた時に調べて書き込み、録画一覧で取り込み（手動）を勧める
export type LegacyRecordings = { count: number, bytes: number }
export const LEGACY_RECORDINGS = storage.defineItem<LegacyRecordings | null>(
    'local:LEGACY_RECORDINGS',
    {
        fallback: null,
    }
)
