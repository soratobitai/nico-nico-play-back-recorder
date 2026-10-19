// 録画一覧のページ（拡張機能のページ）
// 録画を番組ごとに一覧し、再生・まとめて保存・削除する。保存先（IndexedDB）を直接読み書きする。
import * as db from '@/utils/library/db'
import type { RecordingKind, SegmentSummary } from '@/utils/library/db'
import { summarizePrograms, filterPrograms, groupByDay, type ProgramSummary } from '@/utils/library/programs'
import { SHOW_PROGRAM_MESSAGE } from '@/utils/library/open-library'
import { mountReviewView, KIND_LABELS, type ReviewView, type ReviewViewState } from '@/utils/review/view'
import { REVIEW_STYLE } from '@/utils/review/style'
import { downloadBlob, formatDateForFileName, getVideoExtension } from '@/utils/feature'
import { MAX_STORAGE_SIZE } from '@/utils/storage'

// 一覧を読み直す間隔（録画中の番組の分が増える）
const REFRESH_INTERVAL_MS = 15 * 1000
const DEFAULT_THUMBNAIL = '/assets/images/defaultScreenshot.webp'
const PAGE_TITLE = document.title

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const searchInput = $<HTMLInputElement>('search')
const usage = $<HTMLDivElement>('usage')
const programList = $<HTMLDivElement>('programList')
const emptyState = $<HTMLParagraphElement>('emptyState')
const programSection = $<HTMLElement>('program')
const programTitle = $<HTMLHeadingElement>('programTitle')
const programMeta = $<HTMLParagraphElement>('programMeta')
const downloadProgramButton = $<HTMLButtonElement>('downloadProgram')
const deleteProgramButton = $<HTMLButtonElement>('deleteProgram')
const player = $<HTMLDivElement>('player')
const lanes = $<HTMLDivElement>('lanes')
const segmentList = $<HTMLOListElement>('segments')
const segmentsTitle = $<HTMLHeadingElement>('segmentsTitle')
const toast = $<HTMLDivElement>('toast')
const filterButtons = [...document.querySelectorAll<HTMLButtonElement>('.filter')]

// 録画を見る画面の見た目
const reviewStyle = document.createElement('style')
reviewStyle.textContent = REVIEW_STYLE
document.head.append(reviewStyle)

let programs: ProgramSummary[] = []
let query = ''
let kindFilter: RecordingKind | null = null
let selectedKey: string | null = decodeURIComponent(location.hash.slice(1)) || null
let view: ReviewView | null = null
let viewKey: string | null = null
let viewState: ReviewViewState | null = null

// ---- 表示の形 ----

