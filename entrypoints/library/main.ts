// 録画一覧のページ（拡張機能のページ）
// 録画を番組ごとに一覧し、再生・保存・削除する。保存先（IndexedDB）を直接読み書きする。
// 左: 番組の一覧（検索・種類で絞り込み・並べ方・選んで削除）
// 右: 選んだ番組（プレイヤー・種類ごとの録った時間のタイムライン・保存した時のファイルの単位の録画の一覧）
import * as db from '@/utils/library/db'
import type { RecordingKind } from '@/utils/library/db'
import type { VideoSize } from '@/utils/fmp4'
import {
    summarizePrograms, filterPrograms, groupByDay, sortPrograms, recordedSeconds, thumbnailOf, filesOf, isRecordingSegment,
    type ProgramSummary, type ProgramOrder, type RecordingFile,
} from '@/utils/library/programs'
import { SHOW_PROGRAM_MESSAGE } from '@/utils/library/open-library'
import { mountReviewView, KIND_LABELS, type ReviewView, type ReviewViewState } from '@/utils/review/view'
import { REVIEW_STYLE } from '@/utils/review/style'
import { downloadBlob, formatDateForFileName, getVideoExtension } from '@/utils/feature'
import { MAX_STORAGE_SIZE } from '@/utils/storage'
import { formatRecorded, formatElapsed, formatBroadcastTime } from '@/utils/time-format'
import { setupLegacyImport } from './legacy'

// 一覧を読み直す間隔（録画中の番組の分が増える）
const REFRESH_INTERVAL_MS = 15 * 1000
const DEFAULT_THUMBNAIL = '/assets/images/defaultScreenshot.webp'
const PAGE_TITLE = document.title
const KINDS: RecordingKind[] = ['video', 'comments', 'screen']
const SHORT_KIND_LABELS: Record<RecordingKind, string> = { video: 'コメなし', comments: 'コメあり', screen: '画面' }
const WATCH_URL = 'https://live.nicovideo.jp/watch/'
// タイムラインを押したまま、これだけ動かしたら、クリックではなく掴んで動かしたことにする
const DRAG_THRESHOLD_PX = 4

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const searchInput = $<HTMLInputElement>('search')
const orderSelect = $<HTMLSelectElement>('order')
const usage = $<HTMLDivElement>('usage')
const programList = $<HTMLDivElement>('programList')
const listSummary = $<HTMLSpanElement>('listSummary')
const selectModeButton = $<HTMLButtonElement>('selectMode')
const sideFoot = selectModeButton.parentElement!
const selectBar = $<HTMLDivElement>('selectBar')
const selectSummary = $<HTMLSpanElement>('selectSummary')
const emptyState = $<HTMLParagraphElement>('emptyState')
const programSection = $<HTMLElement>('program')
const programTitle = $<HTMLHeadingElement>('programTitle')
const programMeta = $<HTMLParagraphElement>('programMeta')
const openWatch = $<HTMLAnchorElement>('openWatch')
const downloadButton = $<HTMLButtonElement>('downloadProgram')
const downloadMenuButton = $<HTMLButtonElement>('downloadMenuButton')
const downloadMenu = $<HTMLDivElement>('downloadMenu')
const moreButton = $<HTMLButtonElement>('moreButton')
const moreMenu = $<HTMLDivElement>('moreMenu')
const player = $<HTMLDivElement>('player')
const lanes = $<HTMLDivElement>('lanes')
const fileTabs = $<HTMLDivElement>('fileTabs')
const fileList = $<HTMLOListElement>('files')
const toast = $<HTMLDivElement>('toast')
const filterButtons = [...document.querySelectorAll<HTMLButtonElement>('.filter')]

// 録画を見る画面の見た目
const reviewStyle = document.createElement('style')
reviewStyle.textContent = REVIEW_STYLE
document.head.append(reviewStyle)

let programs: ProgramSummary[] = []
let query = ''
let kindFilter: RecordingKind | null = null
let order: ProgramOrder = 'recent'
// URL の # の番組（壊れた # でもページは開けるように）
const programKeyFromHash = () => {
    try {
        return decodeURIComponent(location.hash.slice(1)) || null
    } catch {
        return null
    }
}
let selectedKey: string | null = programKeyFromHash()
let view: ReviewView | null = null
let viewKey: string | null = null
let viewState: ReviewViewState | null = null
// 録画の一覧で見ている種類（null なら、プレイヤーで見ている種類に合わせる）
let fileKind: RecordingKind | null = null
// 区間ごとの映像・音声の設定の印（保存した時のファイルの単位を出すのに使う。分かったものだけ覚える）
const signatures = new Map<string, string | null>()
// 区間ごとの録画の映像の大きさ（録画の一覧に画質を出す。mp4 の初期化セグメントから読む）
const videoSizes = new Map<string, VideoSize>()
// 録画の画質（720p など）。分からなければ null
const qualityOf = (file: RecordingFile) => {
    const size = file.segments.map(segment => videoSizes.get(segment.segmentId)).find(Boolean)
    return size ? { label: `${size.height}p`, detail: `${size.width}×${size.height}` } : null
}
// 選んで削除している間の、選んだ番組
let selecting: Set<string> | null = null
// タイムラインを掴んで動かしている間（読み直しても、タイムラインを作り直さない）
let timelineDragging = false

