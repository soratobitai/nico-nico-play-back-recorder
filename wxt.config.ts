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
    "permissions": [
      "storage"
    ],
    "web_accessible_resources": [
      {
        "resources": [
          "assets/images/*"
        ],
        // 画像を使うのはニコ生の視聴ページに埋め込む UI だけなので、他のサイトからは読めないようにする
        "matches": [
          "*://live.nicovideo.jp/*"
        ]
      }
    ]
  }
})
