import { useState, useEffect } from 'react'
import './App.css'
import { getAllChunks } from "../../hooks/indexdb"
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import workerUrl from "/assets/lib/worker.js?worker&url"

function App() {

  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'
  const [videoURL, setVideoURL] = useState<string>("")

  useEffect(() => {
    
    getAllChunks()
      .then(async (chunks) => {
        // console.log("chunks", chunks)

        const ffmpeg = new FFmpeg()

        ffmpeg.on('log', ({ message }) => {
          console.log(message)
        })

        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
          classWorkerURL: new URL(workerUrl, import.meta.url).toString(),
        })

        console.log("FFmpeg Loaded:", ffmpeg.loaded)

        if (chunks.length > 0) {

          const blobParts = chunks.map((entry) => entry.chunk); // `chunk` キーから `Blob` を取得
          const blob = new Blob(blobParts, { type: "video/webm" }) // `Blob` に結合

          // webm を FFmpeg の仮想ファイルシステムに書き込み
          await ffmpeg.writeFile("input.webm", new Uint8Array(await blob.arrayBuffer()))

          // webm -> mp4 へ変換
          await ffmpeg.exec([
            "-i", "input.webm",
            "-r", "30",             // フレームレートを固定（WebM のフレームレートに依存しない）
            "-vsync", "vfr",        // フレームの重複を防ぐ
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-c:a", "aac",          // 音声コーデックを指定（WebM の Opus を変換）
            "-b:a", "128k",         // 音声ビットレート
            "output.mp4",
            // '-f', 'webm_dash_manifest', // WebM 形式として認識しやすくする
            '-fflags', '+genpts', // タイムスタンプを自動修正
            // '-copyts',            // タイムスタンプを維持
            // '-reset_timestamps', '1', // タイムスタンプをリセット
          ]); 

          // 変換後のファイルを取得（Uint8Array で受け取る）
          const fileData = await ffmpeg.readFile("output.mp4") // fileData は Uint8Array

          // Blob に変換して動画を再生
          const mp4Blob = new Blob([fileData], { type: "video/mp4" })

          setVideoURL(URL.createObjectURL(mp4Blob))
        }
      })
      .catch(console.error)
  }, [])

  return (
    <video id="video" controls autoPlay>
      {videoURL && <source src={videoURL} type="video/webm" />}
      Your browser does not support the video tag.
    </video>
  )
}

export default App