const pad = (n: number) => String(n).padStart(2, '0')
const formatTime = (ms: number, seconds = false) => {
    const d = new Date(ms)
    return `${d.getHours()}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
}
const formatDay = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
const formatDuration = (seconds: number) => {
    const s = Math.max(0, Math.round(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
const formatBytes = (bytes: number) => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
const programName = (program: ProgramSummary) => program.title || '（タイトルなし）'
const segmentEnd = (segment: SegmentSummary) => segment.endedAt ?? segment.startedAt + segment.duration * 1000

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
}

const kindDots = (kinds: RecordingKind[]) => {
    const dots = element('span', 'dots')
    dots.setAttribute('aria-label', `種類: ${kinds.map(kind => KIND_LABELS[kind]).join('・')}`)
    for (const kind of kinds) dots.append(element('span', `dot kind-${kind}`))
    return dots
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
// ms が null なら、次のお知らせまで出しておく
const showToast = (text: string, ms: number | null = 4000) => {
    toast.textContent = text
    toast.hidden = false
    clearTimeout(toastTimer)
    if (ms !== null) toastTimer = setTimeout(() => { toast.hidden = true }, ms)
}

// 一覧などを作り直しても、操作していたボタンにフォーカスを戻す（読み直すたびにフォーカスが外れないように）
// 戻す時に画面をスクロールしない（ボタンを押した後にスクロールして見ている所が、読み直すたびに戻されないように）
// 作り直してボタンがなくなった場合（消した区間など）は、fallback にフォーカスを移す
const keepFocus = (render: () => void, fallback?: () => HTMLElement | null | undefined) => {
    const key = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined
    render()
    if (!key) return
    const target = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) ?? fallback?.()
    target?.focus({ preventScroll: true })
}

// ---- 読み込み ----

const selectedProgram = () => programs.find(program => program.key === selectedKey) ?? null

// focusFallback: フォーカスしていたボタンが、作り直してなくなった時にフォーカスを移す先
const load = async (focusFallback?: () => HTMLElement | null | undefined) => {
    try {
        // 録画していたタブが閉じられるなどして、録画中のまま残った区間を確定する
        await db.closeStaleSegments(db.STALE_SEGMENT_IDLE_MS).catch((error) => console.warn('残っていた録画を確定できませんでした:', error))
        programs = summarizePrograms(await db.listAllSegments())
    } catch (error) {
        console.error('録画を読み込めませんでした:', error)
        showToast('録画を読み込めませんでした。')
        return
    }
    await renderUsage()
    keepFocus(() => {
        renderList()
        renderProgram()
    }, focusFallback)
}

// ---- 使用量 ----

const renderUsage = async () => {
    const byKind = { video: 0, comments: 0, screen: 0 }
    for (const program of programs) {
        for (const kind of Object.keys(byKind) as RecordingKind[]) byKind[kind] += program.bytesByKind[kind]
    }
    const total = byKind.video + byKind.comments + byKind.screen
    const limit = await MAX_STORAGE_SIZE.getValue()
    usage.replaceChildren(element('span', undefined, `使用量 ${formatBytes(total)} / 上限 ${formatBytes(limit)}`))
    const bar = element('span', 'usage-bar')
    bar.setAttribute('aria-hidden', 'true')
    for (const kind of ['video', 'comments', 'screen'] as const) {
        const part = element('span')
        part.style.width = `${Math.min(100, (byKind[kind] / limit) * 100)}%`
        part.style.background = `var(--${kind})`
        bar.append(part)
    }
    usage.append(bar)
}

// ---- 番組の一覧 ----

const renderList = () => {
    if (programs.length === 0) {
        programList.replaceChildren(element('p', 'no-programs', 'まだ録画がありません。ニコ生の番組を開くと、自動で録画が始まります。'))
        return
    }
    const filtered = filterPrograms(programs, query, kindFilter)
    if (filtered.length === 0) {
        programList.replaceChildren(element('p', 'no-programs', '見つかりませんでした。'))
        return
    }
    const children: HTMLElement[] = []
    for (const group of groupByDay(filtered)) {
        children.push(element('div', 'day', group.label))
        for (const program of group.programs) {
            const item = element('button', 'program-item')
            item.type = 'button'
            item.dataset.focusKey = `program:${program.key}`
            item.setAttribute('aria-current', String(program.key === selectedKey))
            item.append(element('span', 'name', programName(program)))
            const detail = element('span', 'detail')
            const parts = [program.userName, `${formatTime(program.startedAt)}〜`, `${program.segments.length}件`, formatBytes(program.bytes)].filter(Boolean)
            detail.append(element('span', undefined, parts.join('・')), kindDots(program.kinds))
            if (program.recording) detail.append(element('span', 'recording-badge', '録画中'))
            item.append(detail)
            item.addEventListener('click', () => select(program.key))
            children.push(item)
        }
    }
    programList.replaceChildren(...children)
}

const select = (key: string) => {
    selectedKey = key
    history.replaceState(null, '', `#${encodeURIComponent(key)}`)
    keepFocus(() => {
        renderList()
        renderProgram()
    })
}

// ---- 選んだ番組 ----

// 区間の一覧・保存で使う種類（見ている種類。再生できる種類がなければ、録ってある最初の種類）
const listKind = (program: ProgramSummary): RecordingKind =>
    viewState && viewState.kinds.length > 0 && program.kinds.includes(viewState.kind) ? viewState.kind : program.kinds[0]

