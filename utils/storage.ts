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
