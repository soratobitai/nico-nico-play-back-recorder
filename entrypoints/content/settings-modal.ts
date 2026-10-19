// 録画バーの設定（バーの上に開く）
// 録る種類（動画のみ・コメント付き）は、録画バーのチップで切り替える
import {
  MAX_STORAGE_SIZE,
  AUTO_START,
  AUTO_RELOAD_ON_FAILURE,
  RESOLUTION_MODE,
  FIXED_RESOLUTION_HEIGHT,
  type ResolutionMode,
} from '../../utils/storage'
import { getUsage, clearAll, estimateStorage } from '../../utils/library/api'
import { hasLegacyDatabase, deleteLegacyDatabase } from '../../hooks/indexedDB/recordingDB'

const GB = 1024 * 1024 * 1024
// 容量の上限の範囲
const MAX_STORAGE_SIZE_LIMIT = 100 * GB
const STORAGE_QUOTA_ESTIMATE = 30 * GB
// 録画バー（設定はこの中に開く）
const BAR_ID = 'playbackRecorderBar'

interface Settings {
  MAX_STORAGE_SIZE: number
  AUTO_START: boolean
  AUTO_RELOAD_ON_FAILURE: boolean
  RESOLUTION_MODE: ResolutionMode
  FIXED_RESOLUTION_HEIGHT: number
}

// 一定の解像度で録る時に選べる高さ
const FIXED_RESOLUTION_OPTIONS = [
  { height: 720, label: '720p（1280×720）' },
  { height: 1080, label: '1080p（1920×1080）' },
]

const CLOSE_ICON = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>'

