// 録画を見る画面（プレイバック・録画一覧）の見た目
// Document Picture-in-Picture のウィンドウにはページの CSS が届かないので、文字列で持って埋め込む。
// 録画一覧のページでも同じ画面を使うので、.review の中だけに効くようにする。
// 幅が狭い時は、文字を小さくし、ラベル → 種類の名前 → 説明の順に隠してコンパクトにする（文字は読み上げには残す）。
// 幅で変える指定は .review の中の要素に書く（.review 自身は幅を測る側なので、@container の指定が効かない）
const REVIEW_STYLE = `
.review {
  --ground: #0b0c0f;
  --bar: #111216;
  --line: rgba(255, 255, 255, 0.08);
  --surface: rgba(255, 255, 255, 0.06);
  --surface-hover: rgba(255, 255, 255, 0.11);
  --border: rgba(255, 255, 255, 0.1);
  --text: #eceef3;
  --icon: #cfd3dc;
  --muted: #8d92a0;
  --accent: #5c8dff;
  --live: #ff4d5e;
  --live-rgb: 255, 77, 94;
  --video-rgb: 92, 141, 255;
  --comments-rgb: 32, 201, 151;
  --screen-rgb: 245, 177, 66;
  --control: 32px;
  color-scheme: dark;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ground);
  color: var(--text);
  font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", "Meiryo", sans-serif;
  font-size: 12px;
  letter-spacing: 0.02em;
  user-select: none;
  container-type: inline-size;
}
.review * { box-sizing: border-box; }
.review .stage { position: relative; flex: 1; min-height: 0; background: #000; }
.review .stage video { display: block; width: 100%; height: 100%; object-fit: contain; }
/* 録画一覧では、動画を押すと再生・一時停止する */
.review[data-mode="library"] .stage video { cursor: pointer; }
.review .message {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center; line-height: 1.7; white-space: pre-line;
  font-size: 13px; color: #d4d6dd; background: rgba(0, 0, 0, 0.72);
}
.review .message[hidden] { display: none; }

/* 操作の帯 */
.review .bar {
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 10px 8px;
  background: var(--bar);
  border-top: 1px solid var(--line);
}
/* ボタン類は縮めない（形を保つ）。入り切らない時は、消したり重ねたりせず横にスクロールする
   （スクロールする所の端で、選んだボタンの枠が切れないように、少し余白をとる） */
.review .row {
  display: flex; align-items: center; gap: 4px; min-width: 0;
  padding: 3px; margin: -3px;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.review .row > * { flex-shrink: 0; }
.review .spacer { flex: 1 0 4px; }

/* シークバー（細い線。再生した所まで色をつける） */
/* 下の操作の行（枠のための余白）より手前にして、シークバーの下の端も押せるようにする */
.review .seek {
  position: relative; z-index: 1;
  --progress: 0%;
  width: 100%; height: 18px; margin: 0;
  appearance: none; -webkit-appearance: none;
  background: transparent; cursor: pointer;
}
.review .seek::-webkit-slider-runnable-track {
  height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--accent) 0 var(--progress), rgba(255, 255, 255, 0.16) var(--progress) 100%);
  transition: height 0.12s;
}
.review .seek:hover::-webkit-slider-runnable-track { height: 6px; }
.review .seek::-webkit-slider-thumb {
  appearance: none; -webkit-appearance: none;
  width: 12px; height: 12px; margin-top: -4px;
  border-radius: 50%; border: none;
  background: #fff; box-shadow: 0 0 0 3px rgba(var(--video-rgb), 0.35), 0 1px 4px rgba(0, 0, 0, 0.5);
}
.review .seek:hover::-webkit-slider-thumb { margin-top: -3px; }
.review .seek:disabled { opacity: 0.4; cursor: default; }

/* ボタン（枠のない控えめなアイコン） */
.review button {
  height: var(--control); min-width: var(--control); padding: 0 8px;
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--icon);
  font: inherit; font-size: 11.5px; font-weight: 600; white-space: nowrap; cursor: pointer;
  transition: background-color 0.12s, color 0.12s, border-color 0.12s;
}
.review button:hover { background: var(--surface-hover); color: #fff; }
.review button:disabled { opacity: 0.4; cursor: default; background: transparent; }
.review button:focus-visible, .review .seek:focus-visible { outline: 2px solid #9dbcff; outline-offset: 1px; }
.review button svg { flex: none; width: 18px; height: 18px; }
.review button[hidden] { display: none; }
.review .back, .review .forward { padding: 0 6px; }
.review .back .label, .review .forward .label { font-size: 11px; color: var(--muted); }
.review .back:hover .label, .review .forward:hover .label { color: inherit; }

/* 再生・一時停止（白い丸） */
.review .play {
  width: calc(var(--control) + 4px); height: calc(var(--control) + 4px); min-width: 0; padding: 0;
  flex: none; aspect-ratio: 1; border-radius: 50%; background: #f2f4f8; color: #111216;
}
.review .play:hover { background: #fff; color: #000; }
.review .play:disabled { background: rgba(255, 255, 255, 0.3); }
.review .play svg { width: 16px; height: 16px; }

/* 録った時刻と、ライブからの遅れ（録画一覧では、番組の中での位置） */
.review .time {
  display: flex; flex-direction: column; justify-content: center; min-width: 0; flex-shrink: 0;
  margin: 0 6px; line-height: 1.25; font-variant-numeric: tabular-nums;
}
.review .clock { font-size: 13px; font-weight: 700; color: var(--text); white-space: nowrap; letter-spacing: 0.03em; }
.review .behind { font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.review .behind:empty { display: none; }

/* 種類の切り替え（色の丸つきのセグメント） */
.review .kinds {
  display: flex; gap: 2px; padding: 2px;
  border: 1px solid var(--border); border-radius: 9px;
  background: rgba(0, 0, 0, 0.25);
}
.review .kinds[hidden] { display: none; }
.review .kind {
  --kind-rgb: 141, 146, 160;
  height: calc(var(--control) - 6px); min-width: 0; padding: 0 9px 0 8px;
  border-radius: 7px; color: var(--muted); font-size: 11px;
}
.review .kind-video { --kind-rgb: var(--video-rgb); }
.review .kind-comments { --kind-rgb: var(--comments-rgb); }
.review .kind-screen { --kind-rgb: var(--screen-rgb); }
.review .kind-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; border: 1.5px solid rgb(var(--kind-rgb)); opacity: 0.8; }
.review .kind[aria-pressed="true"] { background: rgba(var(--kind-rgb), 0.2); color: #fff; }
.review .kind[aria-pressed="true"] .kind-dot { background: rgb(var(--kind-rgb)); opacity: 1; box-shadow: 0 0 6px rgba(var(--kind-rgb), 0.8); }

/* 音 */
.review .mute .label { font-size: 11px; }
.review .mute[data-state="sound"] { color: #fff; }

/* ライブ（遅れている間は枠だけ。押すと最新の録画へ戻る。ライブを見ている間は赤） */
.review .live {
  height: calc(var(--control) - 6px); margin-left: 4px; padding: 0 10px;
  border: 1px solid rgba(var(--live-rgb), 0.45); border-radius: 13px;
  color: #ffd0d5; font-size: 11px;
}
.review .live:hover { background: rgba(var(--live-rgb), 0.16); color: #fff; }
.review .live-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: rgba(var(--live-rgb), 0.55); display: inline-block; }
.review .live.at-live { background: rgba(var(--live-rgb), 0.16); border-color: rgba(var(--live-rgb), 0.6); color: #ff8a95; opacity: 1; }
.review .live.at-live .live-dot { background: var(--live); box-shadow: 0 0 6px rgba(var(--live-rgb), 0.9); }

/* 広い時（録画一覧など）は少しゆったり */
@container (min-width: 820px) {
  .review .bar { --control: 34px; font-size: 12.5px; padding: 4px 14px 10px; }
  .review .clock { font-size: 14px; }
  .review .kind { font-size: 11.5px; }
}
/* 少し狭い: 音と10秒のラベルを隠す */
@container (max-width: 720px) {
  .review .mute .label,
  .review .back .label, .review .forward .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
/* 狭い: 種類は色の丸だけ */
@container (max-width: 600px) {
  .review .kind-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .review .kind { padding: 0; width: calc(var(--control) - 6px); }
  .review .kind-dot { width: 9px; height: 9px; }
}
/* とても狭い: ボタンを小さく、ライブはラベルなしの丸に */
@container (max-width: 460px) {
  .review .bar { --control: 28px; font-size: 11px; padding: 0 6px 6px; }
  .review .row { gap: 2px; }
  .review button svg { width: 16px; height: 16px; }
  .review .play svg { width: 14px; height: 14px; }
  .review .clock { font-size: 12px; }
  .review .time { margin: 0 4px; }
  .review .live { padding: 0; width: calc(var(--control) - 4px); margin-left: 2px; }
  .review .live .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
/* 種類が3つの時は、ボタンが増える分、早めに詰める */
@container (max-width: 760px) {
  .review .row:has(.kinds[data-count="3"]) :is(.mute, .back, .forward) .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
}
@container (max-width: 660px) {
  .review .kinds[data-count="3"] .kind-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .review .kinds[data-count="3"] .kind { padding: 0; width: calc(var(--control) - 6px); }
  .review .kinds[data-count="3"] .kind-dot { width: 9px; height: 9px; }
}
@container (max-width: 380px) {
  .review .row:has(.kinds[data-count="3"]) .behind { display: none; }
}
@container (max-width: 330px) {
  .review .kinds[data-count="3"] .kind { width: calc(var(--control) - 10px); }
  .review .row:has(.kinds[data-count="3"]) { gap: 1px; }
}
/* さらに狭い: ライブからの遅れの説明を隠す */
@container (max-width: 360px) {
  .review .behind { display: none; }
  .review .back, .review .forward { min-width: 24px; padding: 0 2px; }
}

@media (prefers-reduced-motion: reduce) {
  .review button, .review .seek::-webkit-slider-runnable-track { transition: none; }
}
`

// プレイバックのウィンドウ（Document Picture-in-Picture）のページ全体
const REVIEW_WINDOW_STYLE = `
html, body { height: 100%; margin: 0; background: #0b0c0f; overflow: hidden; }
`

export { REVIEW_STYLE, REVIEW_WINDOW_STYLE }
