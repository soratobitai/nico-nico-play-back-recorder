import {
  RESTART_MEDIARECORDER_INTERVAL_MS,
  MAX_STORAGE_SIZE,
  AUTO_START,
  AUTO_RELOAD_ON_FAILURE,
  RECORD_WITH_COMMENTS,
} from '../../utils/storage'
import { getUsage, clearAll, estimateStorage } from '../../utils/library/api'
import { hasLegacyDatabase, deleteLegacyDatabase } from '../../hooks/indexedDB/recordingDB'

// ストレージ設定の定数
const MAX_STORAGE_SIZE_LIMIT = 100 * 1024 * 1024 * 1024 // 100GB
const STORAGE_QUOTA_ESTIMATE = 30 * 1024 * 1024 * 1024 // 30GB

interface Settings {
  RESTART_MEDIARECORDER_INTERVAL_MS: number
  MAX_STORAGE_SIZE: number
  AUTO_START: boolean
  AUTO_RELOAD_ON_FAILURE: boolean
  RECORD_WITH_COMMENTS: boolean
}

class SettingsModal {
  private modal: HTMLDivElement | null = null
  private isVisible: boolean = false
  private clickOutsideHandler: ((e: MouseEvent) => void) | null = null
  private settings: Settings = {
    RESTART_MEDIARECORDER_INTERVAL_MS: 1 * 60 * 1000,
    MAX_STORAGE_SIZE: 1 * 1024 * 1024 * 1024,
    AUTO_START: true,
    AUTO_RELOAD_ON_FAILURE: false,
    RECORD_WITH_COMMENTS: false,
  }
  private currentStorageUsage: number | null = null
  private storageQuota: number = 0
  private clearMessage: { text: string; type: 'success' | 'error' } | null = null
  private usageUpdateInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.loadSettings()
    // 使用量は全録画を読んで数えるので、ここでは取らずに設定画面を開いた時に取る
    this.loadStorageQuota()
  }

  private async loadSettings() {
    const [
      interval,
      size,
      autoStart,
      autoReload,
      recordWithComments,
    ] = await Promise.all([
      RESTART_MEDIARECORDER_INTERVAL_MS.getValue(),
      MAX_STORAGE_SIZE.getValue(),
      AUTO_START.getValue(),
      AUTO_RELOAD_ON_FAILURE.getValue(),
      RECORD_WITH_COMMENTS.getValue(),
    ])

    this.settings = {
      RESTART_MEDIARECORDER_INTERVAL_MS: interval,
      MAX_STORAGE_SIZE: size,
      AUTO_START: autoStart,
      AUTO_RELOAD_ON_FAILURE: autoReload,
      RECORD_WITH_COMMENTS: recordWithComments,
    }
  }

  private async getStorageUsageData() {
    try {
      const usage = await getUsage()
      this.currentStorageUsage = usage.bytes
    } catch (error) {
      console.error('ストレージ使用量の取得に失敗しました:', error)
      this.currentStorageUsage = null
    }

    // 使用量表示を更新
    this.updateUsageDisplay()
  }

  // 保存先（拡張機能側）の上限を取得（推奨値の表示に使う）
  private async loadStorageQuota() {
    try {
      const estimate = await estimateStorage()
      if (estimate.quota) {
        const safeQuota = Math.floor(estimate.quota * 0.8)
        this.storageQuota = safeQuota
      }
    } catch (error) {
      console.warn('ストレージ上限の取得に失敗:', error)
    }
  }

  private async updateSetting<K extends keyof Settings>(
    key: K,
    value: Settings[K]
  ) {
    this.settings[key] = value

    switch (key) {
      case 'RESTART_MEDIARECORDER_INTERVAL_MS':
        await RESTART_MEDIARECORDER_INTERVAL_MS.setValue(value as number)
        break
      case 'MAX_STORAGE_SIZE':
        await MAX_STORAGE_SIZE.setValue(value as number)
        break
      case 'AUTO_START':
        await AUTO_START.setValue(value as boolean)
        break
      case 'AUTO_RELOAD_ON_FAILURE':
        await AUTO_RELOAD_ON_FAILURE.setValue(value as boolean)
        break
      case 'RECORD_WITH_COMMENTS':
        await RECORD_WITH_COMMENTS.setValue(value as boolean)
        break
    }
  }

  private showMessage(text: string, type: 'success' | 'error') {
    this.clearMessage = { text, type }
    setTimeout(() => {
      this.clearMessage = null
      this.updateMessageDisplay()
    }, 3000)
    this.updateMessageDisplay()
  }

  private updateMessageDisplay() {
    const messageElement = this.modal?.querySelector('.message-display')
    if (messageElement) {
      if (this.clearMessage) {
        messageElement.innerHTML = `
          <div style="
            margin-top: 8px;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 0.8em;
            background-color: ${this.clearMessage.type === 'success' ? '#1a3a1a' : '#3a1a1a'};
            color: ${this.clearMessage.type === 'success' ? '#4ade80' : '#f87171'};
            border: 1px solid ${this.clearMessage.type === 'success' ? '#2d5a2d' : '#5a2d2d'};
            text-align: center
          ">
            ${this.clearMessage.text}
          </div>
        `
      } else {
        messageElement.innerHTML = ''
      }
    }
  }

  private createModalHTML(): string {
    return `
      <div class="settings-modal" id="settingsModal">

          <div class="checkbox-settings-container">
            <div class="setting-block checkbox-setting">
              <label for="autostartCheckbox" title="ページを開いたら自動的に録画を開始します。">
                <input
                  id="autostartCheckbox"
                  type="checkbox"
                  ${this.settings.AUTO_START ? 'checked' : ''}
                />
                オートスタート
              </label>
            </div>

            <div class="setting-block checkbox-setting">
              <label for="autoReloadCheckbox" title="映像が止まった時に自動的に映像をリロードします。">
                <input
                  id="autoReloadCheckbox"
                  type="checkbox"
                  ${this.settings.AUTO_RELOAD_ON_FAILURE ? 'checked' : ''}
                />
                オートリロード
              </label>
            </div>
          </div>

          <div class="setting-block">
            <label for="recordWithCommentsCheckbox" title="流れるコメントを動画に重ねて録画します。">
              <input
                id="recordWithCommentsCheckbox"
                type="checkbox"
                ${this.settings.RECORD_WITH_COMMENTS ? 'checked' : ''}
              />
              コメントを含めて録画
            </label>
            <p class="description">
              流れるコメントを動画に重ねて録画します。コメントが重なるのはタブを表示している間だけです。PCの負荷が上がります。
            </p>
          </div>

          <div class="setting-block">
            <label for="intervalRange">
              分割間隔: <span id="intervalMinutes">${Math.round(this.settings.RESTART_MEDIARECORDER_INTERVAL_MS / 60000)}</span> 分
              <span style="font-size: 0.8em; color: #888; margin-left: 8px;">自動的に録画を分割保存します。</span>
            </label>
            <input
              id="intervalRange"
              type="range"
              min="${1 * 60 * 1000}"
              max="${60 * 60 * 1000}"
              step="${1 * 60 * 1000}"
              value="${this.settings.RESTART_MEDIARECORDER_INTERVAL_MS}"
            />
          </div>

          <div class="setting-block">
            <label for="storageRange">
              ストレージ上限: <span id="storageGB">${Math.round(this.settings.MAX_STORAGE_SIZE / (1024 * 1024 * 1024))}</span> GB
              ${this.storageQuota > 0 ? `
              <span storage-quota-info style="font-size: 0.8em; color: #888; margin-left: 8px;">推奨値: ${Math.round(Math.min(this.storageQuota, STORAGE_QUOTA_ESTIMATE) / (1024 * 1024 * 1024))} GB以下</span>
            ` : ''}
              
            </label>
            <input
              id="storageRange"
              type="range"
              min="${1 * 1024 * 1024 * 1024}"
              max="${MAX_STORAGE_SIZE_LIMIT}"
              step="${1 * 1024 * 1024 * 1024}"
              value="${this.settings.MAX_STORAGE_SIZE}"
            />
            <p class="description">
              設定値を超えたら古いものから順に削除します。
            </p>
          </div>

          <div class="current-usage">
            <div class="usage-info">
              <span>
                現在の使用量: ${
                  this.currentStorageUsage !== null
                    ? `${Math.round(
                        (this.currentStorageUsage / (1024 * 1024 * 1024)) * 100
                      ) / 100} GB`
                    : '---'
                }
              </span>
              <span>
                設定上限: <span id="usageStorageGB">${Math.round(this.settings.MAX_STORAGE_SIZE / (1024 * 1024 * 1024))}</span> GB
              </span>
            </div>
            <div class="usage-bar-container">
              <div
                class="usage-bar"
                style="
                  width: ${
                    this.currentStorageUsage !== null
                      ? Math.min(
                          (this.currentStorageUsage / this.settings.MAX_STORAGE_SIZE) * 100,
                          100
                        )
                      : 0
                  }%;
                  background-color: ${
                    this.currentStorageUsage !== null &&
                    this.currentStorageUsage > this.settings.MAX_STORAGE_SIZE * 0.8
                      ? '#ff6b6b'
                      : '#4CAF50'
                  };
                "
              ></div>
            </div>
            ${this.currentStorageUsage === null ? `
              <p class="description" style="text-align: center; margin-top: 8px;">
                ライブ視聴ページでのみ動作します
              </p>
            ` : ''}
            <div class="clear-button-container">
              <button class="clear-button" id="clearButton">
                クリア
              </button>
              <span class="clear-button-description">
                ストレージをクリアします。録画データはすべて削除されます。
              </span>
            </div>
            <div class="message-display"></div>
          </div>
        </div>
    `
  }

  private attachEventListeners() {
    if (!this.modal) return

    // 設定画面以外をクリックしたときに閉じる（重複登録を防ぐ）
    if (!this.clickOutsideHandler) {
      this.clickOutsideHandler = (e: MouseEvent) => {
        // 設定画面が表示されている状態で、設定画面の外側をクリックした場合のみ閉じる
        if (this.isVisible && this.modal && !this.modal.contains(e.target as Node)) {
          // 設定ボタン自体のクリックは無視する
          const target = e.target as HTMLElement
          if (target.closest('.settings-button') || target.closest('#settingsButton')) {
            return
          }
          
          this.close()
        }
      }
      // イベントリスナーを少し遅延して追加
      setTimeout(() => {
        document.addEventListener('click', this.clickOutsideHandler!)
      }, 200)
    }

    // チェックボックス
    const autostartCheckbox = this.modal.querySelector('#autostartCheckbox') as HTMLInputElement
    const autoReloadCheckbox = this.modal.querySelector('#autoReloadCheckbox') as HTMLInputElement

    autostartCheckbox?.addEventListener('change', (e) => {
      this.updateSetting('AUTO_START', (e.target as HTMLInputElement).checked)
    })

    autoReloadCheckbox?.addEventListener('change', (e) => {
      this.updateSetting('AUTO_RELOAD_ON_FAILURE', (e.target as HTMLInputElement).checked)
    })

    // 録画中に切り替えた場合は、その場で区間を切り替えて反映される（App.ts で設定の変更を監視している）
    const recordWithCommentsCheckbox = this.modal.querySelector('#recordWithCommentsCheckbox') as HTMLInputElement
    recordWithCommentsCheckbox?.addEventListener('change', (e) => {
      this.updateSetting('RECORD_WITH_COMMENTS', (e.target as HTMLInputElement).checked)
    })

    // スライダー
    const intervalRange = this.modal.querySelector('#intervalRange') as HTMLInputElement
    const storageRange = this.modal.querySelector('#storageRange') as HTMLInputElement

    // 動かしている間は表示だけ更新し、保存は手を離した時に行う
    // （保存のたびに全タブで分割タイマーがリセットされるため）
    intervalRange?.addEventListener('input', (e) => {
      this.updateIntervalLabel(Number((e.target as HTMLInputElement).value))
    })
    intervalRange?.addEventListener('change', (e) => {
      this.updateSetting('RESTART_MEDIARECORDER_INTERVAL_MS', Number((e.target as HTMLInputElement).value))
    })

    storageRange?.addEventListener('input', (e) => {
      this.updateStorageLabel(Number((e.target as HTMLInputElement).value))
    })
    storageRange?.addEventListener('change', (e) => {
      this.updateSetting('MAX_STORAGE_SIZE', Number((e.target as HTMLInputElement).value))
    })

    // クリアボタン
    const clearButton = this.modal.querySelector('#clearButton') as HTMLButtonElement
    clearButton?.addEventListener('click', async () => {
      try {
        // クリア処理を実行
        await this.clearStorage()
        this.showMessage('ストレージをクリアしました', 'success')
        await this.getStorageUsageData()
        this.updateUsageDisplay()
      } catch (error) {
        this.showMessage('ストレージのクリアに失敗しました', 'error')
      }
    })

    // ホイールイベント
    this.attachWheelHandler(intervalRange, 'RESTART_MEDIARECORDER_INTERVAL_MS', 60 * 1000, 1 * 60 * 1000, 60 * 60 * 1000)
    this.attachWheelHandler(storageRange, 'MAX_STORAGE_SIZE', 1 * 1024 * 1024 * 1024, 1 * 1024 * 1024 * 1024, MAX_STORAGE_SIZE_LIMIT)
  }

  private attachWheelHandler(
    element: HTMLInputElement | null,
    settingKey: keyof Settings,
    step: number,
    min: number,
    max: number
  ) {
    if (!element) return

    element.addEventListener('wheel', (e) => {
      e.preventDefault()
      const currentValue = this.settings[settingKey] as number
      const newValue = currentValue + (e.deltaY < 0 ? step : -step)
      if (newValue >= min && newValue <= max) {
        this.updateSetting(settingKey, newValue)
        element.value = newValue.toString()
        
        if (settingKey === 'RESTART_MEDIARECORDER_INTERVAL_MS') {
          this.updateIntervalLabel(newValue)
        } else if (settingKey === 'MAX_STORAGE_SIZE') {
          this.updateStorageLabel(newValue)
        }
      }
    })
  }

  private updateIntervalLabel(value: number) {
    const minutesElement = this.modal?.querySelector('#intervalMinutes')
    if (minutesElement) {
      const minutes = Math.round(value / 60000)
      minutesElement.textContent = minutes.toString()
    }
  }

  private updateStorageLabel(value: number) {
    const gb = Math.round(value / (1024 * 1024 * 1024))
    
    // ストレージ上限の表示を更新
    const storageGBElement = this.modal?.querySelector('#storageGB')
    if (storageGBElement) {
      storageGBElement.textContent = gb.toString()
    }
    
    // usage-infoの設定上限表示も更新
    const usageStorageGBElement = this.modal?.querySelector('#usageStorageGB')
    if (usageStorageGBElement) {
      usageStorageGBElement.textContent = gb.toString()
    }
    
    // 使用量バーの色も更新
    const usageBar = this.modal?.querySelector('.usage-bar')
    if (usageBar && this.currentStorageUsage !== null) {
      const usagePercentage = Math.min(
        (this.currentStorageUsage / value) * 100,
        100
      )
      const isHighUsage = this.currentStorageUsage > value * 0.8
      
      usageBar.setAttribute('style', `
        width: ${usagePercentage}%;
        background-color: ${isHighUsage ? '#ff6b6b' : '#4CAF50'};
      `)
    }
  }

  private async clearStorage() {
    // すべての録画データを削除（拡張機能側へ移す前の、以前のバージョンの録画も）
    await clearAll()
    if (await hasLegacyDatabase()) await deleteLegacyDatabase()

    // 録画リストを更新（空の状態になる）
    const { loadRecordedMovieList } = await import('../../utils/ui')
    await loadRecordedMovieList()
  }

  private updateUsageDisplay() {
    if (!this.modal) return

    const usageInfo = this.modal.querySelector('.usage-info')
    const usageBar = this.modal.querySelector('.usage-bar')
    // スライダーを動かしている間は、まだ保存していないスライダーの値で表示する
    const storageRange = this.modal.querySelector<HTMLInputElement>('#storageRange')
    const maxStorageSize = storageRange ? Number(storageRange.value) : this.settings.MAX_STORAGE_SIZE

    if (usageInfo) {
      // スライダーを動かした時に updateStorageLabel が書き換えられるよう、id 付きの要素を残す
      usageInfo.innerHTML = `
        <span>
          現在の使用量: ${
            this.currentStorageUsage !== null
              ? `${Math.round(
                  (this.currentStorageUsage / (1024 * 1024 * 1024)) * 100
                ) / 100} GB`
              : '---'
          }
        </span>
        <span>
          設定上限: <span id="usageStorageGB">${Math.round(maxStorageSize / (1024 * 1024 * 1024))}</span> GB
        </span>
      `
    }

    if (usageBar) {
      usageBar.setAttribute('style', `
        width: ${
          this.currentStorageUsage !== null
            ? Math.min(
                (this.currentStorageUsage / maxStorageSize) * 100,
                100
              )
            : 0
        }%;
        background-color: ${
          this.currentStorageUsage !== null &&
          this.currentStorageUsage > maxStorageSize * 0.8
            ? '#ff6b6b'
            : '#4CAF50'
        };
      `)
    }
  }

  private startUsageUpdateInterval() {
    // 既存の定期実行があれば停止
    this.stopUsageUpdateInterval()
    
    // 5秒毎に使用量を更新
    this.usageUpdateInterval = setInterval(async () => {
      if (this.isVisible && this.modal) {
        await this.getStorageUsageData()
      } else {
        // モーダルが閉じられている場合は定期実行を停止
        this.stopUsageUpdateInterval()
      }
    }, 5000)
  }

  private stopUsageUpdateInterval() {
    if (this.usageUpdateInterval) {
      clearInterval(this.usageUpdateInterval)
      this.usageUpdateInterval = null
    }
  }

  public show() {
    // 既に表示されている場合は閉じる
    if (this.isVisible) {
      this.close()
      return
    }

    // recordedMovieAria要素を取得
    const recordedMovieAria = document.getElementById('recordedMovieAria')
    if (!recordedMovieAria) {
      console.error('recordedMovieAria element not found')
      return
    }

    // 新しいモーダルを作成
    const modalHTML = this.createModalHTML()
    recordedMovieAria.insertAdjacentHTML('beforeend', modalHTML)
    
    this.modal = document.getElementById('settingsModal') as HTMLDivElement
    if (!this.modal) {
      console.error('settingsModal element not found after creation')
      return
    }
    
    // 先にisVisibleをtrueに設定してからイベントリスナーを追加
    this.isVisible = true
    
    this.attachEventListeners()
    this.updateMessageDisplay()
    
    // 設定画面を開いた瞬間に使用量を更新
    this.getStorageUsageData()
    
    // 使用量の定期更新を開始（5秒毎）
    this.startUsageUpdateInterval()
  }

  public close() {
    // 定期実行を停止
    this.stopUsageUpdateInterval()
    
    if (this.modal) {
      this.modal.remove()
      this.modal = null
    }
    this.isVisible = false
    
    // イベントリスナーを削除
    if (this.clickOutsideHandler) {
      document.removeEventListener('click', this.clickOutsideHandler)
      this.clickOutsideHandler = null
    }
  }
}

export default SettingsModal 