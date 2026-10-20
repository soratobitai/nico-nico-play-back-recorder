// 録画の種類のアイコンの形（録画バーのチップと、録画を見る画面の種類の切り替えで同じ形を使う）
// - コメントなし: 吹き出しに斜線 / コメントあり: 吹き出しに文字の線 / 画面録画: 画面（真ん中の丸は使う側で足す）
const BUBBLE = '<path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-4.5 3.5v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"></path>'

const KIND_ICON_PATHS = {
    video: `${BUBBLE}<path d="M3.5 3l17 17.5"></path>`,
    comments: `${BUBBLE}<path d="M7.5 9h9M7.5 12.5h6"></path>`,
    screen: '<rect x="2.5" y="4" width="19" height="13" rx="2.2"></rect><path d="M8.5 20.5h7M12 17v3.5"></path>',
}

// 画面のアイコンの真ん中の丸
const SCREEN_DOT = { cx: 12, cy: 10.5, r: 3.4 }

export { KIND_ICON_PATHS, SCREEN_DOT }
