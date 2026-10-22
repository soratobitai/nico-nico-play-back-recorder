// 録画一覧のページ: 以前のバージョンの録画を取り込む（手動）
// 以前の録画はニコ生のサイトデータにあるので、取り込み用のニコ生のページを裏で開いて、そのページに取り込んでもらう
// （utils/library/legacy-import.ts）。取り込んでいる間は、番組の一覧の上に進み具合を出す。
// 取り込んだ録画が容量の上限ですぐに消えないよう、始める前に上限と比べて、上げることを勧める。
import { LEGACY_RECORDINGS, MAX_STORAGE_SIZE, type LegacyRecordings } from '@/utils/storage'
import {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE,
    LEGACY_IMPORT_URL, LEGACY_IMPORT_TAB_KEY, type LegacyImportMessage,
} from '@/utils/library/legacy-import'
import type { LegacyImportProgress } from '@/utils/library/migrate'

const GB = 1024 ** 3
// 容量の上限の最大（設定画面と同じ）
const MAX_STORAGE_SIZE_LIMIT = 100 * GB
// 開いたニコ生のページで、取り込みが始まるまで待つ時間
const START_TIMEOUT_MS = 60 * 1000
// これだけ進み具合が届かなければ、取り込みが止まったとみなす（取り込んでいる間は、20秒ごとに知らせ直してくる）
const STALL_TIMEOUT_MS = 2 * 60 * 1000

type Finished = NonNullable<LegacyImportMessage['finished']>
type State =
    | { phase: 'idle' }
    | { phase: 'starting' }
    | { phase: 'running', progress: LegacyImportProgress, cancelling: boolean }
    | { phase: 'finished', result: Finished }
    | { phase: 'interrupted', reason: string }

type LegacyImportOptions = {
    notice: HTMLElement // 番組の一覧の上のお知らせ
    status: HTMLElement // 読み上げ用（段階が変わった時だけ書き換える）
    dialog: HTMLDialogElement
    usageBytes: () => Promise<number> // 今の使用量
    formatBytes: (bytes: number) => string
    reload: () => Promise<void> // 番組の一覧を読み直す
}

