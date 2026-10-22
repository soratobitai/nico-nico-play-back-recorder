// 録画一覧のページ: 以前のバージョンの録画を取り込む（手動）
// 以前の録画はニコ生のサイトデータにあるので、取り込み用のニコ生のページを見えない枠で埋め込んで、そのページに取り込んでもらう
// （utils/library/legacy-import.ts。新しいタブは開かない。埋め込んだページから読めない時だけ、裏のタブで開く）。
// 取り込んでいる間は、番組の一覧の上に進み具合を出す。
// 取り込んだ録画が容量の上限ですぐに消えないよう、上限を超える（近くなる）時は、上限を上げてから取り込む。
// 録画一覧を開いた時は、数える用のページを埋め込んで、以前の録画が残っているかを数え直す（ニコ生のページを開いていなくても出す）
import { LEGACY_RECORDINGS, MAX_STORAGE_SIZE, type LegacyRecordings } from '@/utils/storage'
import {
    LEGACY_IMPORT_START_MESSAGE, LEGACY_IMPORT_CANCEL_MESSAGE, LEGACY_IMPORT_PROGRESS_MESSAGE,
    LEGACY_COUNT_URL, LEGACY_IMPORT_TAB_KEY, LEGACY_IMPORT_RUN_KEY, legacyImportUrl, type LegacyImportMessage,
} from '@/utils/library/legacy-import'
import type { LegacyImportProgress } from '@/utils/library/migrate'

const GB = 1024 ** 3
// 容量の上限の最大（設定画面と同じ）
const MAX_STORAGE_SIZE_LIMIT = 100 * GB
// 取り込み用のページで、取り込みが始まるまで待つ時間
const START_TIMEOUT_MS = 60 * 1000
// 埋め込んだページで取り込みが始まらなければ、タブで開き直すまでの時間
const FRAME_START_TIMEOUT_MS = 15 * 1000
// 数える用のページを、埋め込んだままにする時間
const COUNT_FRAME_MS = 15 * 1000
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

// 取り込んだ後の大きさに合わせた上限（録画を続ける分の余裕を少し足して、GB 単位に切り上げる。最大まで）
// 今の上限がこれより小さければ、取り込む前に上げる（取り込んだ後の録画で、取り込んだ録画がすぐに消えないように）
const neededLimit = (after: number) => Math.min(MAX_STORAGE_SIZE_LIMIT, Math.ceil(after / GB + 1) * GB)

// 見えない枠（ニコ生のページを埋め込む）
const hiddenFrame = (url: string) => {
    const frame = document.createElement('iframe')
    frame.src = url
    frame.title = '以前の録画を読むためのページ'
    frame.tabIndex = -1
    frame.setAttribute('aria-hidden', 'true')
    frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
    document.body.append(frame)
    return frame
}

// 何も取り込まずに終わった（埋め込んだページから、ニコ生のサイトデータが見えなかったのかもしれない）
const sawNothing = (result: Finished) =>
    result.migrated === 0 && result.failed === 0 && !result.cancelled && !result.busy && !result.full