// ---- 表示の形 ----

const WEEKDAYS = '日月火水木金土'
const pad = (n: number) => String(n).padStart(2, '0')
// 時刻（午前・午後を付ける。例: 午後2:15）
const formatTime = (ms: number, seconds = false) => {
    const d = new Date(ms)
    const h = d.getHours()
    return `${h < 12 ? '午前' : '午後'}${h % 12}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`
}
const formatDate = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`
}
// 番組カードの日付（例: 10/21（火）。今年でなければ年も）
const formatShortDate = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}/`}${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`
}
const dayStart = (ms: number) => new Date(new Date(ms).toDateString()).getTime()
// 終わりの時刻（始めた日と違う日なら「翌」か日付を付ける）
const formatEnd = (start: number, end: number, seconds = false) => {
    const days = Math.round((dayStart(end) - dayStart(start)) / (24 * 60 * 60 * 1000))
    const d = new Date(end)
    const prefix = days === 0 ? '' : days === 1 ? '翌' : `${d.getMonth() + 1}/${d.getDate()} `
    return `${prefix}${formatTime(end, seconds)}`
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
    return bytes === 0 ? '0 KB' : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
const programName = (program: ProgramSummary) => program.title || '（タイトルなし）'
// その時刻の、録画を始めてからの時間・番組の経過時間・時刻（例: 12:34（番組 1:02:03）午後5:20時点）
// 番組が始まった時刻が分からない以前の録画は、番組の経過時間を出さない
const describeTime = (program: ProgramSummary, wallClock: number) =>
    `${formatRecorded(wallClock - program.startedAt)}${program.beginAt ? `（番組 ${formatElapsed(wallClock - program.beginAt)}）` : ' '}${formatBroadcastTime(wallClock)}時点`
// 録り終えた区間（録画中の区間は書き込み中なので、消さない）
const finishedSegments = (program: ProgramSummary) => program.segments.filter(segment => !isRecordingSegment(segment))

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
}
const dot = (kind: RecordingKind) => {
    const el = element('i', `dot kind-${kind}`)
    el.setAttribute('aria-hidden', 'true')
    return el
}
const kindDots = (kinds: RecordingKind[]) => {
    const dots = element('span', 'dots')
    dots.setAttribute('aria-label', `種類: ${kinds.map(kind => KIND_LABELS[kind]).join('・')}`)
    dots.append(...kinds.map(dot))
    return dots
}
const svg = (path: string, size = 16, filled = false) => {
    const wrapper = element('span')
    wrapper.innerHTML = `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${path}</svg>`
    return wrapper.firstElementChild!
}
const ICONS = {
    download: () => svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path>'),
    trash: () => svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path>'),
    play: () => svg('<path d="M8 5.5v13l10.5-6.5z"></path>', 18, true),
}
// 録画した時に作った画像（data:image/）だけを使う（他の URL だと、録画一覧を開くたびに外へ読みに行ってしまう）
const thumbnail = (src: string | null) => {
    const img = element('img')
    img.src = src?.startsWith('data:image/') ? src : DEFAULT_THUMBNAIL
    img.alt = ''
    img.loading = 'lazy'
    img.decoding = 'async'
    return img
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
// 作り直してボタンがなくなった場合（消した録画など）は、fallback にフォーカスを移す
const keepFocus = (render: () => void, fallback?: () => HTMLElement | null | undefined) => {
    const key = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined
    render()
    if (!key) return
    const target = document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`) ?? fallback?.()
    target?.focus({ preventScroll: true })
}

// ---- 読み込み ----

const selectedProgram = () => programs.find(program => program.key === selectedKey) ?? null

// まだ分かっていない区間の、映像・音声の設定の印を読む（初期化セグメントがまだ届いていない区間は、次に読み直す）
const loadSignatures = async () => {
    const unknown = programs.flatMap(program => program.segments)
        .filter(segment => segment.format === 'fmp4' && !signatures.get(segment.segmentId))
        .map(segment => segment.segmentId)
    if (unknown.length === 0) return
    for (const [segmentId, { signature, size }] of await db.getInitInfo(unknown)) {
        if (signature !== null) signatures.set(segmentId, signature)
        if (size) videoSizes.set(segmentId, size)
    }
}

// focusFallback: フォーカスしていたボタンが、作り直してなくなった時にフォーカスを移す先
const load = async (focusFallback?: () => HTMLElement | null | undefined) => {
    try {
        // 録画していたタブが閉じられるなどして、録画中のまま残った区間を確定する
        await db.closeStaleSegments(db.STALE_SEGMENT_IDLE_MS, Date.now(), db.EMPTY_SEGMENT_IDLE_MS).catch((error) => console.warn('残っていた録画を確定できませんでした:', error))
        programs = summarizePrograms(await db.listAllSegments())
        await loadSignatures().catch((error) => console.warn('録画の設定を読めませんでした:', error))
    } catch (error) {
        console.error('録画を読み込めませんでした:', error)
        showToast('録画を読み込めませんでした。')
        return
    }
    // 選んで削除している間に消えた番組は、選んだものから外す
    if (selecting) for (const key of selecting) if (!programs.some(program => program.key === key)) selecting.delete(key)
    await renderUsage()
    keepFocus(() => {
        renderList()
        renderProgram()
    }, focusFallback)
}

