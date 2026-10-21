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
/* 動画を押すと再生・一時停止する */
.review .stage video { cursor: pointer; }
.review .message {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center; line-height: 1.7; white-space: pre-line;
  font-size: 13px; color: #d4d6dd; background: rgba(0, 0, 0, 0.72);
}
.review .message[hidden] { display: none; }
/* スクリーンショットや動画を保存した時などの短いお知らせ（狭い時は折り返す） */
.review .flash {
  position: absolute; left: 50%; top: 12px; transform: translateX(-50%);
  width: max-content; max-width: calc(100% - 24px); box-sizing: border-box;
  padding: 6px 12px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.72); color: #fff; font-size: 12px; text-align: center;
  pointer-events: none;
}
.review .flash[hidden] { display: none; }

/* 操作の帯 */
.review .bar {
  display: flex; flex-direction: column; gap: 2px;
  padding: 2px 10px 8px;
  background: var(--bar);
  border-top: 1px solid var(--line);
}
/* 操作の行: 再生の操作を真ん中に、種類と音を左端、時間（プレイバックではライブに戻るボタンも）を右端に
   ボタン類は縮めない（形を保つ）。入りきらない時は、fit.ts がいらないものから隠す（下の data-hide） */
.review .row {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; column-gap: 8px; min-width: 0;
  padding: 3px; margin: -3px;
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}
.review :is(.row-start, .row-center, .row-end) { display: flex; align-items: center; gap: 4px; min-width: 0; }
.review :is(.row-start, .row-center, .row-end) > * { flex-shrink: 0; }
.review .row-start { grid-column: 1; }
.review .row-center { grid-column: 2; }
.review .row-end { grid-column: 3; justify-content: flex-end; }

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
.review button:is(:disabled, [aria-disabled="true"]) { opacity: 0.4; cursor: default; background: transparent; }
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

/* 録画を始めてからの時間（横に番組の経過時間）と、その場面の時刻（プレイバックでは、ライブからどれだけ前か も） */
.review .time {
  display: flex; flex-direction: column; justify-content: center; min-width: 0; flex: 0 1 auto;
  margin: 0; line-height: 1.25; font-variant-numeric: tabular-nums;
}
/* 番組の経過時間は、入りきらない時は折り返した2行目に回して隠す（途中で切れて見えないように） */
.review .time-main {
  display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 5px;
  height: 1lh; overflow: hidden; font-size: 13px; white-space: nowrap;
}
.review .clock { font-size: 1em; font-weight: 700; color: var(--text); letter-spacing: 0.03em; }
.review .program-time { font-size: 10.5px; font-weight: 600; color: var(--muted); }
.review .program-time:empty { display: none; }
/* ライブからどれだけ前かも、入りきらない時は2行目に回して隠す。時刻も入りきらなければ … で切る */
.review .behind {
  display: flex; flex-wrap: wrap; height: 1lh; overflow: hidden;
  font-size: 10.5px; color: var(--muted); white-space: nowrap;
}
.review .behind[hidden] { display: none; }
.review .scene-time { min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* 種類の切り替え（録画バーの種類のチップと同じ、吹き出しのアイコン。見ている種類は、その色のアイコンと薄い色の面）
   名前は読み上げとマウスを乗せた時の説明で伝える */
.review .kinds { display: flex; gap: 5px; }
.review .kinds[hidden] { display: none; }
.review .kind {
  --kind-rgb: 141, 146, 160;
  height: calc(var(--control) - 6px); min-width: 0; padding: 0 8px;
  border: 1px solid var(--border); border-radius: 6px; color: var(--muted);
}
.review .kind-video { --kind-rgb: var(--video-rgb); }
.review .kind-comments { --kind-rgb: var(--comments-rgb); }
.review .kind-screen { --kind-rgb: var(--screen-rgb); }
.review .kind svg { width: 16px; height: 16px; }
.review .kind:hover { background: var(--surface); border-color: rgba(255, 255, 255, 0.16); color: var(--text); }
.review .kind[aria-pressed="true"] { background: rgba(var(--kind-rgb), 0.14); border-color: rgba(var(--kind-rgb), 0.5); color: #f2f4f8; }
.review .kind[aria-pressed="true"]:hover { background: rgba(var(--kind-rgb), 0.22); }
.review .kind[aria-pressed="true"] svg { color: rgb(var(--kind-rgb)); }

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
  .review .time-main { font-size: 14px; }
}
/* とても狭い: ボタンを小さく */
@container (max-width: 460px) {
  .review .bar { --control: 28px; font-size: 11px; padding: 0 6px 6px; }
  .review .row { column-gap: 4px; }
  .review :is(.row-start, .row-center, .row-end) { gap: 2px; }
  .review .kinds { gap: 3px; }
  .review .kind { padding: 0 6px; }
  .review button svg { width: 16px; height: 16px; }
  .review .play svg { width: 14px; height: 14px; }
  .review .time-main { font-size: 12px; }
  .review .live { margin-left: 2px; }
}

/* 入りきらない時に、いらないものから順に隠す（fit.ts の HIDE_ORDER の順に data-hide に足される） */
.review[data-hide~="labels"] :is(.back, .forward, .mute) .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.review[data-hide~="skip"] :is(.back, .forward),
.review[data-hide~="play"] .play,
.review[data-hide~="shot"] :is(.shot, .clip),
.review[data-hide~="program"] .program-time,
.review[data-hide~="ago"] .ago,
.review[data-hide~="behind"] .behind { display: none; }
.review[data-hide~="live-label"] .live { padding: 0; width: calc(var(--control) - 4px); }
.review[data-hide~="live-label"] .live .label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.review[data-hide~="tight"] .row { column-gap: 4px; }
.review[data-hide~="tight"] :is(.row-start, .row-center, .row-end) { gap: 1px; }
.review[data-hide~="tight"] .kinds { gap: 2px; }
.review[data-hide~="tight"] .kind { padding: 0 4px; }
/* それでも入りきらなければ、重ねずに横にスクロールする */
.review[data-hide~="scroll"] .row { display: flex; }

@media (prefers-reduced-motion: reduce) {
  .review button, .review .seek::-webkit-slider-runnable-track { transition: none; }
}
`

// プレイバックのウィンドウ（Document Picture-in-Picture）のページ全体
const REVIEW_WINDOW_STYLE = `
html, body { height: 100%; margin: 0; background: #0b0c0f; overflow: hidden; }
`

export { REVIEW_STYLE, REVIEW_WINDOW_STYLE }
