import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
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
          "html/*",
          "script/*"
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