// ---- 使用量（種類ごとに色分け） ----

const renderUsage = async () => {
    const byKind: Record<RecordingKind, number> = { video: 0, comments: 0, screen: 0 }
    for (const program of programs) {
        for (const kind of KINDS) byKind[kind] += program.bytesByKind[kind]
    }
    const total = byKind.video + byKind.comments + byKind.screen
    const limit = await MAX_STORAGE_SIZE.getValue()
    const legend = element('div', 'usage-legend')
    for (const kind of KINDS.filter(kind => byKind[kind] > 0)) {
        const item = element('span')
        item.append(dot(kind), `${KIND_LABELS[kind]} ${formatBytes(byKind[kind])}`)
        legend.append(item)
    }
    const bar = element('span', 'usage-bar')
    bar.setAttribute('aria-hidden', 'true')
    for (const kind of KINDS) {
        const part = element('span')
        part.style.width = `${Math.min(100, (byKind[kind] / limit) * 100)}%`
        part.style.background = `rgb(var(--${kind}-rgb))`
        bar.append(part)
    }
    const text = element('span')
    text.append('使用量 ', element('b', undefined, formatBytes(total)), ` / 上限 ${formatBytes(limit)}`)
    usage.replaceChildren(legend, bar, text)
}

// ---- 番組の一覧 ----

const renderList = () => {
    const total = programs.reduce((sum, program) => sum + program.bytes, 0)
    listSummary.textContent = programs.length > 0 ? `${programs.length}番組・${formatBytes(total)}` : ''
    selectModeButton.hidden = programs.length === 0
    renderSelectBar()

    if (programs.length === 0) {
        programList.replaceChildren(element('p', 'no-programs', 'まだ録画がありません。ニコ生の番組を録画すると、ここに番組ごとに並びます。'))
        return
    }
    const filtered = sortPrograms(filterPrograms(programs, query, kindFilter), order)
    if (filtered.length === 0) {
        programList.replaceChildren(element('p', 'no-programs', '見つかりませんでした。'))
        return
    }
    // 新しい順の時は、録った日ごとに見出しを付ける（大きい順の時は付けない）
    const groups = order === 'recent' ? groupByDay(filtered) : [{ label: null, programs: filtered }]
    const children: HTMLElement[] = []
    for (const group of groups) {
        if (group.label) {
            const day = element('div', 'day')
            day.append(element('span', undefined, group.label), element('span', undefined, formatBytes(group.programs.reduce((sum, p) => sum + p.bytes, 0))))
            children.push(day)
        }
        children.push(...group.programs.map(programCard))
    }
    programList.replaceChildren(...children)
}

const programCard = (program: ProgramSummary) => {
    const item = element('button', 'program-item')
    item.type = 'button'
    item.dataset.focusKey = `program:${program.key}`
    item.dataset.key = program.key
    if (selecting) {
        item.classList.toggle('is-selected', selecting.has(program.key))
        item.setAttribute('aria-pressed', String(selecting.has(program.key)))
    } else {
        item.setAttribute('aria-current', String(program.key === selectedKey))
    }

    const thumb = element('span', 'thumb')
    thumb.append(thumbnail(thumbnailOf(program.segments)))
    if (program.recording) thumb.append(element('span', 'live', '録画中'))
    thumb.append(element('span', 'length', formatDuration(recordedSeconds(program.segments))))

    const body = element('span', 'card-body')
    // 日付も付ける（大きい順や狭い画面では日ごとの見出しがなく、日をまたいだ番組は見出しの日と始めた日が違うので）
    const time = `${formatShortDate(program.startedAt)}${formatTime(program.startedAt)}〜${program.recording ? '' : formatEnd(program.startedAt, program.endedAt)}`
    const foot = element('span', 'card-foot')
    foot.append(kindDots(program.kinds), element('span', undefined, formatBytes(program.bytes)))
    body.append(
        element('span', 'card-title', programName(program)),
        element('span', 'card-meta', [program.userName, time].filter(Boolean).join('・')),
        foot,
    )
    item.append(thumb, body)
    if (selecting) item.append(element('span', 'check'))
    item.addEventListener('click', () => {
        if (selecting) toggleSelected(program.key)
        else select(program.key)
    })
    return item
}

const select = (key: string) => {
    if (key !== selectedKey) fileKind = null
    selectedKey = key
    history.replaceState(null, '', `#${encodeURIComponent(key)}`)
    keepFocus(() => {
        renderList()
        renderProgram()
    })
}

// ---- 選んで削除（容量を空けたい時に、いくつかの番組をまとめて） ----

const renderSelectBar = () => {
    sideFoot.hidden = selecting !== null
    selectBar.hidden = selecting === null
    if (!selecting) return
    const chosen = programs.filter(program => selecting!.has(program.key))
    const bytes = chosen.reduce((sum, program) => sum + finishedSegments(program).reduce((s, segment) => s + segment.bytes, 0), 0)
    selectSummary.textContent = chosen.length > 0 ? `${chosen.length}番組・${formatBytes(bytes)}を選択` : '削除する番組を選んでください'
    $<HTMLButtonElement>('selectDelete').disabled = chosen.length === 0
}

