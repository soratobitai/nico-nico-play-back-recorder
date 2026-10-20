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
