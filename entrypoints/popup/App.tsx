import { useEffect, useRef, useState } from 'react'
import {
  RESTART_MEDIARECORDER_INTERVAL_MS,
  MAX_STORAGE_SIZE,
  AUTO_START,
} from '../../utils/storage'
import './App.css'

function App() {
  const [settings, setSettings] = useState({
    RESTART_MEDIARECORDER_INTERVAL_MS: 1 * 60 * 1000,
    MAX_STORAGE_SIZE: 1 * 1024 * 1024 * 1024,
    AUTO_START: true,
  })

  const [currentStorageUsage, setCurrentStorageUsage] = useState<number | null>(
    null
  )
  const [storageQuota, setStorageQuota] = useState(0)
  const [maxStorageLimit, setMaxStorageLimit] = useState(100 * 1024 * 1024 * 1024) // デフォルト100GB
  const [clearMessage, setClearMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const intervalRef = useRef<HTMLInputElement>(null)
  const storageRef = useRef<HTMLInputElement>(null)

  // ストレージ使用量を取得する関数
  const getStorageUsageData = async () => {
    try {
      // Content Scriptを経由してIndexedDBから使用量を取得
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      })

      if (!tab.id) {
        console.error('アクティブなタブが見つかりません')
        setCurrentStorageUsage(null)
        return
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_STORAGE_USAGE',
      })

      if (response && response.usage !== undefined) {
        console.log('Popup - Received storage usage:', response.usage, 'bytes')
        setCurrentStorageUsage(response.usage)
      } else if (response && response.error) {
        console.error('Popup - Storage usage error:', response.error)
        setCurrentStorageUsage(null)
      } else {
        console.log('Popup - No storage data available, using null')
        setCurrentStorageUsage(null)
      }

      // content script経由でIndexedDBのストレージ上限を取得
      try {
        const quotaResponse = await chrome.tabs.sendMessage(tab.id, {
          type: 'GET_STORAGE_QUOTA',
        })
        if (quotaResponse && quotaResponse.quota) {
          const safeQuota = Math.floor(quotaResponse.quota * 0.8)
          setStorageQuota(safeQuota)
          setMaxStorageLimit(safeQuota)
        }
      } catch (estimateError) {
        console.warn('content側のstorage quota取得に失敗:', estimateError)
      }
    } catch (error) {
      console.error('ストレージ使用量の取得に失敗しました:', error)
      setCurrentStorageUsage(null)
    }
  }

  // 初期値読み込み
  useEffect(() => {
    const loadSettings = async () => {
      const [
        interval,
        size,
        autoStart,
      ] = await Promise.all([
        RESTART_MEDIARECORDER_INTERVAL_MS.getValue(),
        MAX_STORAGE_SIZE.getValue(),
        AUTO_START.getValue(),
      ])

      setSettings({
        RESTART_MEDIARECORDER_INTERVAL_MS: interval,
        MAX_STORAGE_SIZE: size,
        AUTO_START: autoStart,
      })

      // ストレージ使用量の取得は定期的更新のuseEffectで行うため削除
    }

    loadSettings()
  }, [])

  // ストレージ使用量を定期的に更新
  useEffect(() => {
    const updateStorageUsage = () => {
      getStorageUsageData()
    }

    // 初回取得
    updateStorageUsage()

    // 5秒ごとに更新
    const interval = setInterval(updateStorageUsage, 5000)

    return () => clearInterval(interval)
  }, [])

  // 設定更新関数
  const updateSetting = async <K extends keyof typeof settings>(
    key: K,
    value: typeof settings[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }))

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
    }
  }

  // ホイールイベントによる更新
  const attachWheelHandler = (
    ref: React.RefObject<HTMLInputElement | null>,
    value: number,
    setValue: (v: number) => void,
    step: number,
    min: number,
    max: number
  ) => {
    useEffect(() => {
      const el = ref.current
      if (!el) return

      const onWheel = (e: WheelEvent) => {
        e.preventDefault()
        const newValue = value + (e.deltaY < 0 ? step : -step)
        if (newValue >= min && newValue <= max) {
          setValue(newValue)
        }
      }

      el.addEventListener('wheel', onWheel)
      return () => el.removeEventListener('wheel', onWheel)
    }, [value])
  }

  attachWheelHandler(
    intervalRef,
    settings.RESTART_MEDIARECORDER_INTERVAL_MS,
    (v) => updateSetting('RESTART_MEDIARECORDER_INTERVAL_MS', v),
    60 * 1000,
    1 * 60 * 1000,
    60 * 60 * 1000
  )

  attachWheelHandler(
    storageRef,
    settings.MAX_STORAGE_SIZE,
    (v) => updateSetting('MAX_STORAGE_SIZE', v),
    1 * 1024 * 1024 * 1024,
    1 * 1024 * 1024 * 1024,
    100 * 1024 * 1024 * 1024 // ← 固定100GBに戻す
  )

  // メッセージを表示して一定時間後に消す関数
  const showMessage = (text: string, type: 'success' | 'error') => {
    setClearMessage({ text, type })
    setTimeout(() => {
      setClearMessage(null)
    }, 3000) //3秒後に自動的に消える
  }

  return (
    <div className="popup-container">
      <h2>録画設定</h2>
      
      <p className="description">
        設定内容を確実に反映させるには、ページを更新する必要があります。
      </p>

      <div className="setting-block">
        <label htmlFor="autostartCheckbox">
          <input
            id="autostartCheckbox"
            type="checkbox"
            checked={settings.AUTO_START}
            onChange={(e) => updateSetting('AUTO_START', e.target.checked)}
          />
          オートスタート
        </label>
        <p className="description">
          ページを開いたら自動的に録画を開始します。
        </p>
      </div>

      <div className="setting-block">
        <label htmlFor="intervalRange">
          分割間隔: {Math.round(settings.RESTART_MEDIARECORDER_INTERVAL_MS / 60000)} 分
        </label>
        <p className="description">
          この値で録画を定期的に分割保存します。
        </p>
        <input
          ref={intervalRef}
          id="intervalRange"
          type="range"
          min={1 * 60 * 1000}
          max={60 * 60 * 1000}
          step={1 * 60 * 1000}
          value={settings.RESTART_MEDIARECORDER_INTERVAL_MS}
          onChange={(e) =>
            updateSetting('RESTART_MEDIARECORDER_INTERVAL_MS', Number(e.target.value))
          }
        />
      </div>

      <div className="setting-block">
        <label htmlFor="storageRange">
          ストレージ使用量: {Math.round(settings.MAX_STORAGE_SIZE / (1024 * 1024 * 1024))} GB
        </label>
        <p className="description">
          使用できる容量は環境によって異なります。合計サイズが設定値を超えた場合、自動的に古いものから順に削除されます。
          {storageQuota > 0 && (
            <span style={{ display: 'block', marginTop: '4px', fontSize: '0.9em', color: '#666' }}>
              あなたの環境のストレージ上限（目安）: {Math.round(storageQuota / (1024 * 1024 * 1024))} GB
            </span>
          )}
        </p>
        <input
          ref={storageRef}
          id="storageRange"
          type="range"
          min={1 * 1024 * 1024 * 1024}
          max={100 * 1024 * 1024 * 1024} // ← 固定100GBに戻す
          step={1 * 1024 * 1024 * 1024}
          value={settings.MAX_STORAGE_SIZE}
          onChange={(e) =>
            updateSetting('MAX_STORAGE_SIZE', Number(e.target.value))
          }
        />
      </div>

      {/* 現在の使用量バー */}
      <div className="current-usage">
        <div className="usage-info">
          <span>
            現在の使用量:{' '}
            {currentStorageUsage !== null
              ? `${Math.round(
                  (currentStorageUsage / (1024 * 1024 * 1024)) * 100
                ) / 100} GB`
              : '---'}
          </span>
          <span>
            設定上限:{' '}
            {Math.round(settings.MAX_STORAGE_SIZE / (1024 * 1024 * 1024))}{' '}
            GB
          </span>
        </div>
        <div className="usage-bar-container">
          <div
            className="usage-bar"
            style={{
              width: `${
                currentStorageUsage !== null
                  ? Math.min(
                      (currentStorageUsage / settings.MAX_STORAGE_SIZE) * 100,
                      100
                    )
                  : 0
              }%`,
              backgroundColor:
                currentStorageUsage !== null &&
                currentStorageUsage > settings.MAX_STORAGE_SIZE * 0.8
                  ? '#ff6b6b'
                  : '#4CAF50',
            }}
          ></div>
        </div>
        {currentStorageUsage === null && (
          <p className="description" style={{ textAlign: 'center', marginTop: '8px' }}>
            ライブ視聴ページでのみ動作します
          </p>
        )}
        {/* クリアボタン追加 */}
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 16, gap: 16 }}>
          <button
            style={{ marginBottom: '0', padding: '4px 12px', fontSize: '0.8em', width: '100px', height: '24px' }}
            onClick={async () => {
              // content scriptにクリア要求
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
              if (!tab.id) return
              const response = await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_ALL_RECORDINGS' })
              if (response && response.success) {
                await getStorageUsageData()
                showMessage('ストレージをクリアしました', 'success')
              } else if (response && response.error) {
                showMessage('ストレージのクリアに失敗しました: ' + response.error, 'error')
              } else {
                showMessage('ストレージのクリアに失敗しました', 'error')
              }
            }}
          >
            クリア
          </button>
          <span style={{ fontSize: '0.8em', color: '#666' }}>
            ストレージをクリアします。録画データはすべて削除されます。
          </span>
        </div>
        
        {/* メッセージ表示エリア */}
        {clearMessage && (
          <div
            style={{
              marginTop: '8px',
              padding: '8px 12px',
              borderRadius: '4px',
              fontSize: '0.8em',
              backgroundColor: clearMessage.type === 'success' ? '#d4edda' : '#f8d7da',
              color: clearMessage.type === 'success' ? '#155724' : '#721c24',
              border: `1px solid ${clearMessage.type === 'success' ? '#c3e6cb' : '#f5c6cb'}`,
              textAlign: 'center'
            }}
          >
            {clearMessage.text}
          </div>
        )}
      </div>
    </div>
  )
}

export default App
