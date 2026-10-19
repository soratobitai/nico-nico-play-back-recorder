// 見直しのウィンドウの見た目（Document Picture-in-Picture のウィンドウには、ページの CSS が届かないので埋め込む）
const REVIEW_STYLE = `
:root {
  color-scheme: dark;
  --ground: #0d0d0f;
  --bar: #17171a;
  --button: #26262b;
  --button-hover: #303036;
  --line: #3a3a41;
  --text: #f2f2f3;
  --muted: #a9a9b1;
  --accent: #4d7ff0;
  --live: #ef4444;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--ground);
  color: var(--text);
  font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}
.stage { position: relative; flex: 1; min-height: 0; background: #000; }
.stage video { display: block; width: 100%; height: 100%; object-fit: contain; }
.message {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center; line-height: 1.7; white-space: pre-line;
  color: #d4d4d9; background: rgba(0, 0, 0, 0.72);
}
.message[hidden] { display: none; }
.bar { background: var(--bar); padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
.seek { width: 100%; height: 24px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.row { display: flex; align-items: center; gap: 6px; }
button {
  height: 36px; min-width: 36px; padding: 0 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--button); color: var(--text);
  font: inherit; white-space: nowrap; cursor: pointer;
}
button:hover { background: var(--button-hover); }
button:disabled { opacity: 0.45; cursor: default; }
button:focus-visible, .seek:focus-visible { outline: 2px solid #9dbcff; outline-offset: 1px; }
button svg { flex: none; }
.play { min-width: 44px; }
.time { display: flex; flex-direction: column; justify-content: center; min-width: 0; margin: 0 6px; font-variant-numeric: tabular-nums; line-height: 1.3; }
.clock { font-size: 15px; font-weight: 700; }
.behind { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.spacer { flex: 1; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b73; display: inline-block; }
.live.at-live .live-dot { background: var(--live); }
.live.at-live { color: #ff8a8a; }
.kinds { display: flex; gap: 4px; }
.kinds[hidden], .kind[hidden] { display: none; }
.kind { font-size: 12px; padding: 0 8px; }
.kind[aria-pressed="true"].kind-video { background: #3567d6; border-color: #3567d6; color: #fff; }
.kind[aria-pressed="true"].kind-comments { background: #1fa88d; border-color: #1fa88d; color: #0d1412; }
.kind[aria-pressed="true"].kind-screen { background: #f5b54a; border-color: #f5b54a; color: #1c1406; }
@media (max-width: 640px) {
  .kind { padding: 0 6px; font-size: 11px; }
}
@media (max-width: 460px) {
  .label { display: none; }
  .bar { padding: 2px 6px 6px; }
}
`

export { REVIEW_STYLE }