const renderProgram = () => {
    const program = selectedProgram()
    if (!program) {
        view?.destroy()
        view = null
        viewKey = null
        viewState = null
        programSection.hidden = true
        emptyState.hidden = false
        emptyState.textContent = programs.length === 0
            ? 'まだ録画がありません。\nニコ生の番組を開くと、自動で録画が始まります。'
            : selectedKey ? 'この番組の録画はありません。\n左の一覧から番組を選んでください。' : '左の一覧から番組を選んでください。'
        document.title = PAGE_TITLE
        return
    }

    emptyState.hidden = true
    programSection.hidden = false
    document.title = `${programName(program)} - ${PAGE_TITLE}`
    programTitle.textContent = programName(program)
    const period = `${formatDay(program.startedAt)} ${formatTime(program.startedAt)}〜${program.recording ? '（録画中）' : formatTime(program.endedAt)}`
    programMeta.textContent = [program.userName, period, `${program.segments.length}件`, formatBytes(program.bytes)].filter(Boolean).join('・')

    if (viewKey !== program.key) {
        view?.destroy()
        viewState = null
        const key = program.key
        view = mountReviewView({
            root: player,
            mode: 'library',
            readTimeline: () => db.getTimelineForSegments(programs.find(p => p.key === key)?.segments.map(s => s.segmentId) ?? []),
            readFragments: db.getFragmentBlobs,
            onChange: onViewChange,
        })
        viewKey = key
    }
    renderLanes(program)
    renderSegments(program)
}

const onViewChange = (state: ReviewViewState) => {
    const kindChanged = state.kind !== viewState?.kind || state.kinds.length !== viewState?.kinds.length
    viewState = state
    const program = selectedProgram()
    if (!program) return
    if (kindChanged) renderSegments(program)
    updatePlayhead(program)
    updateCurrentSegment()
}

// ---- 種類ごとの録った時間 ----

const spanOf = (program: ProgramSummary) => {
    const start = program.startedAt
    const end = Math.max(program.endedAt, start + 60 * 1000)
    return { start, end, length: end - start }
}

const renderLanes = (program: ProgramSummary) => {
    const { start, end, length } = spanOf(program)
    const multiDay = new Date(start).toDateString() !== new Date(end).toDateString()
    const ticks = element('div', 'ticks')
    ticks.setAttribute('aria-hidden', 'true')
    for (let i = 0; i <= 4; i++) {
        const time = start + (length * i) / 4
        // 短い番組は秒まで出す（目盛りが同じ時刻ばかりにならないように）
        const tick = element('span', undefined, `${multiDay ? `${new Date(time).getMonth() + 1}/${new Date(time).getDate()} ` : ''}${formatTime(time, length < 10 * 60 * 1000)}`)
        tick.style.left = `${(i / 4) * 100}%`
        ticks.append(tick)
    }

    const rows: HTMLElement[] = [ticks]
    for (const kind of program.kinds) {
        const row = element('div', 'lane')
        const label = element('span', 'lane-label')
        label.append(element('span', `dot kind-${kind}`), element('span', undefined, KIND_LABELS[kind]))
        const track = element('button', 'lane-track')
        track.type = 'button'
        track.dataset.kind = kind
        track.dataset.focusKey = `lane:${kind}`
        track.setAttribute('aria-label', `${KIND_LABELS[kind]}の録画。クリックした時刻から再生します`)
        for (const segment of program.segments.filter(s => s.kind === kind)) {
            const block = element('span', `block kind-${kind}`)
            block.style.left = `${((segment.startedAt - start) / length) * 100}%`
            block.style.width = `${Math.max(0.4, ((segmentEnd(segment) - segment.startedAt) / length) * 100)}%`
            track.append(block)
        }
        track.append(element('span', 'playhead'))
        track.addEventListener('click', (event) => {
            const rect = track.getBoundingClientRect()
            const ratio = event.detail === 0 ? 0 : Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
            view?.show(kind, start + ratio * length, true)
        })
        row.append(label, track)
        rows.push(row)
    }
    rows.push(element('p', 'lanes-hint', 'クリックした時刻から再生します。種類を切り替えても、同じ時刻から見られます。'))
    lanes.replaceChildren(...rows)
    updatePlayhead(program)
}

