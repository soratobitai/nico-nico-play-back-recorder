// ニコ生のページに置く録画バー（プレイヤーの下の1行）
// 左: 録画の状態と録画時間 / 中: 録る種類（コメントなし・コメントあり・演出あり。設定のショートカット） / 右: プレイバック・録画一覧・スクリーンショット・設定・録画開始/停止
// 録画の再生・保存・削除は、録画一覧のページ（拡張機能のページ）で行う。
import { getScreenShotAndDownload } from "./feature"
import { UI_COLLAPSED } from "./storage"

type BarState = 'preparing' | 'recording' | 'stopped' | 'error'
type VideoKind = 'video' | 'comments'

type RecorderBarOptions = {
    start: () => void
    stop: () => void
    showSettings: () => void
    toggleKind: (kind: VideoKind) => void // 録る種類（コメントなし・コメントあり）を切り替える
    toggleScreenCapture: (() => void) | null // 演出あり（画面ごとの録画）を始める・やめる。使えない環境では null（チップを出さない）
    togglePlayback: (() => void) | null // プレイバック（別ウィンドウ）を使えない環境では null（ボタンを出さない）
    openRecordings: () => void // 録画一覧のページを開く
}

const BAR_ID = 'playbackRecorderBar'
const ERROR_MESSAGE = '空き容量が足りず録画を止めました。古い録画を削除するか、設定で上限を見直してください。'

const icon = (path: string, filled = false) =>
    `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'}>${path}</svg>`
const ICONS = {
    check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"></path>'),
    plus: icon('<path d="M12 5v14M5 12h14"></path>'),
    play: icon('<path d="M8 5.5v13l10.5-6.5z"></path>', true),
    list: icon('<rect x="3" y="4" width="18" height="6" rx="1.5"></rect><rect x="3" y="14" width="18" height="6" rx="1.5"></rect>'),
    camera: icon('<path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle>'),
    gear: icon('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>'),
    record: '<span class="npr-record-dot" aria-hidden="true"></span>',
    stop: icon('<rect x="6" y="6" width="12" height="12" rx="2"></rect>', true),
    warning: icon('<path d="M12 3l10 18H2z"></path><path d="M12 10v5M12 18v.5"></path>'),
    close: icon('<path d="M6 6l12 12M18 6L6 18"></path>'),
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
      <span class="npr-chip-icon">${ICONS.check}</span><span class="npr-long">コメントなし</span><span class="npr-short" aria-hidden="true">コメなし</span>
    </button>
    <button type="button" class="npr-chip npr-chip-comments" data-kind="comments" aria-pressed="false" title="コメントあり: 流れるコメントを重ねて録画します（タブを表示している間）">
      <span class="npr-chip-icon">${ICONS.check}</span><span class="npr-long">コメントあり</span><span class="npr-short" aria-hidden="true">コメあり</span>
    </button>
    <span class="npr-screen">
      <button type="button" id="screenCaptureButton" class="npr-chip npr-chip-screen" aria-pressed="false" aria-describedby="screenCallout" hidden>
        <span class="npr-chip-icon">${ICONS.plus}</span><span class="npr-long">演出あり</span><span class="npr-short" aria-hidden="true">演出</span>
      </button>
      <span id="screenCallout" class="npr-callout" role="status" hidden>
        <span class="npr-callout-text"><strong>演出ありの録画</strong>「開始」を押して、このタブの共有を許可すると始まります</span>
        <span class="npr-callout-actions">
          <button type="button" class="npr-callout-start">開始</button>
          <button type="button" class="npr-callout-close" aria-label="このお知らせを閉じる">${ICONS.close}</button>
        </span>
      </span>
    </span>
    <span class="npr-hint" role="status"></span>
  </div>

  <p id="recorderError" class="npr-error">${ICONS.warning}<span>${ERROR_MESSAGE}</span></p>

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
let screenCallout: HTMLElement | null = null
let screenCalloutDismissed = false // このページでは、もう「演出あり」の吹き出しを出さない
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
    screenCallout = $<HTMLElement>('#screenCallout')
    screenCalloutDismissed = false
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
        // 吹き出しの「開始」は、チップを押したのと同じ（共有の確認を出すので、クリックから始める）
        $<HTMLButtonElement>('.npr-callout-start').addEventListener('click', toggleScreenCapture)
        $<HTMLButtonElement>('.npr-callout-close').addEventListener('click', () => {
            screenCalloutDismissed = true
            screenCallout!.hidden = true
        })
        setScreenCaptureButton('off')
    }

    if (togglePlayback) {
        playbackButton.hidden = false
        playbackButton.addEventListener('click', togglePlayback)
        setPlaybackButton(false)
    }

    $<HTMLButtonElement>('#recordingsButton').addEventListener('click', openRecordings)
    $<HTMLButtonElement>('#capButton').addEventListener('click', getScreenShotAndDownload)
    $<HTMLButtonElement>('#settingsButton').addEventListener('click', showSettings)

    setRecorderState(state)
}

// 録画の状態を表示する
const STATE_LABELS: Record<BarState, string> = { preparing: '準備中', recording: '録画中', stopped: '停止中', error: '保存エラー' }

const setRecorderState = (next: BarState) => {
    state = next
    if (!bar || !recordButton) return
    bar.dataset.state = next
    bar.querySelector('#recordStatus')!.textContent = STATE_LABELS[next]

    const recording = next === 'recording'
    recordButton.disabled = next === 'preparing'
    recordButton.classList.toggle('is-stop', recording)
    recordButton.querySelector('.npr-record-icon')!.innerHTML = recording ? ICONS.stop : ICONS.record
    recordButton.querySelector('.npr-record-label')!.textContent = recording ? '停止' : '録画開始'
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

// 演出あり（画面ごとの録画）のチップの表示
// off: 録っていない / ready: 設定で「演出あり」を選んでいるが、まだ始めていない（押して共有を許可すると始まる）/ on: 録っている
// ready の間は、チップの上の吹き出しで、押して共有を許可するよう促す（閉じたら、このページではもう出さない）
type ScreenChipState = 'off' | 'ready' | 'on'
function setScreenCaptureButton(chipState: ScreenChipState) {
    if (!screenCaptureButton) return
    screenCaptureButton.setAttribute('aria-pressed', String(chipState === 'on'))
    screenCaptureButton.classList.toggle('is-ready', chipState === 'ready')
    if (screenCallout) screenCallout.hidden = chipState !== 'ready' || screenCalloutDismissed
    screenCaptureButton.querySelector('.npr-chip-icon')!.innerHTML = chipState === 'on' ? ICONS.check : ICONS.plus
    screenCaptureButton.title = {
        on: '演出あり: クリックすると、演出ありの録画だけをやめます',
        ready: '演出あり: クリックして「このタブを共有」を許可すると、ゲームやギフトなどの演出も含めた録画を始めます',
        off: '演出あり: ゲームやギフトなどの演出も含めて、プレイヤーの画面ごと録画します（「このタブを共有」の許可が必要です）',
    }[chipState]
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
export type { BarState, ScreenChipState }