const setSelecting = (value: Set<string> | null) => {
    selecting = value
    keepFocus(renderList)
}

const toggleSelected = (key: string) => {
    if (!selecting) return
    if (selecting.has(key)) selecting.delete(key)
    else selecting.add(key)
    keepFocus(renderList)
}

selectModeButton.addEventListener('click', () => {
    setSelecting(new Set())
    programList.querySelector<HTMLElement>('.program-item')?.focus()
})
$<HTMLButtonElement>('selectCancel').addEventListener('click', () => {
    setSelecting(null)
    selectModeButton.focus()
})
$<HTMLButtonElement>('selectDelete').addEventListener('click', async () => {
    if (!selecting) return
    const chosen = programs.filter(program => selecting!.has(program.key))
    // 録画中の区間は、書き込み中なので消さない
    const segments = chosen.flatMap(finishedSegments)
    if (segments.length === 0) {
        showToast('録画中の録画は削除できません。')
        return
    }
    const bytes = segments.reduce((sum, segment) => sum + segment.bytes, 0)
    const note = chosen.some(program => program.recording) ? '\n（録画中の分は残します）' : ''
    if (!confirm(`${chosen.length}番組の録画（${formatBytes(bytes)}）を削除しますか？${note}`)) return
    selecting = null
    await deleteAndReload(segments.map(segment => segment.segmentId))
    ;(selectModeButton.hidden ? searchInput : selectModeButton).focus()
})

// ---- 選んだ番組 ----

// 見ている種類（プレイヤーで見ている種類。まだなければ、録ってある最初の種類）
const currentKind = (program: ProgramSummary): RecordingKind =>
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
            ? 'まだ録画がありません。\nニコ生の番組を録画すると、ここに番組ごとに並びます。'
            : selectedKey ? 'この番組の録画はありません。\n左の一覧から番組を選んでください。' : '左の一覧から番組を選んでください。'
        document.title = PAGE_TITLE
        return
    }

    emptyState.hidden = true
    programSection.hidden = false
    const name = programName(program)
    document.title = `${name} - ${PAGE_TITLE}`
    programTitle.textContent = name
    programTitle.title = name
    const period = `${formatDate(program.startedAt)} ${formatTime(program.startedAt)}〜${program.recording ? '' : formatEnd(program.startedAt, program.endedAt)}`
    // 配信者の名前が長い時は、名前の方を … で切る（録画中・長さ・容量が隠れないように）
    const meta: HTMLElement[] = program.userName ? [element('span', 'meta-user', program.userName)] : []
    meta.push(element('span', undefined, period))
    if (program.recording) meta.push(element('span', 'recording', '録画中'))
    meta.push(element('span', undefined, formatDuration(recordedSeconds(program.segments))))
    // 画質（録画の映像の高さ。途中で変わった・種類で違う時は、低い順に並べる）
    const heights = [...new Set(program.segments.map(segment => videoSizes.get(segment.segmentId)?.height).filter((h): h is number => !!h))].sort((a, b) => a - b)
    if (heights.length > 0) {
        const quality = element('span', undefined, heights.map(h => `${h}p`).join('・'))
        quality.title = '画質（録画の映像の高さ）'
        meta.push(quality)
    }
    meta.push(element('span', undefined, formatBytes(program.bytes)))
    programMeta.replaceChildren(...meta)

    // 番組のページ（以前のバージョンから移した録画は、番組が分からない）
    openWatch.hidden = !/^lv\d+$/.test(program.programId)
    if (!openWatch.hidden) openWatch.href = `${WATCH_URL}${program.programId}`

    if (viewKey !== program.key) {
        view?.destroy()
        viewState = null
        const key = program.key
        view = mountReviewView({
            root: player,
            mode: 'library',
            readTimeline: () => db.getTimelineForSegments(programs.find(p => p.key === key)?.segments.map(s => s.segmentId) ?? []),
            readFragments: db.getFragmentBlobs,
            programBeginAt: program.beginAt,
            recordingStartedAt: program.startedAt,
            screenshotName: () => {
                const current = programs.find(p => p.key === key) ?? program
                return [current.userName, current.title].filter(Boolean).join('_')
            },
            onChange: onViewChange,
        })
        viewKey = key
    } else {
        // 録画を消した後などで、最初に録った時刻が変わることがある（録画の一覧・タイムラインと同じ所から数える）
        view?.setTimeBases({ programBeginAt: program.beginAt, recordingStartedAt: program.startedAt })
    }
    if (!timelineDragging) renderTimeline(program)
    renderFiles(program)
    renderDownloadButton(program)
}

const onViewChange = (state: ReviewViewState) => {
    const kindChanged = state.kind !== viewState?.kind || state.kinds.length !== viewState?.kinds.length
    viewState = state
    const program = selectedProgram()
    if (!program) return
    if (kindChanged) {
        markCurrentLane(program)
        keepFocus(() => renderFiles(program))
        renderDownloadButton(program)
    }
    updatePlayhead(program)
    updateCurrentFile()
}

// ---- 保存（見ている種類。▾で種類を選べる） ----

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
                ? `${files.length}個のファイルに分けて保存しました（画質が変わった所や、つなげない形式の録画は、別のファイルになります）。`
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

