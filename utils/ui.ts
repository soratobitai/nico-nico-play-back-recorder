// ニコ生のページに置く録画バー（プレイヤーの下の1行）
// 左: 録画の状態と録画時間 / 中: 録る種類（コメントなし・コメントあり。設定のショートカット）と、画面録画を始めるボタン /
// 右: プレイバック・録画一覧・スクリーンショット・設定・録画開始/停止
// 録画の再生・保存・削除は、録画一覧のページ（拡張機能のページ）で行う。
import { getScreenShotAndDownload } from "./feature"
import { UI_COLLAPSED } from "./storage"

type BarState = 'preparing' | 'recording' | 'stopped' | 'error'
type VideoKind = 'video' | 'comments'

type RecorderBarOptions = {
    start: () => void
    stop: () => void
    showSettings: (event: MouseEvent) => void
    toggleKind: (kind: VideoKind) => void // 録る種類（コメントなし・コメントあり）を切り替える
    toggleScreenCapture: (() => void) | null // 画面録画を始める・やめる。使えない環境では null（ボタンを出さない）
    togglePlayback: (() => void) | null // プレイバック（別ウィンドウ）を使えない環境では null（ボタンを出さない）
    openRecordings: () => void // 録画一覧のページを開く
}

const BAR_ID = 'playbackRecorderBar'
const ERROR_MESSAGE = '空き容量が足りず録画を止めました。古い録画を削除するか、設定で上限を見直してください。'

const icon = (path: string, filled = false) =>
    `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${path}</svg>`
const ICONS = {
    // 録る種類（狭い時はチップを文字の代わりにこのアイコンにする）。コメントなしは吹き出しに斜線、コメントありは吹き出しに文字の線
    commentsOff: icon('<path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4.5 3.5v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"></path><path d="M3.5 3l17 17.5"></path>'),
    comments: icon('<path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4.5 3.5v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"></path><path d="M7.5 9h9M7.5 12.5h6"></path>'),
    // 画面（真ん中の丸は、録画中は点滅する）
    screen: icon('<rect x="2.5" y="4" width="19" height="13" rx="2.2"></rect><path d="M8.5 20.5h7M12 17v3.5"></path><circle class="npr-screen-rec" cx="12" cy="10.5" r="3.4" fill="currentColor" stroke="none"></circle>'),
    play: icon('<path d="M8 5.5v13l10.5-6.5z"></path>', true),
    list: icon('<rect x="3" y="4" width="18" height="6" rx="1.5"></rect><rect x="3" y="14" width="18" height="6" rx="1.5"></rect>'),
    camera: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle>'),
    gear: icon('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>'),
    record: '<span class="npr-record-dot" aria-hidden="true"></span>',
    stop: icon('<rect x="6" y="6" width="12" height="12" rx="2"></rect>', true),
    warning: icon('<path d="M12 3l10 18H2z"></path><path d="M12 10v5M12 18v.5"></path>'),
}

const BAR_HTML = `
<div id="${BAR_ID}" class="npr-bar" data-state="preparing">
  <div class="npr-status">
    <span class="npr-status-dot" aria-hidden="true"></span>
    <span id="recordStatus" class="npr-status-label" role="status">準備中</span>
    <span id="recordTime" class="npr-time" aria-label="録画時間">0:00</span>
  </div>

  <div class="npr-kinds" role="group" aria-label="録画する種類">
    <button type="button" class="npr-chip npr-chip-video" data-kind="video" aria-pressed="true" title="コメントなし: 映像と音声をそのまま録画します">
      <span class="npr-chip-icon" aria-hidden="true"></span>${ICONS.commentsOff}<span class="npr-long">コメントなし</span><span class="npr-short" aria-hidden="true">コメなし</span>
    </button>
    <button type="button" class="npr-chip npr-chip-comments" data-kind="comments" aria-pressed="false" title="コメントあり: 流れるコメントを重ねて録画します（タブを表示している間）">
      <span class="npr-chip-icon" aria-hidden="true"></span>${ICONS.comments}<span class="npr-long">コメントあり</span><span class="npr-short" aria-hidden="true">コメあり</span>
    </button>
    <span class="npr-hint" role="status"></span>
  </div>

  <!-- 画面録画（設定ではなく、ページを開くたびに押して始める。録る種類のチップとは別の、開始ボタンの形） -->
  <div class="npr-screen">
    <button type="button" id="screenCaptureButton" class="npr-screen-button" aria-pressed="false" hidden>
      ${ICONS.screen}<span class="npr-screen-label">画面録画<span class="npr-screen-state" aria-hidden="true"></span></span>
    </button>
  </div>

  <p id="recorderError" class="npr-error" title="${ERROR_MESSAGE}">${ICONS.warning}<span>${ERROR_MESSAGE}</span></p>

  <div class="npr-actions">
    <button type="button" id="playbackButton" class="npr-button npr-primary" aria-pressed="false" hidden>
      ${ICONS.play}<span class="npr-label">プレイバック</span>
    </button>
    <button type="button" id="recordingsButton" class="npr-button" title="録画一覧を開きます（番組ごとの再生・まとめて保存・削除）">
      ${ICONS.list}<span class="npr-label">録画一覧</span>
    </button>
    <button type="button" id="capButton" class="npr-icon-button" aria-label="スクリーンショット" title="スクリーンショットを保存">${ICONS.camera}</button>
    <button type="button" id="settingsButton" class="npr-icon-button" aria-label="設定" title="設定">${ICONS.gear}</button>
    <button type="button" id="recordButton" class="npr-record" disabled>
      <span class="npr-record-icon">${ICONS.record}</span><span class="npr-record-label">録画開始</span>
    </button>
  </div>
</div>
`

