import { defineConfig } from 'wxt'
import type { WxtViteConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({

  // Production 用の設定
  vite: ({ mode }): WxtViteConfig => {
    const isDev = mode === 'development'

    return {
      build: {
        sourcemap: isDev, // ← dev の時のみ true、本番は false
        // ページに共通のファイルを先読みする指定（modulepreload）を入れない。
        // ニコ生のページに埋め込む bridge.html では、Chrome が先読みを使えず
        // 「preload ... is not used because it is a cross-world extension resource mismatch」と警告が溜まるため
        // （拡張機能の中のファイルなので、先読みしなくても読み込みは速い）
        modulePreload: false,
      },
      esbuild: !isDev
        ? {
          drop: ['console'],
        }
        : {},
    }
  },

  // Development 用の設定
  // vite: ({ mode }): WxtViteConfig => {
  //   return {
  //     build: {
  //       sourcemap: true,
  //     }
  //   }
  // },

  extensionApi: 'chrome',
  modules: [
    '@wxt-dev/auto-icons'
  ],
  manifest: {
    "name": "ニコ生プレイバックレコーダー",
    // 録画バーの表示に使う CSS（:has・@container）が使える版から。それより古い Chrome では、以前のバージョンのまま
    "minimum_chrome_version": "105",
    // ツールバーの拡張機能のアイコンを押すと、録画一覧を開く
    "action": {
      "default_title": "録画一覧を開く"
    },
    "permissions": [
      "storage",
      // 録画を拡張機能側に保存するため（ブラウザの容量制限を受けないように）
      "unlimitedStorage"
    ],
    "web_accessible_resources": [
      {
        "resources": [
          // ニコ生のページに埋め込み、録画を拡張機能側に保存するためのページ
          "bridge.html"
        ],
        // 使うのはニコ生の視聴ページに埋め込む bridge だけなので、他のサイトからは読めないようにする
        "matches": [
          "https://live.nicovideo.jp/*"
        ]
      }
    ]
  }
})