const toGB = (bytes: number) => Math.round(bytes / GB)
const formatUsage = (bytes: number) => bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / (1024 * 1024))} MB`

class SettingsModal {
  private modal: HTMLElement | null = null
  private isVisible: boolean = false
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private settings: Settings = {
    MAX_STORAGE_SIZE: 1 * GB,
    AUTO_START: true,
    AUTO_RELOAD_ON_FAILURE: false,
    RESOLUTION_MODE: 'split',
    FIXED_RESOLUTION_HEIGHT: 720,
  }
  private currentStorageUsage: number | null = null
  private usageError = false // 使用量を読み込めなかった
  private storageQuota: number = 0
  private messageTimer: ReturnType<typeof setTimeout> | null = null
  private usageUpdateInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.loadSettings()
    this.watchSettings()
    // 使用量は全録画を読んで数えるので、ここでは取らずに設定画面を開いた時に取る
    this.loadStorageQuota()
  }

  private async loadSettings() {
    const [size, autoStart, autoReload, resolutionMode, fixedResolutionHeight] = await Promise.all([
      MAX_STORAGE_SIZE.getValue(),
      AUTO_START.getValue(),
      AUTO_RELOAD_ON_FAILURE.getValue(),
      RESOLUTION_MODE.getValue(),
      FIXED_RESOLUTION_HEIGHT.getValue(),
    ])
    this.applySetting('MAX_STORAGE_SIZE', size)
    this.applySetting('AUTO_START', autoStart)
    this.applySetting('AUTO_RELOAD_ON_FAILURE', autoReload)
    this.applySetting('RESOLUTION_MODE', resolutionMode)
    this.applySetting('FIXED_RESOLUTION_HEIGHT', fixedResolutionHeight)
  }

  // 他のタブなどで設定が変わったら合わせる（古い値のまま容量の上限を書き戻すと、録画が大量に消えてしまう）
  private watchSettings() {
    MAX_STORAGE_SIZE.watch(value => this.applySetting('MAX_STORAGE_SIZE', value))
    AUTO_START.watch(value => this.applySetting('AUTO_START', value))
    AUTO_RELOAD_ON_FAILURE.watch(value => this.applySetting('AUTO_RELOAD_ON_FAILURE', value))
    RESOLUTION_MODE.watch(value => this.applySetting('RESOLUTION_MODE', value))
    FIXED_RESOLUTION_HEIGHT.watch(value => this.applySetting('FIXED_RESOLUTION_HEIGHT', value))
  }

  // 保存されている設定の値を、覚えている値と（開いていれば）設定画面に反映する
  private applySetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    this.settings[key] = value
    const modal = this.modal
    if (!modal) return
    const input = (id: string) => modal.querySelector<HTMLInputElement>(`#${id}`)
    switch (key) {
      case 'MAX_STORAGE_SIZE': {
        const range = input('storageRange')
        if (range) range.value = String(value)
        this.updateStorageLabel(value as number)
        break
      }
      case 'AUTO_START': {
        const checkbox = input('autostartCheckbox')
        if (checkbox) checkbox.checked = value as boolean
        break
      }
      case 'AUTO_RELOAD_ON_FAILURE': {
        const checkbox = input('autoReloadCheckbox')
        if (checkbox) checkbox.checked = value as boolean
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

  private createModalHTML(): string {
    const s = this.settings
    const recommended = this.storageQuota > 0 ? `（おすすめ: ${toGB(Math.min(this.storageQuota, STORAGE_QUOTA_ESTIMATE))} GB 以下）` : ''
    return `
      <section class="npr-settings" id="settingsModal" role="dialog" aria-label="設定">
        <header class="npr-settings-head">
          <h2>設定</h2>
          <button type="button" class="npr-settings-close" aria-label="設定を閉じる">${CLOSE_ICON}</button>
        </header>

        <div class="npr-settings-body">
          <section class="npr-section">
            <h3>録画</h3>
            <label class="npr-switch" for="autostartCheckbox">
              <input id="autostartCheckbox" type="checkbox" role="switch" ${s.AUTO_START ? 'checked' : ''} />
              <span class="npr-option-text">
                <span class="npr-option-title">オートスタート</span>
                <span class="npr-option-desc">番組を開いたら録画を始めます</span>
              </span>
            </label>
            <label class="npr-switch" for="autoReloadCheckbox">
              <input id="autoReloadCheckbox" type="checkbox" role="switch" ${s.AUTO_RELOAD_ON_FAILURE ? 'checked' : ''} />
              <span class="npr-option-text">
                <span class="npr-option-title">オートリロード</span>
                <span class="npr-option-desc">映像が止まったら読み込み直します</span>
              </span>
            </label>
          </section>

          <fieldset class="npr-section">
            <legend><h3>動画の解像度が変わった時</h3></legend>
            <label class="npr-radio" for="resolutionSplitRadio">
              <input id="resolutionSplitRadio" type="radio" name="resolutionMode" value="split" ${s.RESOLUTION_MODE === 'split' ? 'checked' : ''} />
              <span class="npr-option-text">
                <span class="npr-option-title">録画を分ける</span>
                <span class="npr-option-desc">元の解像度のまま録ります</span>
              </span>
            </label>
            <label class="npr-radio" for="resolutionFixedRadio">
              <input id="resolutionFixedRadio" type="radio" name="resolutionMode" value="fixed" ${s.RESOLUTION_MODE === 'fixed' ? 'checked' : ''} />
              <span class="npr-option-text">
                <span class="npr-option-title">一定の解像度で録る</span>
                <span class="npr-option-desc">画質が変わっても1本の録画のまま（拡大・縮小します）</span>
              </span>
            </label>
            <select id="fixedResolutionSelect" class="npr-select" aria-label="一定の解像度で録る時の解像度" ${s.RESOLUTION_MODE === 'fixed' ? '' : 'disabled'}>
              ${FIXED_RESOLUTION_OPTIONS.map(option => `<option value="${option.height}" ${option.height === s.FIXED_RESOLUTION_HEIGHT ? 'selected' : ''}>${option.label}</option>`).join('')}
            </select>
          </fieldset>

          <section class="npr-section">
            <h3 class="npr-range-head">
              <label for="storageRange">保存する容量の上限</label>
              <span class="npr-value"><span id="storageGB">${toGB(s.MAX_STORAGE_SIZE)}</span> GB</span>
            </h3>
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
      </section>
    `
  }

  private attachEventListeners() {
    if (!this.modal) return
    const modal = this.modal

    // 設定画面の外をクリックした時・Esc キーで閉じる（設定ボタン自体のクリックは、ボタンの方で開け閉めする）
    this.clickOutsideHandler = (e: MouseEvent) => {
      if (!this.isVisible || modal.contains(e.target as Node)) return
      if ((e.target as HTMLElement).closest?.('#settingsButton')) return
      this.close()
    }
    setTimeout(() => {
      if (this.clickOutsideHandler) document.addEventListener('click', this.clickOutsideHandler)
    }, 200)
    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.isVisible) this.close()
    }
    document.addEventListener('keydown', this.keyHandler)
    modal.querySelector('.npr-settings-close')?.addEventListener('click', () => this.close())

    modal.querySelector<HTMLInputElement>('#autostartCheckbox')?.addEventListener('change', (e) => {
      this.updateSetting('AUTO_START', (e.target as HTMLInputElement).checked)
    })
    modal.querySelector<HTMLInputElement>('#autoReloadCheckbox')?.addEventListener('change', (e) => {
      this.updateSetting('AUTO_RELOAD_ON_FAILURE', (e.target as HTMLInputElement).checked)
    })

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
    storageRange?.addEventListener('change', () => this.updateSetting('MAX_STORAGE_SIZE', Number(storageRange.value)))
    storageRange?.addEventListener('wheel', (e) => {
      e.preventDefault()
      const next = this.settings.MAX_STORAGE_SIZE + (e.deltaY < 0 ? GB : -GB)
      if (next < GB || next > MAX_STORAGE_SIZE_LIMIT) return
      storageRange.value = String(next)
      this.updateStorageLabel(next)
      this.updateSetting('MAX_STORAGE_SIZE', next)
    })

    // すべての録画を削除
    modal.querySelector('#clearButton')?.addEventListener('click', async () => {
      if (!confirm('すべての録画を削除しますか？\n（元に戻せません）')) return
      try {
        await this.clearStorage()
        this.showMessage('すべての録画を削除しました', 'success')
        await this.getStorageUsageData()
      } catch (error) {
        console.error('録画を削除できませんでした:', error)
        this.showMessage('削除できませんでした', 'error')
      }
    })
  }

  private updateStorageLabel(value: number) {
    const gb = String(toGB(value))
    const storageGB = this.modal?.querySelector('#storageGB')
    if (storageGB) storageGB.textContent = gb
    const usageStorageGB = this.modal?.querySelector('#usageStorageGB')
    if (usageStorageGB) usageStorageGB.textContent = gb
    this.updateUsageBar(value)
  }

  private async clearStorage() {
    // すべての録画データを削除（拡張機能側へ移す前の、以前のバージョンの録画も）
    await clearAll()
    if (await hasLegacyDatabase()) await deleteLegacyDatabase()
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
  public show() {
    if (this.isVisible) {
      this.close()
      return
    }
    const bar = document.getElementById(BAR_ID)
    if (!bar) return
    bar.insertAdjacentHTML('beforeend', this.createModalHTML())
    this.modal = document.getElementById('settingsModal')
    if (!this.modal) return
    this.isVisible = true
    document.getElementById('settingsButton')?.setAttribute('aria-expanded', 'true')

    this.attachEventListeners()
    this.updateUsageDisplay()
    this.getStorageUsageData()
    this.startUsageUpdateInterval()
  }

  public close() {
    this.stopUsageUpdateInterval()
    this.modal?.remove()
    this.modal = null
    this.isVisible = false
    document.getElementById('settingsButton')?.setAttribute('aria-expanded', 'false')
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler)
      this.clickOutsideHandler = null
    }
    if (this.keyHandler) {
      document.removeEventListener('keydown', this.keyHandler)
      this.keyHandler = null
    }
  }
}

export default SettingsModal
