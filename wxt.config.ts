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
          "*://live.nicovideo.jp/*"
        ]
      }
    ]
  }
})