// 番組の録画を、種類ごとに保存する（種類が違う録画は、別のファイルになる）
const downloadKinds = (program: ProgramSummary, kinds: RecordingKind[]) => {
    for (const kind of kinds) {
        const ids = program.segments.filter(segment => segment.kind === kind).map(segment => segment.segmentId)
        if (ids.length > 0) void downloadSegments(program, ids)
    }
}

const renderDownloadButton = (program: ProgramSummary) => {
    const kind = currentKind(program)
    downloadButton.title = `${KIND_LABELS[kind]}の録画を保存します`
    downloadButton.onclick = () => downloadKinds(program, [kind])
    downloadMenuButton.hidden = program.kinds.length < 2
    downloadButton.parentElement!.classList.toggle('split', program.kinds.length > 1)
}

const buildDownloadMenu = (program: ProgramSummary) => {
    const current = currentKind(program)
    const item = (label: string, kinds: RecordingKind[], bytes: number) => {
        const button = element('button', 'menu-item')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        const dots = element('span', 'dots')
        dots.append(...kinds.map(dot))
        button.append(dots, label, element('small', undefined, formatBytes(bytes)))
        button.addEventListener('click', () => {
            closeMenus()
            downloadKinds(program, kinds)
        })
        return button
    }
    downloadMenu.replaceChildren(
        element('div', 'menu-label', '保存する種類'),
        ...program.kinds.map(kind => item(`${KIND_LABELS[kind]}${kind === current ? '（見ている種類）' : ''}`, [kind], program.bytesByKind[kind])),
        item('すべての種類', program.kinds, program.bytes),
    )
}

// ---- メニュー（保存する種類・その他） ----

const menus = [
    { button: downloadMenuButton, menu: downloadMenu },
    { button: moreButton, menu: moreMenu },
]
// メニューの中にフォーカスがあれば、開いたボタンへ戻す（メニューを隠すと、フォーカスがページの先頭へ外れるので）
const closeMenus = () => {
    for (const { button, menu } of menus) {
        const hadFocus = menu.contains(document.activeElement)
        menu.hidden = true
        button.setAttribute('aria-expanded', 'false')
        if (hadFocus) button.focus()
    }
}
for (const { button, menu } of menus) {
    button.addEventListener('click', () => {
        const opening = menu.hidden
        closeMenus()
        if (!opening) return
        const program = selectedProgram()
        if (!program) return
        if (menu === downloadMenu) buildDownloadMenu(program)
        menu.hidden = false
        button.setAttribute('aria-expanded', 'true')
        menu.querySelector<HTMLElement>('.menu-item')?.focus()
    })
}
// メニューの外を押したら閉じる
document.addEventListener('pointerdown', (event) => {
    const target = event.target as Node
    if (!menus.some(({ button, menu }) => button.contains(target) || menu.contains(target))) closeMenus()
})
document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    const open = menus.find(({ menu }) => !menu.hidden)
    if (open) {
        closeMenus()
        open.button.focus()
    } else if (selecting) {
        setSelecting(null)
    }
})

// ---- タイムライン（種類ごとの録った時間） ----

const spanOf = (program: ProgramSummary) => {
    const start = program.startedAt
    const end = Math.max(program.endedAt, start + 60 * 1000)
    return { start, end, length: end - start }
}

const renderTimeline = (program: ProgramSummary) => {
    const { start, length } = spanOf(program)
    const ticks = element('div', 'ticks')
    ticks.setAttribute('aria-hidden', 'true')
    for (let i = 0; i <= 4; i++) {
        const time = start + (length * i) / 4
        // 録画を始めてからの時間
        const tick = element('span', undefined, formatRecorded(time - start))
        tick.style.left = `${(i / 4) * 100}%`
        ticks.append(tick)
    }

    const children: HTMLElement[] = [ticks]
    for (const [row, kind] of program.kinds.entries()) {
        const label = element('button', 'lane-label')
        label.type = 'button'
        label.dataset.kind = kind
        label.dataset.focusKey = `lane-label:${kind}`
        label.title = `${KIND_LABELS[kind]}に切り替える（同じ時刻のまま）`
        label.append(dot(kind), KIND_LABELS[kind])
        label.addEventListener('click', () => {
            const wallClock = viewState?.wallClock ?? undefined
            view?.show(kind, wallClock, viewState?.playing ?? false)
        })

        const track = element('button', `lane-track kind-${kind}`)
        track.type = 'button'
        track.dataset.kind = kind
        track.dataset.focusKey = `lane:${kind}`
        track.setAttribute('aria-label', `${KIND_LABELS[kind]}の録画。クリックした時刻から再生します`)
        const files = filesOf(program.segments, kind, signatures)
        for (const file of files) {
            file.blocks.forEach((range, i) => {
                const block = element('span', 'block')
                block.classList.toggle('is-recording', file.recording && i === file.blocks.length - 1)
                block.style.left = `${((range.start - start) / length) * 100}%`
                block.style.width = `${Math.max(0.4, ((range.end - range.start) / length) * 100)}%`
                track.append(block)
            })
        }
        attachTrackPointer(track, kind, program)
        // キーボードで押した時は、その種類の始めから再生する
        track.addEventListener('click', (event) => {
            if (event.detail === 0) view?.show(kind, files[0]?.startedAt ?? start, true)
        })
        // 再生位置の線（同じ列にまたがって重ねる）と重なるので、行と列を決めて置く
        label.style.gridArea = `${row + 2} / 1`
        track.style.gridArea = `${row + 2} / 2`
        children.push(label, track)
    }

    // 再生位置とマウスの位置の線（すべての種類の帯にまたがる）
    const overlay = element('div', 'lane-overlay')
    overlay.style.gridRow = `2 / span ${program.kinds.length}`
    overlay.append(element('div', 'playhead'), element('div', 'hoverline'))
    children.push(overlay)
    lanes.replaceChildren(...children)
    lanes.dataset.program = program.key
    hideHover()
    markCurrentLane(program)
    updatePlayhead(program)
}