const setupLegacyImport = ({ notice, status, dialog, usageBytes, formatBytes, reload }: LegacyImportOptions) => {
    let legacy: LegacyRecordings | null = null
    let state: State = { phase: 'idle' }
    let timer: ReturnType<typeof setTimeout> | undefined
    let reloadTimer: ReturnType<typeof setTimeout> | undefined

    const $ = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
        const node = document.createElement(tag)
        if (className) node.className = className
        if (text !== undefined) node.textContent = text
        return node
    }
    const button = (text: string, onClick: () => void, className = 'button small') => {
        const node = element('button', className, text)
        node.type = 'button'
        node.addEventListener('click', onClick)
        return node
    }

    const importTabId = async () => {
        const { [LEGACY_IMPORT_TAB_KEY]: tabId } = await chrome.storage.session.get(LEGACY_IMPORT_TAB_KEY)
        return typeof tabId === 'number' ? tabId : null
    }

    // 取り込んだ録画が一覧に出るように、ときどき読み直す（1本ごとに読み直すと重いので、まとめて）
    const scheduleReload = () => {
        if (reloadTimer) return
        reloadTimer = setTimeout(() => {
            reloadTimer = undefined
            void reload()
        }, 2000)
    }

    // 今の段階（待っている間に、進み具合が届くなどして変わる）
    const phase = () => state.phase
    const setState = (next: State) => {
        const changed = next.phase !== state.phase
        state = next
        clearTimeout(timer)
        // 始まらない・止まったまま進まない時は、中断したとみなす（もう一度取り込むと、続きから取り込む）
        if (next.phase === 'starting') {
            timer = setTimeout(() => setState({ phase: 'interrupted', reason: 'ニコ生のページで取り込みを始められませんでした。' }), START_TIMEOUT_MS)
        } else if (next.phase === 'running') {
            timer = setTimeout(() => setState({ phase: 'interrupted', reason: '取り込みが止まりました。' }), STALL_TIMEOUT_MS)
        }
        render(changed)
    }

    // ---- 番組の一覧の上のお知らせ ----
    // 取り込んでいる間は、文字と進み具合だけを書き換える（押している「やめる」を作り直して、押せなくならないように）
    let running: { text: HTMLElement, bar: HTMLProgressElement, detail: HTMLElement, cancel: HTMLButtonElement } | null = null

    const progressBar = (ratio: number | null) => {
        const bar = element('progress', 'legacy-progress')
        bar.max = 1
        if (ratio !== null) bar.value = ratio
        bar.setAttribute('aria-label', '取り込みの進み具合')
        return bar
    }

    const updateRunning = (progress: LegacyImportProgress, cancelling: boolean) => {
        if (!running) return
        running.text.textContent = `以前の録画を取り込んでいます（${progress.done} / ${progress.total}本）`
        if (progress.bytesTotal > 0) running.bar.value = progress.bytesDone / progress.bytesTotal
        running.detail.textContent = `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}${progress.title ? `・${progress.title}` : ''}`
        running.cancel.textContent = cancelling ? 'やめています…' : 'やめる'
        // disabled にすると、キーボードで押した人のフォーカスが外れるので、押せないように見せるだけにする（もう一度押しても何もしない）
        running.cancel.setAttribute('aria-disabled', String(cancelling))
    }

    const render = (phaseChanged: boolean) => {
        if (state.phase === 'running' && running && !phaseChanged) {
            updateRunning(state.progress, state.cancelling)
            return
        }
        running = null
        const parts: HTMLElement[] = []
        let announce = ''
        switch (state.phase) {
            case 'idle':
                if (!legacy) break
                parts.push(
                    element('p', 'legacy-text', `以前のバージョンの録画が ${legacy.count}本（${formatBytes(legacy.bytes)}）あります。`),
                    button('取り込む…', openDialog, 'button small primary'),
                )
                break
            case 'starting':
                announce = '以前の録画の取り込みを始めます'
                parts.push(element('p', 'legacy-text', '取り込みの準備をしています…'), progressBar(null))
                break
            case 'running': {
                announce = '以前の録画を取り込んでいます'
                const cancel = button('やめる', () => void cancelImport())
                cancel.title = '取り込んでいる1本を取り込み終えてから、やめます（残りは後で取り込めます）'
                running = { text: element('p', 'legacy-text'), bar: progressBar(null), detail: element('p', 'legacy-detail'), cancel }
                parts.push(running.text, running.bar, running.detail, running.cancel)
                updateRunning(state.progress, state.cancelling)
                break
            }
            case 'finished': {
                const { result } = state
                const text = result.busy ? '他のタブで取り込んでいます。終わってから、もう一度お試しください。'
                    : result.error ? `取り込めませんでした（${result.migrated}本は取り込みました）。もう一度取り込むと、続きから取り込みます。`
                    : result.cancelled ? `取り込みをやめました（${result.migrated}本を取り込みました）。残りは後で取り込めます。`
                    : `以前の録画を ${result.migrated}本取り込みました。`
                announce = text
                parts.push(element('p', 'legacy-text', text))
                if ((result.error || result.busy || result.cancelled) && legacy) parts.push(button('もう一度…', openDialog))
                parts.push(button('閉じる', () => setState({ phase: 'idle' })))
                break
            }
            case 'interrupted':
                announce = `${state.reason}もう一度取り込むと、続きから取り込みます。`
                parts.push(
                    element('p', 'legacy-text', announce),
                    button('もう一度…', openDialog),
                    button('閉じる', () => setState({ phase: 'idle' })),
                )
                break
        }
        // フォーカスしていたボタンが作り直してなくなったら、お知らせの最初のボタンへ（ページの先頭へ外れないように）
        const hadFocus = notice.contains(document.activeElement)
        notice.replaceChildren(...parts)
        notice.hidden = parts.length === 0
        notice.dataset.phase = state.phase
        if (hadFocus) notice.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        if (phaseChanged && announce) status.textContent = announce
    }

    // ---- 始める前の確認（容量の上限と比べる） ----
    const renderCapacity = async () => {
        if (!legacy) return
        const usage = await usageBytes()
        const limit = await MAX_STORAGE_SIZE.getValue()
        const after = usage + legacy.bytes
        const needed = Math.min(MAX_STORAGE_SIZE_LIMIT, Math.ceil(after / GB + 1) * GB) // 録画中の分の余裕を少し
        const capacity = $<HTMLDivElement>('.legacy-capacity')
        const startButton = $<HTMLButtonElement>('#legacyStart')
        const parts: HTMLElement[] = [
            element('p', undefined, `今の使用量 ${formatBytes(usage)} / 上限 ${formatBytes(limit)}。取り込むと、約 ${formatBytes(after)} になります。`),
        ]
        if (after > limit) {
            const warning = element('div', 'legacy-warning')
            warning.append(element('p', undefined, `上限を超える分（約 ${formatBytes(after - limit)}）は、古い録画から自動で削除されます。以前の録画は古いので、取り込んだそばから削除されてしまいます。先に容量の上限を上げてから取り込むことをおすすめします。`))
            if (needed > limit && after <= MAX_STORAGE_SIZE_LIMIT) {
                warning.append(button(`上限を ${Math.round(needed / GB)} GB に上げる`, () => {
                    void MAX_STORAGE_SIZE.setValue(needed).then(async () => {
                        await reload()
                        await renderCapacity()
                    })
                }, 'button small primary'))
            } else {
                warning.append(element('p', undefined, `上限は ${Math.round(MAX_STORAGE_SIZE_LIMIT / GB)} GB までです。いらない録画を削除してから取り込んでください。`))
            }
            parts.push(warning)
            startButton.textContent = 'このまま取り込む'
            startButton.className = 'button danger'
        } else {
            parts.push(element('p', 'legacy-ok', '上限の中に収まります（この後の録画で上限を超えると、古い録画から削除されます）。'))
            startButton.textContent = '取り込みを始める'
            startButton.className = 'button primary'
        }
        capacity.replaceChildren(...parts)
    }

    const openDialog = () => {
        if (!legacy) return
        $('#legacySummary').textContent = `以前のバージョン（1.2.2 まで）で録画した ${legacy.count}本（約 ${formatBytes(legacy.bytes)}）を、この録画一覧に移します。`
        void renderCapacity()
        dialog.showModal()
    }
    $('#legacyClose').addEventListener('click', () => dialog.close())
    $('#legacyStart').addEventListener('click', () => {
        dialog.close()
        void startImport()
    })

    // ---- 取り込む ----
    // 取り込み用のページは、開くとすぐ取り込み始める。前に開いたタブが取り込み用のページのまま残っていれば、そのタブで続きを取り込む
    // （他のページへ移ったタブは、使わず閉じもしない）
    const startImport = async () => {
        if (phase() === 'starting' || phase() === 'running') return
        setState({ phase: 'starting' })
        try {
            const previous = await importTabId()
            if (previous !== null) {
                const reply = await chrome.tabs.sendMessage(previous, { type: LEGACY_IMPORT_START_MESSAGE }).catch(() => null)
                if (reply?.ok === true) return
                await chrome.storage.session.remove(LEGACY_IMPORT_TAB_KEY)
            }
            const tab = await chrome.tabs.create({ url: LEGACY_IMPORT_URL, active: false })
            if (tab.id === undefined) throw new Error('タブを開けませんでした')
            await chrome.storage.session.set({ [LEGACY_IMPORT_TAB_KEY]: tab.id })
        } catch (error) {
            console.error('取り込むためのページを開けませんでした:', error)
            setState({ phase: 'interrupted', reason: 'ニコ生のページを開けませんでした。' })
        }
    }

    const cancelImport = async () => {
        if (state.phase !== 'running' || state.cancelling) return
        setState({ ...state, cancelling: true })
        const tabId = await importTabId()
        if (tabId !== null) await chrome.tabs.sendMessage(tabId, { type: LEGACY_IMPORT_CANCEL_MESSAGE }).catch(() => {})
    }

    // 取り込んでいるページからの進み具合（他の録画一覧のページから始めた取り込みでも出す）
    chrome.runtime.onMessage.addListener((message: LegacyImportMessage) => {
        if (message?.type !== LEGACY_IMPORT_PROGRESS_MESSAGE) return
        if (message.finished) {
            setState({ phase: 'finished', result: message.finished })
            void reload()
            return
        }
        const previous = state.phase === 'running' ? state.progress : null
        setState({ phase: 'running', progress: message.progress, cancelling: state.phase === 'running' && state.cancelling })
        if (message.progress.done !== previous?.done) scheduleReload()
    })

    // 取り込んでいるページが閉じられた（取り込み終えて閉じた時は、終わったと先に届いている）
    chrome.tabs.onRemoved.addListener((closedTabId) => {
        void importTabId().then(async (tabId) => {
            if (tabId !== closedTabId) return
            await chrome.storage.session.remove(LEGACY_IMPORT_TAB_KEY)
            await new Promise(resolve => setTimeout(resolve, 1000))
            if (phase() === 'starting' || phase() === 'running') {
                setState({ phase: 'interrupted', reason: '取り込むために開いたニコ生のページが閉じられたため、取り込みが中断しました。' })
            }
        })
    })

    // 以前の録画が残っているか（ニコ生のページを開いた時に調べて書き込まれる）
    const applyLegacy = (value: LegacyRecordings | null) => {
        legacy = value
        if (state.phase === 'idle') render(false)
    }
    LEGACY_RECORDINGS.watch(applyLegacy)
    void LEGACY_RECORDINGS.getValue().then(applyLegacy)
}

export { setupLegacyImport }
