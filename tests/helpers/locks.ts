// Node には Web Locks API がないため、テスト用の最小実装を用意する
// exclusive モードと ifAvailable のみ対応（取得できなければ仕様どおり callback(null) を呼ぶ）
export class FakeLockManager {
    private held = new Map<string, Promise<void>>()

    async request(name: string, optionsOrCallback: unknown, maybeCallback?: unknown) {
        const options = (typeof optionsOrCallback === 'function' ? {} : optionsOrCallback) as LockOptions
        const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as LockGrantedCallback

        if (options.ifAvailable && this.held.has(name)) return callback(null)
        while (this.held.has(name)) await this.held.get(name)

        let release = () => {}
        this.held.set(name, new Promise<void>(resolve => { release = resolve }))
        try {
            return await callback({ name, mode: 'exclusive' } as Lock)
        } finally {
            this.held.delete(name)
            release()
        }
    }

    isHeld(name: string) {
        return this.held.has(name)
    }
}

export const setLocks = (locks: unknown) => {
    Object.defineProperty(navigator, 'locks', { value: locks, writable: true, configurable: true })
}
