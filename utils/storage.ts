export const RESTART_MEDIARECORDER_INTERVAL_MS = storage.defineItem<number>(
    'local:RESTART_MEDIARECORDER_INTERVAL_MS',
    {
        fallback: 1 * 60 * 1000, // 1分
    }
)

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

// 流れるコメントを含めて録画する
export const RECORD_WITH_COMMENTS = storage.defineItem<boolean>(
    'local:RECORD_WITH_COMMENTS',
    {
        fallback: false,
    }
)