// 押した所（x）の、録った時刻
const wallClockAtX = (program: ProgramSummary, x: number) => {
    const { start, length } = spanOf(program)
    const overlay = lanes.querySelector<HTMLElement>('.lane-overlay')
    if (!overlay) return start
    const rect = overlay.getBoundingClientRect()
    return start + Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * length
}

// クリックした時刻から再生する。押したまま動かした時は、動かしている間その場面を表示し、離した時刻から再生する
const attachTrackPointer = (track: HTMLElement, kind: RecordingKind, program: ProgramSummary) => {
    track.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !view) return
        event.preventDefault()
        track.setPointerCapture(event.pointerId)
        timelineDragging = true
        const startX = event.clientX
        let lastX = startX
        let dragged = false
        const move = (e: PointerEvent) => {
            lastX = e.clientX
            showHover(program, e.clientX)
            if (!dragged && Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return
            dragged = true
            view?.scrub(kind, wallClockAtX(program, e.clientX))
        }
        // 離した時のほか、掴んでいるのが外れた時（pointerup も pointercancel も来ない時）にも終える
        const end = (e: PointerEvent) => {
            track.removeEventListener('pointermove', move)
            track.removeEventListener('pointerup', end)
            track.removeEventListener('pointercancel', end)
            track.removeEventListener('lostpointercapture', end)
            timelineDragging = false
            view?.endScrub(kind, wallClockAtX(program, e.type === 'lostpointercapture' ? lastX : e.clientX), true)
            // 掴んでいる間に読み直した分を出す
            const current = selectedProgram()
            if (current && lanes.dataset.program === current.key) renderTimeline(current)
        }
        track.addEventListener('pointermove', move)
        track.addEventListener('pointerup', end)
        track.addEventListener('pointercancel', end)
        track.addEventListener('lostpointercapture', end)
    })
}

// マウスの位置の時刻を出す
const showHover = (program: ProgramSummary, x: number) => {
    const overlay = lanes.querySelector<HTMLElement>('.lane-overlay')
    const line = overlay?.querySelector<HTMLElement>('.hoverline')
    if (!overlay || !line) return
    const rect = overlay.getBoundingClientRect()
    if (x < rect.left || x > rect.right) {
        hideHover()
        return
    }
    line.hidden = false
    line.style.left = `${((x - rect.left) / rect.width) * 100}%`
    const tip = (line.firstElementChild ?? line.appendChild(element('span'))) as HTMLElement
    const wallClock = wallClockAtX(program, x)
    tip.textContent = `${describeTime(program, wallClock)}${timelineDragging ? '' : '・クリックで再生'}`
    // 線の真ん中に出し、帯の端では帯の中に収まるように寄せる
    const lineX = x - rect.left
    const width = tip.offsetWidth
    tip.style.left = `${Math.max(-lineX, Math.min(-width / 2, rect.width - lineX - width))}px`
}
const hideHover = () => {
    const line = lanes.querySelector<HTMLElement>('.hoverline')
    if (line) line.hidden = true
}
lanes.addEventListener('pointermove', (event) => {
    const program = selectedProgram()
    if (program && !timelineDragging) showHover(program, event.clientX)
})
lanes.addEventListener('pointerleave', () => { if (!timelineDragging) hideHover() })

const markCurrentLane = (program: ProgramSummary) => {
    const kind = currentKind(program)
    for (const label of lanes.querySelectorAll<HTMLElement>('.lane-label')) label.setAttribute('aria-pressed', String(label.dataset.kind === kind))
    for (const track of lanes.querySelectorAll<HTMLElement>('.lane-track')) track.classList.toggle('is-current', track.dataset.kind === kind)
}

const updatePlayhead = (program: ProgramSummary) => {
    const playhead = lanes.querySelector<HTMLElement>('.playhead')
    if (!playhead) return
    const { start, length } = spanOf(program)
    const wallClock = viewState?.wallClock ?? null
    playhead.hidden = wallClock === null
    if (wallClock !== null) playhead.style.left = `${Math.min(100, Math.max(0, ((wallClock - start) / length) * 100))}%`
}

// ---- 録画の一覧（保存した時のファイルの単位） ----

// 区間を削除して、一覧を読み直す
// フォーカスしていたボタンがなくなったら、同じ位置の録画（なければ番組の一覧の選んでいる番組）に移す
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
        const items = [...fileList.querySelectorAll<HTMLElement>('.file')]
        const item = position === undefined ? undefined : items[Math.min(position, items.length - 1)]
        return item?.querySelector<HTMLButtonElement>('button:not(:disabled)')
            ?? fileList.querySelector<HTMLButtonElement>('button:not(:disabled)')
            ?? programList.querySelector<HTMLElement>('.program-item[aria-current="true"]')
    })
    await view?.refresh()
}