const updatePlayhead = (program: ProgramSummary) => {
    const { start, length } = spanOf(program)
    const wallClock = viewState?.wallClock ?? null
    for (const playhead of lanes.querySelectorAll<HTMLElement>('.playhead')) {
        playhead.hidden = wallClock === null
        if (wallClock !== null) playhead.style.left = `${Math.min(100, Math.max(0, ((wallClock - start) / length) * 100))}%`
    }
}

// ---- 区間の一覧 ----

const kindSuffix = (kind: RecordingKind) => kind === 'video' ? '' : `_${KIND_LABELS[kind]}`

// 区間をつないで保存する（設定が変わった所や、つなげない形式の録画は、ファイルを分ける）
// 作っている間に押された分は、順に作って保存する（同時に作ると重いので）
let downloads = Promise.resolve()
let waitingDownloads = 0
const downloadSegments = (program: ProgramSummary, segmentIds: string[]) => {
    waitingDownloads++
    showToast(waitingDownloads > 1 ? `保存するファイルを作っています…（あと${waitingDownloads}件）` : '保存するファイルを作っています…', null)
    downloads = downloads.then(async () => {
        try {
            const files = await db.buildDownloadFiles(segmentIds)
            if (files.length === 0) {
                showToast('保存できる録画がありません。')
                return
            }
            for (const [i, file] of files.entries()) {
                const name = [program.userName, program.title, formatDateForFileName(file.startedAt)].filter(Boolean).join('_')
                downloadBlob(file.blob, `${name}${kindSuffix(file.kind)}.${getVideoExtension(file.mimeType)}`)
                if (i < files.length - 1) await new Promise(resolve => setTimeout(resolve, 300))
            }
            showToast(files.length > 1
                ? `${files.length}個のファイルに分けて保存しました（録画の設定が変わった所や、つなげない形式の録画は、別のファイルになります）。`
                : '保存しました。')
        } catch (error) {
            console.error('保存できませんでした:', error)
            showToast('保存できませんでした。')
        } finally {
            waitingDownloads--
            if (waitingDownloads > 0) showToast(`保存するファイルを作っています…（あと${waitingDownloads}件）`, null)
        }
    })
    return downloads
}

// 区間を削除して、一覧を読み直す
// フォーカスしていたボタンがなくなったら、同じ位置の区間（なければ番組の一覧の選んでいる番組）に移す
const deleteAndReload = async (segmentIds: string[], position?: number) => {
    try {
        await db.deleteSegments(segmentIds)
    } catch (error) {
        console.error('削除できませんでした:', error)
        showToast('削除できませんでした。')
        return
    }
    showToast('削除しました。')
    await load(() => {
        const buttons = [...segmentList.querySelectorAll<HTMLButtonElement>('.segment button:not(:disabled)')]
        const items = [...segmentList.querySelectorAll<HTMLElement>('.segment')]
        const item = position === undefined ? undefined : items[Math.min(position, items.length - 1)]
        return item?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? buttons[0]
            ?? programList.querySelector<HTMLElement>('.program-item[aria-current="true"]')
    })
    await view?.refresh()
}

