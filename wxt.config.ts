import { defineConfig } from 'wxt'
import type { WxtViteConfig } from 'wxt'

// See https://wxt.dev/api/config.html
export default defineConfig({
  // vite: ({ mode }): WxtViteConfig => {
  //   const isDev = mode === 'development'

  //   return {
  //     build: {
  //       sourcemap: isDev, // ← dev のときのみ true、本番は false
  //     },
  //     esbuild: !isDev
  //       ? {
  //         drop: ['console'],
  //       }
  //       : {},
  //   }
  // },
  vite: ({ mode }): WxtViteConfig => {
    return {
      build: {
        sourcemap: true,
      }
    }
  },
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    "permissions": [
      "storage",
      "scripting"
    ],
    // "host_permissions": [
    //   "*://live.nicovideo.jp/watch/*"
    // ],
    "web_accessible_resources": [
      {
        "resources": [
          "assets/lib/*",
          "assets/images/*"
        ],
        "matches": [
          "<all_urls>"
        ]
      }
    ]
  },
  // hooks: {
  //   'build:manifestGenerated': (wxt, manifest) => {
  //     manifest.content_scripts ??= []
  //     manifest.content_scripts.push({
  //       // Build extension once to see where your CSS get's written to
  //       css: ['content/style.css'],
  //       matches: ['*://live.nicovideo.jp/watch/*'],
  //     })
  //   },
  // },
})
