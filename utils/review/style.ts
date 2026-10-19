// 見直しの画面の見た目
// Document Picture-in-Picture のウィンドウにはページの CSS が届かないので、文字列で持って埋め込む。
// ライブラリのページでも同じ画面を使うので、.review の中だけに効くようにする
const REVIEW_STYLE = `
.review {
  --ground: #0d0d0f;
  --bar: #17171a;
  --button: #26262b;
  --button-hover: #303036;
  --line: #3a3a41;
  --text: #f2f2f3;
  --muted: #a9a9b1;
  --accent: #4d7ff0;
  --live: #ef4444;
  color-scheme: dark;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ground);
  color: var(--text);
  font-family: "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", sans-serif;
  font-size: 13px;
  user-select: none;
  container-type: inline-size;
}
.review * { box-sizing: border-box; }
.review .stage { position: relative; flex: 1; min-height: 0; background: #000; }
.review .stage video { display: block; width: 100%; height: 100%; object-fit: contain; }
.review .message {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center; line-height: 1.7; white-space: pre-line;
  color: #d4d4d9; background: rgba(0, 0, 0, 0.72);
}
.review .message[hidden] { display: none; }
.review .bar { background: var(--bar); padding: 4px 10px 10px; display: flex; flex-direction: column; gap: 4px; }
.review .seek { width: 100%; height: 24px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.review .row { display: flex; align-items: center; gap: 6px; }
.review button {
  height: 36px; min-width: 36px; padding: 0 10px;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--button); color: var(--text);
  font: inherit; white-space: nowrap; cursor: pointer;
}
.review button:hover { background: var(--button-hover); }
.review button:disabled { opacity: 0.45; cursor: default; }
.review button:focus-visible, .review .seek:focus-visible { outline: 2px solid #9dbcff; outline-offset: 1px; }
.review button svg { flex: none; }
.review button[hidden] { display: none; }
.review .play { min-width: 44px; }
.review .time { display: flex; flex-direction: column; justify-content: center; min-width: 0; margin: 0 6px; font-variant-numeric: tabular-nums; line-height: 1.3; }
.review .clock { font-size: 15px; font-weight: 700; white-space: nowrap; }
.review .behind { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.review .behind:empty { display: none; }
.review .spacer { flex: 1; }
.review .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b73; display: inline-block; }
.review .live.at-live .live-dot { background: var(--live); }
.review .live.at-live { color: #ff8a8a; }
.review .kinds { display: flex; gap: 4px; }
.review .kinds[hidden] { display: none; }
.review .kind { font-size: 12px; padding: 0 8px; }
.review .kind[aria-pressed="true"].kind-video { background: #3567d6; border-color: #3567d6; color: #fff; }
.review .kind[aria-pressed="true"].kind-comments { background: #1fa88d; border-color: #1fa88d; color: #0d1412; }
.review .kind[aria-pressed="true"].kind-screen { background: #f5b54a; border-color: #f5b54a; color: #1c1406; }
@container (max-width: 640px) {
  .review .kind { padding: 0 6px; font-size: 11px; }
}
@container (max-width: 460px) {
  .review .label { display: none; }
  .review .bar { padding: 2px 6px 6px; }
}
`

// 見直しのウィンドウ（Document Picture-in-Picture）のページ全体
const REVIEW_WINDOW_STYLE = `
html, body { height: 100%; margin: 0; background: #0d0d0f; overflow: hidden; }
`

export { REVIEW_STYLE, REVIEW_WINDOW_STYLE }