const renderSegments = (program: ProgramSummary) => {
    const kind = listKind(program)
    const segments = program.segments.filter(s => s.kind === kind)
    downloadProgramButton.textContent = program.kinds.length > 1 ? `まとめて保存（${KIND_LABELS[kind]}）` : 'まとめて保存'
    segmentsTitle.textContent = program.kinds.length > 1 ? `区間（${KIND_LABELS[kind]}）` : '区間'
    downloadProgramButton.onclick = () => downloadSegments(program, segments.map(s => s.segmentId))

    const items = segments.map((segment, position) => {
        const item = element('li', 'segment')
        item.dataset.start = String(segment.startedAt)
        item.dataset.end = String(segmentEnd(segment))
        const img = element('img')
        img.src = segment.thumbnail || DEFAULT_THUMBNAIL
        img.alt = ''
        const info = element('div', 'info')
        const recording = segment.endedAt === null
        info.append(
            element('span', 'when', `${formatTime(segment.startedAt, true)}〜${recording ? '録画中' : formatTime(segment.endedAt!, true)}`),
            element('span', 'size', `${formatDuration(segment.duration)}・${formatBytes(segment.bytes)}`),
        )
        const actions = element('div', 'actions')
        if (segment.format === 'fmp4') {
            const play = element('button', 'button', '再生')
            play.type = 'button'
            play.dataset.focusKey = `play:${segment.segmentId}`
            play.addEventListener('click', () => view?.show(kind, segment.startedAt, true))
            actions.append(play)
        }
        const save = element('button', 'button', '保存')
        save.type = 'button'
        save.dataset.focusKey = `save:${segment.segmentId}`
        save.addEventListener('click', () => downloadSegments(program, [segment.segmentId]))
        const remove = element('button', 'button danger', '削除')
        remove.type = 'button'
        remove.dataset.focusKey = `delete:${segment.segmentId}`
        // 録画中の区間は、書き込み中なので消さない
        remove.disabled = recording
        remove.title = recording ? '録画中の区間は削除できません' : ''
        remove.addEventListener('click', async () => {
            if (!confirm(`${formatTime(segment.startedAt, true)}からの区間（${formatBytes(segment.bytes)}）を削除しますか？`)) return
            await deleteAndReload([segment.segmentId], position)
        })
        actions.append(save, remove)
        item.append(img, info, actions)
        return item
    })
    segmentList.replaceChildren(...items)
    updateCurrentSegment()
}

const updateCurrentSegment = () => {
    const wallClock = viewState?.wallClock ?? null
    for (const item of segmentList.querySelectorAll<HTMLElement>('.segment')) {
        const current = wallClock !== null && Number(item.dataset.start) <= wallClock && wallClock < Number(item.dataset.end)
        item.setAttribute('aria-current', String(current))
    }
}

// ---- 操作 ----

deleteProgramButton.addEventListener('click', async () => {
    const program = selectedProgram()
    if (!program) return
    // 録画中の区間は、書き込み中なので消さない
    const deletable = program.segments.filter(s => s.endedAt !== null)
    if (deletable.length === 0) {
        showToast('録画中の区間は削除できません。')
        return
    }
    const bytes = deletable.reduce((sum, s) => sum + s.bytes, 0)
    const note = deletable.length < program.segments.length ? '\n（録画中の区間は残します）' : ''
    if (!confirm(`「${programName(program)}」の録画（${deletable.length}件・${formatBytes(bytes)}）を削除しますか？${note}`)) return
    await deleteAndReload(deletable.map(s => s.segmentId))
})

searchInput.addEventListener('input', () => {
    query = searchInput.value
    renderList()
})

for (const button of filterButtons) {
    button.addEventListener('click', () => {
        kindFilter = (button.dataset.kind || null) as RecordingKind | null
        for (const b of filterButtons) b.setAttribute('aria-pressed', String(b === button))
        renderList()
    })
}

$<HTMLButtonElement>('refresh').addEventListener('click', () => { void load() })

// 録画中の番組の分が増えるので、見ている間は読み直す
setInterval(() => {
    if (document.visibilityState === 'visible') void load()
}, REFRESH_INTERVAL_MS)

// ニコ生のページなどから開かれた時（既に開いていれば、このページに番組を表示して前に出す）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== SHOW_PROGRAM_MESSAGE) return
    if (typeof message.programId === 'string') selectedKey = message.programId
    void load().then(() => {
        if (selectedKey) history.replaceState(null, '', `#${encodeURIComponent(selectedKey)}`)
    })
    chrome.tabs.getCurrent().then((tab) => {
        if (tab?.id !== undefined) chrome.tabs.update(tab.id, { active: true })
        if (tab?.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true })
    }).catch(() => {})
    sendResponse(true)
})

// 最初に選ぶ番組（指定がなければ、最近録った番組）
void load().then(() => {
    if (!selectedKey && programs.length > 0) select(programs[0].key)
})
