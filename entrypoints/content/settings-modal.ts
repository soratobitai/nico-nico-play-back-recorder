// 設定（画面の中央に開くダイアログ。横に「録画する種類」「録画」「保存」を並べる）
// 録る種類は、ページを開いた時に録る種類（録画バーのチップでは、そのタブだけ切り替えられる）
import {
  LEGACY_RECORDINGS,
  MAX_STORAGE_SIZE,
  AUTO_START,
  AUTO_RELOAD_ON_FAILURE,
  RECORD_VIDEO,
  RECORD_WITH_COMMENTS,
  RESOLUTION_MODE,
  FIXED_RESOLUTION_HEIGHT,
  type ResolutionMode,
} from '../../utils/storage'
import { getUsage, clearAll, estimateStorage } from '../../utils/library/api'
import { hasLegacyDatabase, deleteLegacyDatabase } from '../../hooks/indexedDB/recordingDB'

const GB = 1024 * 1024 * 1024
// 容量の上限の範囲
const MAX_STORAGE_SIZE_LIMIT = 100 * GB
// ホイールでスライダーを1目盛り動かす量（ピクセル。マウスのホイール1回分。タッチパッドは細かく届くので足し合わせる）
const WHEEL_STEP_PIXELS = 100
// ホイールで動かした値を保存するまでの時間（動かし終えてから保存する）
const WHEEL_SAVE_DELAY_MS = 600
// 開いた直後に、この間のダブルクリックの2回目は無視する（歯車のダブルクリック）
const OPEN_CLICK_GUARD_MS = 1000
const STORAGE_QUOTA_ESTIMATE = 30 * GB

interface Settings {
  MAX_STORAGE_SIZE: number
  AUTO_START: boolean
  AUTO_RELOAD_ON_FAILURE: boolean
  RECORD_VIDEO: boolean
  RECORD_WITH_COMMENTS: boolean
  RESOLUTION_MODE: ResolutionMode
  FIXED_RESOLUTION_HEIGHT: number
}

type SettingsModalOptions = {
  // 画面録画を、この環境で使えるか。画面録画は設定ではなく、録画バーのボタンで始める
  // （ブラウザの決まりで、ページを開くたびにクリックして画面共有を許可する必要があり、自動では始められないため）
  screenCaptureSupported?: boolean
}

// 「1本の録画にそろえる」（一定の解像度で録る）時に選べる高さ（幅は 16:9。ニコ生は 720p 以下の番組が多い）
const FIXED_RESOLUTION_OPTIONS = [
  { height: 360, label: '360p（640×360）' },
  { height: 450, label: '450p（800×450）' },
  { height: 540, label: '540p（960×540）' },
  { height: 720, label: '720p（1280×720）' },
  { height: 1080, label: '1080p（1920×1080）' },
]

const CLOSE_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>'

