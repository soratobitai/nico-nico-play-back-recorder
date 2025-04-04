import { useState, useEffect, useRef } from 'react'
import './App.css'

const DEFAULT_SETTINGS = {
  RESTART_MEDIARECORDER_INTERVAL_MS: 1 * 60 * 1000,
  MAX_STORAGE_SIZE: 1 * 1024 * 1024 * 1024,
  AUTO_START: true
}

function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [isInitialized, setIsInitialized] = useState(false)

  const intervalRef = useRef<HTMLInputElement>(null)
  const storageRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (result) => {
      setSettings({ ...DEFAULT_SETTINGS, ...result })
      setIsInitialized(true)
    })
  }, [])

  useEffect(() => {
    if (!isInitialized) return
    chrome.storage.sync.set(settings)
  }, [settings, isInitialized])

  const updateSetting = <K extends keyof typeof DEFAULT_SETTINGS>(key: K, value: typeof DEFAULT_SETTINGS[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

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
    100 * 1024 * 1024 * 1024
  )

  return (
    <div className="popup-container">
      <h2>録画設定</h2>

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
        <p className="description">ページを開いた時に自動的に録画を開始します。</p>
      </div>

      <div className="setting-block">
        <label htmlFor="intervalRange">
          分割間隔: {Math.round(settings.RESTART_MEDIARECORDER_INTERVAL_MS / 60000)} 分
        </label>
        <p className="description">録画を定期的に分割保存する間隔です。</p>
        <input
          ref={intervalRef}
          id="intervalRange"
          type="range"
          min={1 * 60 * 1000}
          max={60 * 60 * 1000}
          step={1 * 60 * 1000}
          value={settings.RESTART_MEDIARECORDER_INTERVAL_MS}
          onChange={(e) => updateSetting('RESTART_MEDIARECORDER_INTERVAL_MS', Number(e.target.value))}
        />
      </div>

      <div className="setting-block">
        <label htmlFor="storageRange">
          ストレージ使用量: {Math.round(settings.MAX_STORAGE_SIZE / (1024 * 1024 * 1024))} GB
        </label>
        <p className="description">使用できる容量は環境に依存します。録画リストの合計サイズが設定値を超えた場合、自動的に古いものから順に削除されます。</p>
        <input
          ref={storageRef}
          id="storageRange"
          type="range"
          min={1 * 1024 * 1024 * 1024}
          max={100 * 1024 * 1024 * 1024}
          step={1 * 1024 * 1024 * 1024}
          value={settings.MAX_STORAGE_SIZE}
          onChange={(e) => updateSetting('MAX_STORAGE_SIZE', Number(e.target.value))}
        />
      </div>

      <p className="description">設定内容を確実に反映させるには、ページを更新する必要があります。</p>
    </div>
  )
}

export default App
