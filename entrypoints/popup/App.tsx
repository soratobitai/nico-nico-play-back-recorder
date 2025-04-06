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

  const intervalRef = useRef<HTMLInputElement>(null)
  const storageRef = useRef<HTMLInputElement>(null)

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
    }

    loadSettings()
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
    100 * 1024 * 1024 * 1024
  )

  return (
    <div className="popup-container">
      <h2>録画設定</h2>

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
          使用できる容量は環境に依存します。録画リストの合計サイズが設定値を超えた場合、自動的に古いものから順に削除されます。
        </p>
        <input
          ref={storageRef}
          id="storageRange"
          type="range"
          min={1 * 1024 * 1024 * 1024}
          max={100 * 1024 * 1024 * 1024}
          step={1 * 1024 * 1024 * 1024}
          value={settings.MAX_STORAGE_SIZE}
          onChange={(e) =>
            updateSetting('MAX_STORAGE_SIZE', Number(e.target.value))
          }
        />
      </div>

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

      <p className="description">
        設定内容を確実に反映させるには、ページを更新する必要があります。
      </p>
    </div>
  )
}

export default App