const toGB = (bytes: number) => Math.round(bytes / GB)
const formatUsage = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`

// 設定の項目と、その入力欄（チェックボックス）
const CHECKBOXES: Partial<Record<keyof Settings, string>> = {
  AUTO_START: 'autostartCheckbox',
  AUTO_RELOAD_ON_FAILURE: 'autoReloadCheckbox',
  RECORD_VIDEO: 'recordVideoCheckbox',
  RECORD_WITH_COMMENTS: 'recordCommentsCheckbox',
}

class SettingsModal {
  private modal: HTMLDialogElement | null = null
  private isVisible: boolean = false
  private settings: Settings = {
    MAX_STORAGE_SIZE: 1 * GB,
    AUTO_START: true,
    AUTO_RELOAD_ON_FAILURE: false,
    RECORD_VIDEO: true,
    RECORD_WITH_COMMENTS: false,
    RESOLUTION_MODE: 'split',
    FIXED_RESOLUTION_HEIGHT: 720,
  }
  private screenCaptureSupported: boolean
  private currentStorageUsage: number | null = null
  private usageError = false // 使用量を読み込めなかった
  private storageQuota: number = 0
  private messageTimer: ReturnType<typeof setTimeout> | null = null
  private kindsMessageTimer: ReturnType<typeof setTimeout> | null = null
  private usageUpdateInterval: ReturnType<typeof setInterval> | null = null
  private pendingWheelSave: { timer: ReturnType<typeof setTimeout>, save: () => void } | null = null // ホイールで動かした値の、待っている保存
  private closedAt = -Infinity // 閉じた時刻（performance.now）

  constructor({ screenCaptureSupported = false }: SettingsModalOptions = {}) {
    this.screenCaptureSupported = screenCaptureSupported
    this.loadSettings()
    this.watchSettings()
    // 使用量は全録画を読んで数えるので、ここでは取らずに設定画面を開いた時に取る
    this.loadStorageQuota()
  }

  private async loadSettings() {
    const [size, autoStart, autoReload, recordVideo, recordComments, resolutionMode, fixedResolutionHeight] = await Promise.all([
      MAX_STORAGE_SIZE.getValue(),
      AUTO_START.getValue(),
      AUTO_RELOAD_ON_FAILURE.getValue(),
      RECORD_VIDEO.getValue(),
      RECORD_WITH_COMMENTS.getValue(),
      RESOLUTION_MODE.getValue(),
      FIXED_RESOLUTION_HEIGHT.getValue(),
    ])
    this.applySetting('MAX_STORAGE_SIZE', size)
    this.applySetting('AUTO_START', autoStart)
    this.applySetting('AUTO_RELOAD_ON_FAILURE', autoReload)
    this.applySetting('RECORD_VIDEO', recordVideo)
    this.applySetting('RECORD_WITH_COMMENTS', recordComments)
    this.applySetting('RESOLUTION_MODE', resolutionMode)
    this.applySetting('FIXED_RESOLUTION_HEIGHT', fixedResolutionHeight)
  }

  // 他のタブや録画バーのチップで設定が変わったら合わせる（古い値のまま容量の上限を書き戻すと、録画が大量に消えてしまう）
  private watchSettings() {
    MAX_STORAGE_SIZE.watch(value => this.applySetting('MAX_STORAGE_SIZE', value))
    AUTO_START.watch(value => this.applySetting('AUTO_START', value))
    AUTO_RELOAD_ON_FAILURE.watch(value => this.applySetting('AUTO_RELOAD_ON_FAILURE', value))
    RECORD_VIDEO.watch(value => this.applySetting('RECORD_VIDEO', value))
    RECORD_WITH_COMMENTS.watch(value => this.applySetting('RECORD_WITH_COMMENTS', value))
    RESOLUTION_MODE.watch(value => this.applySetting('RESOLUTION_MODE', value))
    FIXED_RESOLUTION_HEIGHT.watch(value => this.applySetting('FIXED_RESOLUTION_HEIGHT', value))
  }

  // 保存されている設定の値を、覚えている値と（開いていれば）設定画面に反映する
  private applySetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings[key] = value
    const modal = this.modal
    if (!modal) return
    const checkboxId = CHECKBOXES[key]
    if (checkboxId) {
      const checkbox = modal.querySelector<HTMLInputElement>(`#${checkboxId}`)
      if (checkbox) checkbox.checked = value as boolean
      return
    }
    switch (key) {
      case 'MAX_STORAGE_SIZE': {
        const range = modal.querySelector<HTMLInputElement>('#storageRange')
        if (range) range.value = String(value)
        this.updateStorageLabel(value as number)
        break
      }
      case 'RESOLUTION_MODE': {
        for (const radio of modal.querySelectorAll<HTMLInputElement>('input[name="resolutionMode"]')) radio.checked = radio.value === value
        const select = modal.querySelector<HTMLSelectElement>('#fixedResolutionSelect')
        if (select) select.disabled = value !== 'fixed'
        break
      }
      case 'FIXED_RESOLUTION_HEIGHT': {
        const select = modal.querySelector<HTMLSelectElement>('#fixedResolutionSelect')
        if (select) select.value = String(value)
        break
      }
    }
  }

  private async getStorageUsageData() {
    try {
      const usage = await getUsage()
      this.currentStorageUsage = usage.bytes
      this.usageError = false
    } catch (error) {
      console.error('ストレージ使用量の取得に失敗しました:', error)
      this.currentStorageUsage = null
      this.usageError = true
    }
    this.updateUsageDisplay()
  }

  // 保存先（拡張機能側）の上限を取得（推奨値の表示に使う）
  private async loadStorageQuota() {
    try {
      const estimate = await estimateStorage()
      if (estimate.quota) this.storageQuota = Math.floor(estimate.quota * 0.8)
    } catch (error) {
      console.warn('ストレージ上限の取得に失敗:', error)
    }
  }

  private async updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings[key] = value
    switch (key) {
      case 'MAX_STORAGE_SIZE':
        await MAX_STORAGE_SIZE.setValue(value as number)
        break
      case 'AUTO_START':
        await AUTO_START.setValue(value as boolean)
        break
      case 'AUTO_RELOAD_ON_FAILURE':
        await AUTO_RELOAD_ON_FAILURE.setValue(value as boolean)
        break
      case 'RECORD_VIDEO':
        await RECORD_VIDEO.setValue(value as boolean)
        break
      case 'RECORD_WITH_COMMENTS':
        await RECORD_WITH_COMMENTS.setValue(value as boolean)
        break
      case 'RESOLUTION_MODE':
        await RESOLUTION_MODE.setValue(value as ResolutionMode)
        break
      case 'FIXED_RESOLUTION_HEIGHT':
        await FIXED_RESOLUTION_HEIGHT.setValue(value as number)
        break
    }
  }

  private showMessage(text: string, type: 'success' | 'error') {
    const element = this.modal?.querySelector<HTMLElement>('.message-display')
    if (!element) return
    element.textContent = text
    element.dataset.type = type
    if (this.messageTimer) clearTimeout(this.messageTimer)
    this.messageTimer = setTimeout(() => {
      element.textContent = ''
    }, 3000)
  }

  // 録画する種類の欄に、短いお知らせを出す
  private showKindsMessage(text: string) {
    const element = this.modal?.querySelector<HTMLElement>('.npr-kinds-message')
    if (!element) return
    element.textContent = text
    if (this.kindsMessageTimer) clearTimeout(this.kindsMessageTimer)
    this.kindsMessageTimer = setTimeout(() => {
      element.textContent = ''
    }, 3000)
  }

  private createModalHTML(): string {
    const s = this.settings
    const recommended = this.storageQuota > 0 ? `（おすすめ: ${toGB(Math.min(this.storageQuota, STORAGE_QUOTA_ESTIMATE))} GB 以下）` : ''
    const checked = (value: boolean) => value ? 'checked' : ''
    const kindSwitch = (id: string, kind: string, value: boolean, title: string, desc: string) => `
      <label class="npr-switch npr-kind-switch npr-kind-${kind}" for="${id}">
        <span class="npr-option-text">
          <span class="npr-option-title"><span class="npr-kind-dot" aria-hidden="true"></span>${title}</span>
          <span class="npr-option-desc">${desc}</span>
        </span>
        <input id="${id}" type="checkbox" role="switch" ${checked(value)} />
      </label>`
    const optionSwitch = (id: string, value: boolean, title: string, desc: string) => `
      <label class="npr-switch" for="${id}">
        <span class="npr-option-text">
          <span class="npr-option-title">${title}</span>
          <span class="npr-option-desc">${desc}</span>
        </span>
        <input id="${id}" type="checkbox" role="switch" ${checked(value)} />
      </label>`
    return `
      <dialog class="npr-settings" id="settingsModal" lang="ja" aria-labelledby="nprSettingsTitle" tabindex="-1">
        <div class="npr-settings-panel">
          <header class="npr-settings-head">
            <h2 id="nprSettingsTitle">設定</h2>
            <button type="button" class="npr-settings-close" aria-label="設定を閉じる">${CLOSE_ICON}</button>
          </header>

          <div class="npr-settings-body">
            <section class="npr-section" aria-labelledby="nprKindsTitle">
              <h3 id="nprKindsTitle">録画する種類</h3>
              ${kindSwitch('recordVideoCheckbox', 'video', s.RECORD_VIDEO, 'コメントなし', '映像と音声をそのまま録画します')}
              ${kindSwitch('recordCommentsCheckbox', 'comments', s.RECORD_WITH_COMMENTS, 'コメントあり', '流れるコメントを重ねて録画します。タブを表示していない時は、コメントは録画されません')}
              <div class="npr-kind-info npr-kind-screen">
                <span class="npr-option-text">
                  <span class="npr-option-title"><span class="npr-kind-dot" aria-hidden="true"></span>画面録画</span>
                  <span class="npr-option-desc">${this.screenCaptureSupported
                    ? 'ゲームやギフトなどの演出も含めて、プレイヤーの画面をそのまま録画します。マウスのカーソルや、プレイヤーに重なって表示されたもの（この設定画面など）も一緒に録画されます。タブを表示していない時も録画できます。録画バーの「画面録画」を押して始めます（ページを開くたびに画面共有の許可が必要です）'
                    : 'この環境では使えません'}</span>
                </span>
              </div>
              <p class="npr-option-desc npr-kinds-note">ページを開いた時に録画する種類です（ここで変えても、開いているタブの録画は変わりません。録画バーのボタンでは、そのタブだけ切り替えられ、そのタブを閉じるまで選んだ種類のままです）。選んだ種類は、別々の録画として同時に録ります</p>
              <p class="npr-kinds-message" role="status"></p>
            </section>

            <section class="npr-section" aria-labelledby="nprRecordingTitle">
              <h3 id="nprRecordingTitle">録画</h3>
              ${optionSwitch('autostartCheckbox', s.AUTO_START, 'オートスタート', '番組を開いたら録画を始めます')}
              ${optionSwitch('autoReloadCheckbox', s.AUTO_RELOAD_ON_FAILURE, 'オートリロード', '映像が止まったら読み込み直します')}
              <fieldset class="npr-group">
                <legend><h3>配信の画質が変わった時</h3></legend>
                <label class="npr-radio" for="resolutionSplitRadio">
                  <input id="resolutionSplitRadio" type="radio" name="resolutionMode" value="split" ${checked(s.RESOLUTION_MODE === 'split')} />
                  <span class="npr-option-text">
                    <span class="npr-option-title">画質が変わった所で分ける</span>
                    <span class="npr-option-desc">配信の画質のまま録ります。画質が変わった所で、録画が分かれます</span>
                  </span>
                </label>
                <label class="npr-radio" for="resolutionFixedRadio">
                  <input id="resolutionFixedRadio" type="radio" name="resolutionMode" value="fixed" ${checked(s.RESOLUTION_MODE === 'fixed')} />
                  <span class="npr-option-text">
                    <span class="npr-option-title">1本の録画にそろえる</span>
                    <span class="npr-option-desc">画質が変わっても、下で選んだ大きさにそろえて録り続けます（元の画質より大きくすると、ぼやけます）</span>
                  </span>
                </label>
                <select id="fixedResolutionSelect" class="npr-select" aria-label="そろえる大きさ" ${s.RESOLUTION_MODE === 'fixed' ? '' : 'disabled'}>
                  ${FIXED_RESOLUTION_OPTIONS.map(option => `<option value="${option.height}" ${option.height === s.FIXED_RESOLUTION_HEIGHT ? 'selected' : ''}>${option.label}</option>`).join('')}
                </select>
              </fieldset>
            </section>

            <section class="npr-section" aria-labelledby="nprStorageTitle">
              <h3 id="nprStorageTitle">保存</h3>
              <div class="npr-range-head">
                <label for="storageRange">保存する容量の上限</label>
                <span class="npr-value"><span id="storageGB">${toGB(s.MAX_STORAGE_SIZE)}</span> GB</span>
              </div>
              <input id="storageRange" class="npr-range" type="range" min="${1 * GB}" max="${MAX_STORAGE_SIZE_LIMIT}" step="${1 * GB}" value="${s.MAX_STORAGE_SIZE}" />
              <p class="npr-option-desc">上限を超えたら、古い録画から順に削除します${recommended}</p>
              <div class="npr-usage">
                <div class="usage-info"></div>
                <div class="npr-usage-track"><div class="usage-bar"></div></div>
                <p class="npr-option-desc usage-error" ${this.usageError ? '' : 'hidden'}>使用量を読み込めませんでした</p>
              </div>
              <div class="npr-clear">
                <button type="button" class="npr-danger-button" id="clearButton">すべての録画を削除</button>
                <p class="message-display" role="status"></p>
              </div>
            </section>
          </div>
        </div>
      </dialog>
    `
  }

  private attachEventListeners() {
    if (!this.modal) return
    const modal = this.modal

    // 閉じる: 閉じるボタン・Esc キー・ダイアログの外（暗くした所）のクリック
    modal.querySelector('.npr-settings-close')?.addEventListener('click', () => this.close())
    // キー操作は設定画面の中だけで扱い、ページには伝えない
    // （ニコ生のプレイヤーの操作キーに届くと、スペースで生放送が一時停止したり、↑↓で音量が変わったりする）
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      modal.addEventListener(type, (e) => {
        e.stopPropagation()
        if (type === 'keydown' && e.key === 'Escape') {
          e.preventDefault()
          this.close()
        }
      })
    }
    // Esc でブラウザがダイアログを閉じる時も、片付けをする
    modal.addEventListener('cancel', (e) => {
      e.preventDefault()
      this.close()
    })
    // 歯車をダブルクリックした時の2回目は、開いたダイアログに当たるので無視する
    // （暗くした所に当たってすぐ閉じたり、その場所の設定を変えたりしないように）
    const openedAt = performance.now()
    for (const type of ['mousedown', 'click'] as const) {
      modal.addEventListener(type, (e) => {
        if (e.detail > 1 && performance.now() - openedAt < OPEN_CLICK_GUARD_MS) {
          e.preventDefault()
          e.stopPropagation()
        }
      }, { capture: true })
    }
    // 暗くした所で押して、暗くした所で離した時だけ閉じる
    // （中で押して外で離した時・外で押して中で離した時は、クリックがダイアログ自身に届くが閉じない）
    let pressedOnBackdrop = false
    let releasedOnBackdrop = false
    modal.addEventListener('pointerdown', (e) => {
      pressedOnBackdrop = e.target === modal
    })
    modal.addEventListener('pointerup', (e) => {
      releasedOnBackdrop = e.target === modal
    })
    modal.addEventListener('click', (e) => {
      if (e.target === modal && pressedOnBackdrop && releasedOnBackdrop) this.close()
      pressedOnBackdrop = false
      releasedOnBackdrop = false
    })

    for (const [key, id] of Object.entries(CHECKBOXES) as [keyof Settings, string][]) {
      if (key === 'RECORD_VIDEO' || key === 'RECORD_WITH_COMMENTS') continue
      modal.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', (e) => {
        this.updateSetting(key, (e.target as HTMLInputElement).checked)
      })
    }

    // 録画する種類（コメントなし・コメントありは、少なくとも1つ）
    const videoCheckbox = modal.querySelector<HTMLInputElement>('#recordVideoCheckbox')!
    const commentsCheckbox = modal.querySelector<HTMLInputElement>('#recordCommentsCheckbox')!
    for (const [checkbox, key] of [[videoCheckbox, 'RECORD_VIDEO'], [commentsCheckbox, 'RECORD_WITH_COMMENTS']] as const) {
      checkbox.addEventListener('change', () => {
        if (!videoCheckbox.checked && !commentsCheckbox.checked) {
          checkbox.checked = true
          this.showKindsMessage('コメントなし・コメントありの、少なくとも1つは録画します')
          return
        }
        this.updateSetting(key, checkbox.checked)
      })
    }

    // 解像度が変わった時の録り方。録画中に変えた場合は、録り直して反映する（App.ts で設定の変更を監視している）
    const fixedResolutionSelect = modal.querySelector('#fixedResolutionSelect') as HTMLSelectElement
    for (const radio of modal.querySelectorAll<HTMLInputElement>('input[name="resolutionMode"]')) {
      radio.addEventListener('change', () => {
        if (!radio.checked) return
        fixedResolutionSelect.disabled = radio.value !== 'fixed'
        this.updateSetting('RESOLUTION_MODE', radio.value as ResolutionMode)
      })
    }
    fixedResolutionSelect?.addEventListener('change', () => {
      this.updateSetting('FIXED_RESOLUTION_HEIGHT', Number(fixedResolutionSelect.value))
    })

    // 容量の上限。動かしている間は表示だけ更新し、保存は手を離した時に行う
    const storageRange = modal.querySelector('#storageRange') as HTMLInputElement
    storageRange?.addEventListener('input', () => this.updateStorageLabel(Number(storageRange.value)))
    storageRange?.addEventListener('change', () => {
      this.flushWheelSave()
      this.saveStorageLimit(Number(storageRange.value))
    })
    // つまんで動かし始める前に、ホイールで動かした値を保存しておく（動かしている途中の値で保存しないように）
    storageRange?.addEventListener('pointerdown', () => this.flushWheelSave())
    // ホイールでも動かせる。ただし、スライダーを選んでいる（フォーカスがある）時の縦のホイールだけ
    // （設定画面をスクロールしている途中にスライダーの上を通っても、上限を変えない。上限を下げると古い録画が消えるため）
    let wheelPixels = 0
    storageRange?.addEventListener('wheel', (e) => {
      if (document.activeElement !== storageRange || e.ctrlKey) return // Ctrl+ホイールは拡大・縮小
      if (e.deltaY === 0 || Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
      e.preventDefault()
      wheelPixels += e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : Math.sign(e.deltaY) * WHEEL_STEP_PIXELS
      const steps = Math.trunc(wheelPixels / WHEEL_STEP_PIXELS)
      if (steps === 0) return
      wheelPixels -= steps * WHEEL_STEP_PIXELS
      const next = Math.min(Math.max(Number(storageRange.value) - steps * GB, GB), MAX_STORAGE_SIZE_LIMIT)
      storageRange.value = String(next)
      this.updateStorageLabel(next)
      // 動かし終えてから保存する
      if (this.pendingWheelSave) clearTimeout(this.pendingWheelSave.timer)
      this.pendingWheelSave = { timer: setTimeout(() => this.flushWheelSave(), WHEEL_SAVE_DELAY_MS), save: () => this.saveStorageLimit(Number(storageRange.value)) }
    }, { passive: false })

    // すべての録画を削除
    modal.querySelector('#clearButton')?.addEventListener('click', async () => {
      if (!confirm('すべての録画を削除しますか？\n（元に戻せません）')) return
      try {
        const kept = await this.clearStorage()
        // 録画中の録画は、それまでの分を削除して続きを録画する
        this.showMessage(kept > 0 ? 'すべての録画を削除しました（録画中の録画は、この後の分を続けて録画します）' : 'すべての録画を削除しました', 'success')
        await this.getStorageUsageData()
      } catch (error) {
        console.error('録画を削除できませんでした:', error)
        this.showMessage('削除できませんでした', 'error')
      }
    })
  }

  // ホイールで動かした値の保存を待っていれば、すぐ保存する
  private flushWheelSave() {
    const pending = this.pendingWheelSave
    if (!pending) return
    this.pendingWheelSave = null
    clearTimeout(pending.timer)
    pending.save()
  }

  // 容量の上限を保存する。今の使用量より下げると、超えた分の古い録画がすぐに消えるので、確かめてから保存する
  // （スライダー・キー・ホイールのどれで動かしても。やめたら、スライダーを元の値に戻す）
  private saveStorageLimit(next: number) {
    const previous = this.settings.MAX_STORAGE_SIZE
    if (next === previous) return
    const usage = this.currentStorageUsage
    // 使用量が分からない間（読み込み中・読み込めなかった）は、量を書かずに確かめる
    const message = usage === null
      ? `上限を ${toGB(next)} GB に下げると、超えた分の古い録画が削除されることがあります。
よろしいですか？`
      : `上限を ${toGB(next)} GB にすると、超えた分の古い録画（約 ${formatUsage(usage - next)}）が削除されます。
よろしいですか？`
    if (next < previous && (usage === null || next < usage) && !confirm(message)) {
      const storageRange = this.modal?.querySelector<HTMLInputElement>('#storageRange')
      if (storageRange) storageRange.value = String(previous)
      this.updateStorageLabel(previous)
      return
    }
    void this.updateSetting('MAX_STORAGE_SIZE', next)
  }

  private updateStorageLabel(value: number) {
    const gb = String(toGB(value))
    const storageGB = this.modal?.querySelector('#storageGB')
    if (storageGB) storageGB.textContent = gb
    const usageStorageGB = this.modal?.querySelector('#usageStorageGB')
    if (usageStorageGB) usageStorageGB.textContent = gb
    this.updateUsageBar(value)
  }

  // すべての録画データを削除（拡張機能側へ移す前の、以前のバージョンの録画も）。残した録画中の区間の数を返す
  private async clearStorage() {
    const kept = await clearAll()
    if (await hasLegacyDatabase()) await deleteLegacyDatabase()
    // 以前の録画も消したので、録画一覧の取り込みのお知らせも消す
    await LEGACY_RECORDINGS.setValue(null).catch(() => {})
    return kept ?? 0
  }

  // 使用量の表示（スライダーを動かしている間は、まだ保存していないスライダーの値で表示する）
  private updateUsageDisplay() {
    if (!this.modal) return
    const usageError = this.modal.querySelector<HTMLElement>('.usage-error')
    if (usageError) usageError.hidden = !this.usageError
    const storageRange = this.modal.querySelector<HTMLInputElement>('#storageRange')
    const limit = storageRange ? Number(storageRange.value) : this.settings.MAX_STORAGE_SIZE
    const usageInfo = this.modal.querySelector('.usage-info')
    if (usageInfo) {
      // スライダーを動かした時に updateStorageLabel が書き換えられるよう、id 付きの要素を残す
      usageInfo.innerHTML = `使用量 ${this.currentStorageUsage !== null ? formatUsage(this.currentStorageUsage) : '---'} / 上限 <span id="usageStorageGB">${toGB(limit)}</span> GB`
    }
    this.updateUsageBar(limit)
  }

  private updateUsageBar(limit: number) {
    const usageBar = this.modal?.querySelector<HTMLElement>('.usage-bar')
    if (!usageBar) return
    const usage = this.currentStorageUsage ?? 0
    usageBar.style.width = `${Math.min((usage / limit) * 100, 100)}%`
    usageBar.classList.toggle('is-high', this.currentStorageUsage !== null && usage > limit * 0.8)
  }

  private startUsageUpdateInterval() {
    this.stopUsageUpdateInterval()
    // 開いている間は、5秒ごとに使用量を更新する
    this.usageUpdateInterval = setInterval(async () => {
      if (this.isVisible && this.modal) await this.getStorageUsageData()
      else this.stopUsageUpdateInterval()
    }, 5000)
  }

  private stopUsageUpdateInterval() {
    if (this.usageUpdateInterval) {
      clearInterval(this.usageUpdateInterval)
      this.usageUpdateInterval = null
    }
  }

  // 開く（開いていれば閉じる）
  // event: 歯車のクリック。開いている時に暗くした所の歯車をダブルクリックすると、1回目で閉じて2回目で
  // また開いてしまうので、閉じた直後のダブルクリックの2回目では開かない
  public show(event?: MouseEvent) {
    if (this.isVisible) {
      this.close()
      return
    }
    if (event && event.detail > 1 && performance.now() - this.closedAt < OPEN_CLICK_GUARD_MS) return
    document.body.insertAdjacentHTML('beforeend', this.createModalHTML())
    this.modal = document.getElementById('settingsModal') as HTMLDialogElement | null
    if (!this.modal) return
    this.isVisible = true
    document.getElementById('settingsButton')?.setAttribute('aria-expanded', 'true')

    this.attachEventListeners()
    // 画面の中央に、ページの他の部分（全画面のプレイヤーも）より手前に開く
    if (typeof this.modal.showModal === 'function') this.modal.showModal()
    else this.modal.setAttribute('open', '')
    // 最初のボタン（閉じる）ではなく、ダイアログにフォーカスを置く（読み上げでは「設定」から始まる）
    this.modal.focus({ preventScroll: true })
    this.updateUsageDisplay()
    this.getStorageUsageData()
    this.startUsageUpdateInterval()
  }

  public close() {
    this.flushWheelSave() // 閉じた後に、古い値で保存しないように
    this.stopUsageUpdateInterval()
    if (this.isVisible) this.closedAt = performance.now()
    const modal = this.modal
    this.modal = null
    this.isVisible = false
    if (modal) {
      if (modal.open && typeof modal.close === 'function') modal.close()
      modal.remove()
    }
    const settingsButton = document.getElementById('settingsButton')
    settingsButton?.setAttribute('aria-expanded', 'false')
  }
}

export default SettingsModal