let bar: HTMLElement | null = null
let recordButton: HTMLButtonElement | null = null
let screenCaptureButton: HTMLButtonElement | null = null
let playbackButton: HTMLButtonElement | null = null
let state: BarState = 'preparing'
let hintTimer: ReturnType<typeof setTimeout> | undefined

// 折りたたみ（プレイヤーの操作バーのボタンで、録画バーを隠す）
let isCollapsed = false
let toggleButton: HTMLButtonElement | null = null

// 録画バーをプレイヤーの下に作る
const insertRecorderBar = ({ start, stop, showSettings, toggleKind, toggleScreenCapture, togglePlayback, openRecordings }: RecorderBarOptions) => {
    const controlArea = document.querySelector('[class*="_control-area_"]')
    if (!controlArea) return
    controlArea.insertAdjacentHTML("afterend", BAR_HTML)

    bar = document.getElementById(BAR_ID)!
    const $ = <T extends HTMLElement>(selector: string) => bar!.querySelector<T>(selector)!
    recordButton = $<HTMLButtonElement>('#recordButton')
    screenCaptureButton = $<HTMLButtonElement>('#screenCaptureButton')
    playbackButton = $<HTMLButtonElement>('#playbackButton')

    // 録画開始・停止（1つのボタンで切り替える）
    recordButton.addEventListener('click', () => {
        if (state === 'recording') stop()
        else start()
    })

    for (const chip of bar.querySelectorAll<HTMLButtonElement>('.npr-chip[data-kind]')) {
        chip.addEventListener('click', () => toggleKind(chip.dataset.kind as VideoKind))
    }

    if (toggleScreenCapture) {
        screenCaptureButton.hidden = false
        screenCaptureButton.addEventListener('click', toggleScreenCapture)
        setScreenCaptureButton(false)
    }

    if (togglePlayback) {
        playbackButton.hidden = false
        playbackButton.addEventListener('click', togglePlayback)
        setPlaybackButton(false)
    }

    $<HTMLButtonElement>('#recordingsButton').addEventListener('click', openRecordings)
    $<HTMLButtonElement>('#capButton').addEventListener('click', getScreenShotAndDownload)
    $<HTMLButtonElement>('#settingsButton').addEventListener('click', showSettings)

    // 中身の大きさが変わったら（幅・録画時間・ボタンの文字など）、はみ出していないか確かめる
    const observer = new ResizeObserver(fitBar)
    for (const element of [bar, ...bar.children]) observer.observe(element)

    setRecorderState(state)
}

// 幅ごとに詰める表示（style.css のコンテナクエリ）でも入り切らない時は、最も詰めた表示にする
// （ブラウザの最小フォントサイズの設定などで、文字が想定より大きく表示される環境）。
// その時のバーの幅より広くなったら、元に戻して確かめ直す
let tightWidth = 0
// 中身が、バーの左右の余白を除いた所からはみ出しているか（余白にはみ出しただけでは scrollWidth に出ないので、位置で比べる）
const isOverflowing = (target: HTMLElement) => {
    const right = target.getBoundingClientRect().right - parseFloat(getComputedStyle(target).paddingRight)
    return [...target.children].some(child => child.getBoundingClientRect().right > right + 0.5)
}
const fitBar = () => {
    if (!bar) return
    const width = bar.clientWidth
    if (bar.dataset.tight !== undefined && width > tightWidth) delete bar.dataset.tight
    if (bar.dataset.tight === undefined && isOverflowing(bar)) {
        bar.dataset.tight = ''
        tightWidth = width
    }
}

// 録画の状態を表示する
const STATE_LABELS: Record<BarState, string> = { preparing: '準備中', recording: '録画中', stopped: '停止中', error: '保存エラー' }
// 文字を隠して丸やアイコンだけの時のための説明
const STATE_TITLES: Record<BarState, string> = {
    preparing: '準備中: 動画の読み込みを待っています',
    recording: '録画中',
    stopped: '停止中',
    error: `保存エラー: ${ERROR_MESSAGE}`,
}