const renderFiles = (program: ProgramSummary) => {
    const kind = fileKind && program.kinds.includes(fileKind) ? fileKind : currentKind(program)
    const filesByKind = new Map(program.kinds.map(k => [k, filesOf(program.segments, k, signatures)]))

    // 種類のタブ（種類が1つなら出さない）
    fileTabs.hidden = program.kinds.length < 2
    fileTabs.replaceChildren(...program.kinds.map((k) => {
        const tab = element('button', `tab kind-${k}`)
        tab.type = 'button'
        tab.setAttribute('role', 'tab')
        tab.setAttribute('aria-selected', String(k === kind))
        tab.dataset.focusKey = `tab:${k}`
        tab.title = KIND_LABELS[k]
        tab.append(dot(k), SHORT_KIND_LABELS[k], element('small', undefined, String(filesByKind.get(k)!.length)))
        tab.addEventListener('click', () => {
            fileKind = k
            keepFocus(() => renderFiles(program))
        })
        return tab
    }))

    const files = filesByKind.get(kind) ?? []
    if (files.length === 0) {
        fileList.replaceChildren(element('li', 'files-empty', 'この種類の録画はありません。'))
        return
    }
    fileList.replaceChildren(...files.map((file, position) => fileRow(program, file, position, files[position - 1])))
    updateCurrentFile()
}

// 録画の長さ・画質・大きさ（画質にマウスを乗せると、映像の大きさ）
const fileSize = (file: RecordingFile) => {
    const quality = qualityOf(file)
    const span = element('span', 'file-size', [formatDuration(file.seconds), quality?.label, formatBytes(file.bytes)].filter(Boolean).join('・'))
    if (quality) span.title = `画質 ${quality.detail}`
    return span
}

// 画質が変わった所の説明（前と後の画質が分かれば、それも出す）
const qualityChange = (previous: RecordingFile | undefined, file: RecordingFile) => {
    const before = previous && qualityOf(previous)
    const after = qualityOf(file)
    return before && after && before.label !== after.label ? `ここで画質が変わりました（${before.label} → ${after.label}）` : 'ここで画質が変わりました'
}

// previous: 1つ前の録画（画質が変わった所で、前の画質を出す）
const fileRow = (program: ProgramSummary, file: RecordingFile, position: number, previous?: RecordingFile) => {
    const first = file.segments[0]
    const item = element('li', `file kind-${file.kind}`)
    item.dataset.kind = file.kind
    item.dataset.start = String(file.startedAt)
    item.dataset.end = String(file.endedAt)
    // 録画を始めてからの時間（番組の経過時間と時刻は、マウスを乗せると出す）
    const when = `${formatRecorded(file.startedAt - program.startedAt)} 〜 ${file.recording ? '録画中' : formatRecorded(file.endedAt - program.startedAt)}`
    item.title = `${describeTime(program, file.startedAt)} 〜 ${file.recording ? '録画中' : describeTime(program, file.endedAt)}`

    // 画像を押すと、その録画の始めから再生する（webm の録画は、ここでは再生できない）
    const play = element('button', 'file-play')
    play.type = 'button'
    play.dataset.focusKey = `play:${first.segmentId}`
    play.append(thumbnail(file.thumbnail))
    const playable = first.format === 'fmp4'
    if (playable) {
        const overlay = element('span')
        overlay.append(ICONS.play())
        play.append(overlay)
        play.setAttribute('aria-label', `${when}の録画を再生`)
        play.addEventListener('click', (event) => {
            // マウスで押した時は、ボタンにフォーカスを残さない（続けてスペースを押すと、一時停止ではなく頭から再生し直すので）
            if (event.detail > 0) play.blur()
            view?.show(file.kind, file.startedAt, true)
        })
    } else {
        play.disabled = true
        play.title = 'この形式の録画は、ここでは再生できません（保存して見てください）'
    }

    const info = element('div', 'file-info')
    info.append(
        element('span', 'file-when', when),
        fileSize(file),
    )
    if (file.splitBySettings) info.append(element('span', 'file-note', qualityChange(previous, file)))

    const actions = element('div', 'file-actions')
    const save = element('button', 'icon-button')
    save.type = 'button'
    save.dataset.focusKey = `save:${first.segmentId}`
    save.title = '保存'
    save.setAttribute('aria-label', `${when}の録画を保存`)
    save.append(ICONS.download())
    save.addEventListener('click', () => downloadSegments(program, file.segments.map(segment => segment.segmentId)))

    // 録画中の区間は、書き込み中なので消さない（同じファイルの、録り終えた区間だけ消す）
    const finished = file.segments.filter(segment => !isRecordingSegment(segment))
    const remove = element('button', 'icon-button danger')
    remove.type = 'button'
    remove.dataset.focusKey = `delete:${first.segmentId}`
    remove.disabled = finished.length === 0
    remove.title = finished.length === 0 ? '録画中の録画は削除できません' : '削除'
    remove.setAttribute('aria-label', `${when}の録画を削除`)
    remove.append(ICONS.trash())
    remove.addEventListener('click', async () => {
        const bytes = finished.reduce((sum, segment) => sum + segment.bytes, 0)
        const note = finished.length < file.segments.length ? '\n（録画中の分は残します）' : ''
        if (!confirm(`${formatBroadcastTime(file.startedAt, { seconds: true })}時点からの録画（${formatBytes(bytes)}）を削除しますか？${note}`)) return
        await deleteAndReload(finished.map(segment => segment.segmentId), position)
    })
    actions.append(save, remove)

    item.append(play, info, actions)
    return item
}

