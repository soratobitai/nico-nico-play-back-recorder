import { useState, useEffect, useRef } from 'react'
import './App.css'

const DEFAULT_INTERVAL = 1 * 60 * 1000
const DEFAULT_STORAGE = 1 * 1024 * 1024 * 1024

function App() {
  const [interval, setInterval] = useState<number>(DEFAULT_INTERVAL)
  const [storage, setStorage] = useState<number>(DEFAULT_STORAGE)
  const [saved, setSaved] = useState(false)

  const intervalRef = useRef<HTMLInputElement>(null)
  const storageRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    chrome.storage.sync.get(['RESTART_MEDIARECORDER_INTERVAL_MS', 'MAX_STORAGE_SIZE'], (result) => {
      setInterval(result.RESTART_MEDIARECORDER_INTERVAL_MS ?? DEFAULT_INTERVAL)
      setStorage(result.MAX_STORAGE_SIZE ?? DEFAULT_STORAGE)
    })
  }, [])

  const handleSave = () => {
    chrome.storage.sync.set({
      RESTART_MEDIARECORDER_INTERVAL_MS: interval,
      MAX_STORAGE_SIZE: storage
    }, () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    })
  }

  // スクロールで増減させるロジック
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

  // それぞれにスクロールイベントを設定
  attachWheelHandler(intervalRef, interval, setInterval, 60 * 1000, 1 * 60 * 1000, 60 * 60 * 1000)
  attachWheelHandler(storageRef, storage, setStorage, 1 * 1024 * 1024 * 1024, 1 * 1024 * 1024 * 1024, 100 * 1024 * 1024 * 1024)

  return (
    <div className="popup-container">
      <h2>録画設定</h2>

      <div className="setting-block">
        <label htmlFor="intervalRange">
          保存間隔: {Math.round(interval / 60000)} 分
        </label>
        <p className="description">録画を定期的に分割保存する間隔です。</p>
        <input
          ref={intervalRef}
          id="intervalRange"
          type="range"
          min={1 * 60 * 1000}
          max={60 * 60 * 1000}
          step={1 * 60 * 1000}
          value={interval}
          onChange={(e) => setInterval(Number(e.target.value))}
        />
      </div>

      <div className="setting-block">
        <label htmlFor="storageRange">
          ストレージ使用量: {Math.round(storage / (1024 * 1024 * 1024))} GB
        </label>
        <p className="description">録画リストの合計サイズが設定値を超えた場合、古いものから削除されます。</p>
        <input
          ref={storageRef}
          id="storageRange"
          type="range"
          min={1 * 1024 * 1024 * 1024}
          max={100 * 1024 * 1024 * 1024}
          step={1 * 1024 * 1024 * 1024}
          value={storage}
          onChange={(e) => setStorage(Number(e.target.value))}
        />
      </div>

      <button onClick={handleSave}>保存</button>
      <p className="description">保存した設定内容は番組ページを更新するまで反映されません。</p>

      {saved && <p className="success-message">✅ 保存しました</p>}
    </div>
  )
}

export default App