const setupLegacyImport = ({ notice, status, dialog, usageBytes, formatBytes, reload }: LegacyImportOptions) => {
    let legacy: LegacyRecordings | null = null
    let state: State = { phase: 'idle' }
    let timer: ReturnType<typeof setTimeout> | undefined
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    // 取り込み方（埋め込んだページで / タブで）と、埋め込んだページ・開いたタブ
    let mode: 'frame' | 'tab' | null = null
    let importFrame: HTMLIFrameElement | null = null
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    let openedTabId: number | null = null
    // 今の取り込みの合言葉（この合言葉の付いた知らせだけを受け取る）と、知らせてきたページ（やめる時に送る先）
    let run: string | null = null
    let source: { tabId: number, frameId: number } | null = null
    // 取り込む時に上げた容量の上限（上げていなければ null）
    let raised: { from: number, to: number } | null = null
    // この録画一覧のタブ（取り込んでいる間、メモリの節約のために破棄されないようにする）
    const ownTab = chrome.tabs.getCurrent().catch(() => undefined)

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
    const gb = (bytes: number) => `${Math.round(bytes / GB)} GB`

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

    // 1本も取り込まなかった時は、上げた上限を戻す（その間に設定で変えられていたら、そのままにする）
    const restoreLimit = () => {
        const previous = raised
        raised = null
        if (!previous) return
        void MAX_STORAGE_SIZE.getValue()
            .then(limit => limit === previous.to ? MAX_STORAGE_SIZE.setValue(previous.from) : undefined)
            .catch(() => {})
    }

    // 今の段階（待っている間に、進み具合が届くなどして変わる）
    const phase = () => state.phase
    const setState = (next: State) => {
        const changed = next.phase !== state.phase
        state = next
        clearTimeout(timer)
        if (next.phase === 'starting') {
            timer = setTimeout(giveUpStarting, START_TIMEOUT_MS)
        } else if (next.phase === 'running') {
            // 止まったまま進まない時は、中断したとみなす（取り込んでいるページはそのままにして、遅れて進み具合が届けば続ける）
            timer = setTimeout(() => setState({ phase: 'interrupted', reason: '取り込みが止まりました。' }), STALL_TIMEOUT_MS)
        }
        if (next.phase === 'finished' || next.phase === 'idle') {
            removeImportFrame()
            if (next.phase === 'idle') run = null
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
    // 容量の上限を上げたことの説明
    const raisedNote = () => raised
        ? element('p', 'legacy-detail', `取り込んだ録画が消されないよう、容量の上限を ${formatBytes(raised.from)} から ${gb(raised.to)} に上げました（設定で変えられます）。`)
        : null
    // 取り込み方の説明（埋め込んだページで取り込む時は、録画一覧を閉じると止まる）
    const modeNote = () => mode === 'frame'
        ? element('p', 'legacy-detail', '取り込み終えるまで、この録画一覧を閉じないでください。')
        : mode === 'tab' ? element('p', 'legacy-detail', 'ニコ生のページを裏のタブで開いて取り込んでいます（取り込み終えると閉じます）。') : null

    const finishedText = (result: Finished) => {
        if (result.busy) return '他のタブで取り込んでいます。終わってから、もう一度お試しください。'
        if (result.error) return `取り込めませんでした（${result.migrated}本は取り込みました）。もう一度取り込むと、続きから取り込みます。`
        const text = result.cancelled ? `取り込みをやめました（${result.migrated}本を取り込みました）。残りは後で取り込めます。`
            : result.full ? `容量の上限に達したので、${result.migrated}本を取り込み、残りは以前の保存先に残しました。いらない録画を削除してから、もう一度取り込んでください。`
            : result.migrated === 0 && result.failed === 0 ? '取り込む録画は見つかりませんでした。'
            : `以前の録画を ${result.migrated}本取り込みました。`
        return result.failed > 0 ? `${text}${result.failed}本は取り込めなかったので、以前の保存先に残しました（もう一度取り込むと、取り込み直します）。` : text
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
        const parts: (HTMLElement | null)[] = []
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
                parts.push(element('p', 'legacy-text', '取り込みの準備をしています…'), progressBar(null), mode === 'tab' ? modeNote() : null)
                break
            case 'running': {
                announce = '以前の録画を取り込んでいます'
                const cancel = button('やめる', () => void cancelImport())
                cancel.title = '取り込んでいる1本を取り込み終えてから、やめます（残りは後で取り込めます）'
                running = { text: element('p', 'legacy-text'), bar: progressBar(null), detail: element('p', 'legacy-detail'), cancel }
                parts.push(running.text, running.bar, running.detail, raisedNote(), modeNote(), running.cancel)
                updateRunning(state.progress, state.cancelling)
                break
            }
            case 'finished': {
                const { result } = state
                announce = finishedText(result)
                parts.push(element('p', 'legacy-text', announce), raisedNote())
                if ((result.error || result.busy || result.cancelled || result.full || result.failed > 0) && legacy) parts.push(button('もう一度…', openDialog))
                parts.push(button('閉じる', () => setState({ phase: 'idle' })))
                break
            }
            case 'interrupted':
                announce = `${state.reason}もう一度取り込むと、続きから取り込みます。`
                parts.push(
                    element('p', 'legacy-text', announce),
                    raisedNote(),
                    button('もう一度…', openDialog),
                    button('閉じる', () => setState({ phase: 'idle' })),
                )
                break
        }
        const shown = parts.filter((part): part is HTMLElement => part !== null)
        // フォーカスしていたボタンが作り直してなくなったら、お知らせの最初のボタンへ（ページの先頭へ外れないように）
        const hadFocus = notice.contains(document.activeElement)
        notice.replaceChildren(...shown)
        notice.hidden = shown.length === 0
        notice.dataset.phase = state.phase
        if (hadFocus) notice.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
        if (phaseChanged && announce) status.textContent = announce
    }

    // ---- 始める前の確認（容量の上限と比べる。超える・近くなる時は、上げてから取り込む） ----
    const renderCapacity = async () => {
        if (!legacy) return
        const usage = await usageBytes()
        const limit = await MAX_STORAGE_SIZE.getValue()
        const after = usage + legacy.bytes
        const target = neededLimit(after)
        const quota = (await navigator.storage?.estimate?.().catch(() => null))?.quota ?? null
        const capacity = $<HTMLDivElement>('.legacy-capacity')
        const startButton = $<HTMLButtonElement>('#legacyStart')
        const parts: HTMLElement[] = [
            element('p', undefined, `今の使用量 ${formatBytes(usage)} / 上限 ${formatBytes(limit)}。取り込むと、約 ${formatBytes(after)} になります。`),
        ]
        startButton.className = 'button primary'
        if (after > MAX_STORAGE_SIZE_LIMIT) {
            // 上限の最大でも入らない: 入る分だけ取り込み、残りは以前の保存先に残す（取り込んでから削除されないように）
            const raise = limit < MAX_STORAGE_SIZE_LIMIT
            const warning = element('div', 'legacy-warning')
            warning.append(element('p', undefined, `容量の上限は ${gb(MAX_STORAGE_SIZE_LIMIT)} までです。${raise ? `上限を ${gb(MAX_STORAGE_SIZE_LIMIT)} に上げて、` : ''}入る分だけ取り込み、入らない分（約 ${formatBytes(after - MAX_STORAGE_SIZE_LIMIT)}）は以前の保存先に残します。先にいらない録画を削除すると、すべて取り込めます。`))
            parts.push(warning)
            startButton.textContent = raise ? `上限を ${gb(MAX_STORAGE_SIZE_LIMIT)} に上げて取り込む` : '入る分だけ取り込む'
        } else if (target > limit) {
            parts.push(element('p', 'legacy-ok', `${after > limit ? '今の上限を超える' : '上限に近くなる'}ので、取り込んだ録画が古い順に削除されないよう、容量の上限を ${gb(target)} に上げてから取り込みます（上限は、後で設定から変えられます）。`))
            startButton.textContent = `上限を ${gb(target)} に上げて取り込む`
        } else {
            parts.push(element('p', 'legacy-ok', '上限の中に収まります（この後の録画で上限を超えると、古い録画から削除されます）。'))
            startButton.textContent = '取り込みを始める'
        }
        // PC の空き容量が足りなければ、入らない分は取り込まずに残す
        if (quota !== null && after > quota) {
            const warning = element('div', 'legacy-warning')
            warning.append(element('p', undefined, `PC の空き容量が足りないかもしれません（使える容量は約 ${formatBytes(quota)}）。入らない分は、取り込まずに以前の保存先に残します。`))
            parts.push(warning)
        }
        capacity.replaceChildren(...parts)
    }

    // 取り込むと上限を超える（近くなる）時は、上限を上げる（上げた時は、上げる前と後を返す）
    const raiseLimitIfNeeded = async () => {
        if (!legacy) return null
        const limit = await MAX_STORAGE_SIZE.getValue()
        const to = neededLimit((await usageBytes()) + legacy.bytes)
        if (to <= limit) return null
        await MAX_STORAGE_SIZE.setValue(to)
        return { from: limit, to }
    }

    const openDialog = () => {
        if (!legacy) return
        $('#legacySummary').textContent = `以前のバージョン（1.2.2 まで）で録画した ${legacy.count}本（約 ${formatBytes(legacy.bytes)}）を、この録画一覧に移します。`
        // 使用量を調べ終えて、上限をどうするかを出すまでは、始められないようにする
        const startButton = $<HTMLButtonElement>('#legacyStart')
        startButton.disabled = true
        $<HTMLDivElement>('.legacy-capacity').replaceChildren(element('p', undefined, '今の使用量を調べています…'))
        void renderCapacity()
            .catch((error) => {
                console.error('使用量を調べられませんでした:', error)
                $<HTMLDivElement>('.legacy-capacity').replaceChildren(element('p', undefined, '今の使用量を調べられませんでした。'))
            })
            .finally(() => { startButton.disabled = false })
        dialog.showModal()
    }
    $('#legacyClose').addEventListener('click', () => dialog.close())
    $('#legacyStart').addEventListener('click', () => {
        dialog.close()
        void startImport()
    })

    // ---- 取り込む ----
    // 取り込んでいる間は、この録画一覧のタブが破棄されないようにする（埋め込んだページで取り込んでいる時）
    const setDiscardable = (discardable: boolean) => {
        void ownTab.then(tab => tab?.id !== undefined ? chrome.tabs.update(tab.id, { autoDiscardable: discardable }) : undefined).catch(() => {})
    }
    const removeImportFrame = () => {
        clearTimeout(frameTimer)
        if (!importFrame) return
        importFrame.remove()
        importFrame = null
        setDiscardable(true)
    }
    const removeCountFrame = () => countFrame.remove()

    // 新しい合言葉を決める（取り込み用のページが background に確かめる）
    const newRun = async () => {
        const next = crypto.randomUUID()
        run = next
        source = null
        await chrome.storage.session.set({ [LEGACY_IMPORT_RUN_KEY]: next })
        return next
    }

    // 録画一覧に埋め込んだページで取り込む（新しいタブを開かない）。始まらなければタブで開き直す
    const startInFrame = async () => {
        removeImportFrame()
        mode = 'frame'
        importFrame = hiddenFrame(legacyImportUrl(await newRun()))
        setDiscardable(false)
        frameTimer = setTimeout(() => {
            if (mode === 'frame' && phase() === 'starting') void startInTab()
        }, FRAME_START_TIMEOUT_MS)
    }

    // 裏のタブで開いて取り込む（埋め込んだページから、ニコ生のサイトデータを読めなかった時）
    const startInTab = async () => {
        removeImportFrame()
        mode = 'tab'
        setState({ phase: 'starting' })
        try {
            const tab = await chrome.tabs.create({ url: legacyImportUrl(await newRun()), active: false })
            if (tab.id === undefined) throw new Error('タブを開けませんでした')
            openedTabId = tab.id
            await chrome.storage.session.set({ [LEGACY_IMPORT_TAB_KEY]: tab.id })
        } catch (error) {
            console.error('取り込むためのページを開けませんでした:', error)
            run = null
            restoreLimit()
            setState({ phase: 'interrupted', reason: 'ニコ生のページを開けませんでした。' })
        }
    }

    // 始まらなかった: 埋め込んだページを外し、開いたタブが取り込み用のページのままなら閉じる
    const giveUpStarting = () => {
        removeImportFrame()
        const tabId = mode === 'tab' ? openedTabId : null
        if (tabId !== null) {
            void chrome.tabs.sendMessage(tabId, { type: LEGACY_IMPORT_CANCEL_MESSAGE }).catch(() => null).then(async (reply) => {
                if (reply?.importPage !== true) return
                await chrome.storage.session.remove(LEGACY_IMPORT_TAB_KEY)
                await chrome.tabs.remove(tabId)
            }).catch(() => {})
        }
        run = null
        restoreLimit()
        setState({ phase: 'interrupted', reason: '取り込みを始められませんでした。' })
    }

    // 前に開いたタブが取り込み用のページのまま残っていれば、そのタブで続きを取り込む（他のページへ移ったタブは、使わず閉じもしない）
    const startImport = async () => {
        if (phase() === 'starting' || phase() === 'running') return
        removeCountFrame()
        setState({ phase: 'starting' })
        try {
            raised = await raiseLimitIfNeeded()
            const previous = await importTabId()
            if (previous !== null) {
                const next = crypto.randomUUID()
                run = next
                source = null
                const reply = await chrome.tabs.sendMessage(previous, { type: LEGACY_IMPORT_START_MESSAGE, run: next }).catch(() => null)
                if (reply?.ok === true) {
                    mode = 'tab'
                    openedTabId = previous
                    return
                }
                await chrome.storage.session.remove(LEGACY_IMPORT_TAB_KEY)
            }
            await startInFrame()
        } catch (error) {
            console.error('取り込みを始められませんでした:', error)
            run = null
            restoreLimit()
            setState({ phase: 'interrupted', reason: '取り込みを始められませんでした。' })
        }
    }

    const cancelImport = async () => {
        if (state.phase !== 'running' || state.cancelling || !source) return
        setState({ ...state, cancelling: true })
        // 進み具合を知らせてきたページ（埋め込んだページなら、このタブの中の枠）に送る
        await chrome.tabs.sendMessage(source.tabId, { type: LEGACY_IMPORT_CANCEL_MESSAGE }, { frameId: source.frameId }).catch(() => {})
    }

    // 取り込んでいるページからの進み具合（この録画一覧が始めた取り込みのものだけ）
    chrome.runtime.onMessage.addListener((message: LegacyImportMessage, sender) => {
        if (message?.type !== LEGACY_IMPORT_PROGRESS_MESSAGE || !run || message.run !== run) return
        if (sender.tab?.id !== undefined) source = { tabId: sender.tab.id, frameId: sender.frameId ?? 0 }
        if (message.finished) {
            const result = message.finished
            // 埋め込んだページで何も取り込めなかったのに、以前の録画があるはず（または読めなかった）なら、タブで開いて取り込み直す
            if (mode === 'frame' && sawNothing(result) && (result.error || (legacy?.count ?? 0) > 0)) {
                void startInTab()
                return
            }
            run = null
            if (result.migrated === 0) restoreLimit()
            setState({ phase: 'finished', result })
            void reload()
            return
        }
        clearTimeout(frameTimer)
        const previous = state.phase === 'running' ? state.progress : null
        setState({ phase: 'running', progress: message.progress, cancelling: state.phase === 'running' && state.cancelling })
        if (message.progress.done !== previous?.done) scheduleReload()
    })

    // 取り込んでいるタブが閉じられた（取り込み終えて閉じた時は、終わったと先に届いている）
    chrome.tabs.onRemoved.addListener((closedTabId) => {
        void importTabId().then(async (tabId) => {
            if (tabId !== closedTabId) return
            await chrome.storage.session.remove(LEGACY_IMPORT_TAB_KEY)
            await new Promise(resolve => setTimeout(resolve, 1000))
            if (mode === 'tab' && (phase() === 'starting' || phase() === 'running')) {
                run = null
                setState({ phase: 'interrupted', reason: '取り込むために開いたニコ生のページが閉じられたため、取り込みが中断しました。' })
            }
        })
    })

    // 埋め込んだページで取り込んでいる間に閉じようとしたら、確かめる（閉じると止まる）
    window.addEventListener('beforeunload', (event) => {
        if (mode === 'frame' && importFrame && (phase() === 'starting' || phase() === 'running')) event.preventDefault()
    })

    // 以前の録画が残っているか（ニコ生のページを開いた時・この録画一覧を開いた時・取り込んでいる間に1本移すたびに書き込まれる）
    const applyLegacy = (value: LegacyRecordings | null) => {
        legacy = value
        if (state.phase === 'idle') render(false)
    }
    LEGACY_RECORDINGS.watch(applyLegacy)
    void LEGACY_RECORDINGS.getValue().then(applyLegacy)

    // 開いた時に数え直す（数える用のページを少しの間だけ埋め込む。取り込みを始めたら外す）
    const countFrame = hiddenFrame(LEGACY_COUNT_URL)
    setTimeout(removeCountFrame, COUNT_FRAME_MS)
}

export { setupLegacyImport }