// 再生している録画を目立たせる
const updateCurrentFile = () => {
    const wallClock = viewState?.wallClock ?? null
    for (const item of fileList.querySelectorAll<HTMLElement>('.file')) {
        const current = wallClock !== null && item.dataset.kind === viewState?.kind
            && Number(item.dataset.start) <= wallClock && wallClock < Number(item.dataset.end)
        item.setAttribute('aria-current', String(current))
    }
}

// ---- 操作 ----

$<HTMLButtonElement>('deleteProgram').addEventListener('click', async () => {
    closeMenus()
    const program = selectedProgram()
    if (!program) return
    // 録画中の区間は、書き込み中なので消さない
    const deletable = finishedSegments(program)
    if (deletable.length === 0) {
        showToast('録画中の録画は削除できません。')
        return
    }
    const bytes = deletable.reduce((sum, s) => sum + s.bytes, 0)
    const note = deletable.length < program.segments.length ? '\n（録画中の分は残します）' : ''
    if (!confirm(`「${programName(program)}」の録画（${formatBytes(bytes)}）を削除しますか？${note}`)) return
    await deleteAndReload(deletable.map(s => s.segmentId))
})

searchInput.addEventListener('input', () => {
    query = searchInput.value
    keepFocus(renderList)
})

orderSelect.addEventListener('change', () => {
    order = orderSelect.value as ProgramOrder
    keepFocus(renderList)
})

for (const button of filterButtons) {
    button.addEventListener('click', () => {
        kindFilter = (button.dataset.kind || null) as RecordingKind | null
        for (const b of filterButtons) b.setAttribute('aria-pressed', String(b === button))
        keepFocus(renderList)
    })
}

// 録画中の番組の分が増えるので、見ている間は読み直す。他のタブから戻ってきた時もすぐ読み直す
// （番組のページを閉じてから見に来た時に、その番組の「録画中」がすぐ外れるように）
setInterval(() => {
    if (document.visibilityState === 'visible') void load()
}, REFRESH_INTERVAL_MS)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void load()
})

// ニコ生のページなどから開かれた時（既に開いていれば、このページに番組を表示して前に出す）
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== SHOW_PROGRAM_MESSAGE) return
    if (typeof message.programId === 'string') {
        if (message.programId !== selectedKey) fileKind = null
        selectedKey = message.programId
    }
    void load().then(() => {
        if (selectedKey) history.replaceState(null, '', `#${encodeURIComponent(selectedKey)}`)
    })
    chrome.tabs.getCurrent().then((tab) => {
        if (tab?.id !== undefined) chrome.tabs.update(tab.id, { active: true })
        if (tab?.windowId !== undefined) chrome.windows.update(tab.windowId, { focused: true })
    }).catch(() => {})
    sendResponse(true)
})

// 狭い画面（番組の一覧が上にある時）は、プレイヤーとタイムラインの上にある部分（番組の一覧・見出し）の実際の高さを測って、
// 画面の残りの高さに収める（見出しの高さは、タイトルの長さや折り返しで変わる）。
// 収まらないほど低い時は、プレイヤーを最小の高さより小さくせずに、ページをスクロールする
const PLAYER_MIN_HEIGHT = 220 // style.css の .player の min-height
const stageElement = document.querySelector<HTMLElement>('.stage')!
const timelinePanel = document.querySelector<HTMLElement>('.timeline-panel')!
const fitStage = () => {
    const top = stageElement.getBoundingClientRect().top + window.scrollY
    const fit = window.innerHeight - top - 16 // .main の下の余白
    const least = PLAYER_MIN_HEIGHT + 12 + timelinePanel.offsetHeight // プレイヤーの最小の高さ・間・タイムライン
    document.documentElement.style.setProperty('--stage-max', `${Math.round(Math.max(least, fit))}px`)
}
const stageObserver = new ResizeObserver(fitStage)
for (const selector of ['.side', '.program-head', '.timeline-panel']) {
    const target = document.querySelector(selector)
    if (target) stageObserver.observe(target)
}
window.addEventListener('resize', fitStage)

// 以前のバージョンの録画の取り込み（手動。進み具合を番組の一覧の上に出す）
setupLegacyImport({
    notice: $<HTMLDivElement>('legacyNotice'),
    status: $<HTMLSpanElement>('legacyStatus'),
    dialog: $<HTMLDialogElement>('legacyDialog'),
    usageBytes: async () => (await db.getUsage()).bytes,
    formatBytes,
    reload: () => load(),
})

// 最初に選ぶ番組（指定がなければ、最近録った番組）
void load().then(() => {
    if (!selectedKey && programs.length > 0) select(programs[0].key)
})