const setRecorderState = (next: BarState) => {
    state = next
    if (!bar || !recordButton) return
    bar.dataset.state = next
    bar.querySelector('#recordStatus')!.textContent = STATE_LABELS[next]
    bar.querySelector<HTMLElement>('.npr-status')!.title = STATE_TITLES[next]

    const recording = next === 'recording'
    recordButton.disabled = next === 'preparing'
    recordButton.classList.toggle('is-stop', recording)
    recordButton.querySelector('.npr-record-icon')!.innerHTML = recording ? ICONS.stop : ICONS.record
    recordButton.querySelector('.npr-record-label')!.textContent = recording ? '停止' : '録画開始'
    recordButton.title = recording ? '録画を止めます' : next === 'preparing' ? '動画の読み込みを待っています' : '録画を始めます'
}

// 録る種類（設定）の表示
const setKindChips = (kinds: Record<VideoKind, boolean>) => {
    for (const chip of bar?.querySelectorAll<HTMLButtonElement>('.npr-chip[data-kind]') ?? []) {
        chip.setAttribute('aria-pressed', String(kinds[chip.dataset.kind as VideoKind]))
    }
}

// 録画バーに短いお知らせを出す（数秒で消える）
const showBarHint = (text: string) => {
    const hint = bar?.querySelector<HTMLElement>('.npr-hint')
    if (!hint) return
    hint.textContent = text
    hint.classList.add('is-visible')
    clearTimeout(hintTimer)
    hintTimer = setTimeout(() => hint.classList.remove('is-visible'), 3000)
}

// 画面録画のボタンの表示（active: 録っている）
// 画面録画は、ページを開くたびにこのボタンを押して、画面共有を許可して始める（自動では始められない）
function setScreenCaptureButton(active: boolean) {
    if (!screenCaptureButton) return
    screenCaptureButton.setAttribute('aria-pressed', String(active))
    // 読み上げの名前は「画面録画」のまま（録っているかは「押されている」で伝わる）。見た目だけ「画面録画中」にする
    screenCaptureButton.querySelector('.npr-screen-state')!.textContent = active ? '中' : ''
    screenCaptureButton.title = active
        ? 'クリックすると、画面録画だけを止めます（他の録画は続きます）'
        : 'ゲームやギフトなどの演出も含めて、プレイヤーの画面をそのまま録画します（クリックして「このタブを共有」を許可すると始まります）'
}

// プレイバックのボタンの表示
function setPlaybackButton(open: boolean) {
    if (!playbackButton) return
    playbackButton.setAttribute('aria-pressed', String(open))
    playbackButton.title = open
        ? 'クリックすると、プレイバックのウィンドウを閉じます'
        : '録画を止めずに、少し前の映像を別のウィンドウで見ます'
}

// 録画時間の表示（1時間を超えたら時:分:秒）
const getTimeString = (startTime: number) => {
    const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000))
    const h = Math.floor(elapsed / 3600)
    const m = Math.floor((elapsed % 3600) / 60)
    const s = String(elapsed % 60).padStart(2, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// プレイヤーの操作バーに、録画バーを隠す・出すボタンを置く（録画中は赤い印）
const insertToggleButton = async () => {
    if (document.getElementById('recording-toggle-button')) return

    const addonController = document.querySelector('[class*="addon-controller"]') as HTMLElement
    if (!addonController) return

    // 保存された折りたたみ状態を読み込む
    isCollapsed = await UI_COLLAPSED.getValue()

    toggleButton = document.createElement('button')
    toggleButton.id = 'recording-toggle-button'
    toggleButton.className = 'recording-toggle-button'
    toggleButton.type = 'button'
    toggleButton.setAttribute('aria-label', '録画バーを表示（ニコ生プレイバックレコーダー）')
    toggleButton.setAttribute('aria-controls', BAR_ID)
    toggleButton.innerHTML = '<span class="recording-toggle-mark" aria-hidden="true"></span>'

    const apply = () => {
        const target = document.getElementById(BAR_ID)
        if (target) target.hidden = isCollapsed
        toggleButton!.setAttribute('aria-expanded', String(!isCollapsed))
    }
    apply()

    toggleButton.addEventListener('click', async () => {
        isCollapsed = !isCollapsed
        apply()
        await UI_COLLAPSED.setValue(isCollapsed)
    })

    addonController.appendChild(toggleButton)
}

// プレイヤーの操作バーのボタンに、録画中かどうかを出す
const updateToggleButton = (isRecording: boolean) => {
    toggleButton?.classList.toggle('is-recording', isRecording)
}

export {
    insertRecorderBar,
    setRecorderState,
    setKindChips,
    showBarHint,
    setScreenCaptureButton,
    setPlaybackButton,
    getTimeString,
    insertToggleButton,
    updateToggleButton,
}
export type { BarState }
