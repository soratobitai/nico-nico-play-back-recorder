import App from "./App.ts"
import './style.css'

export default defineContentScript({
  matches: ["*://live.nicovideo.jp/watch/*"],
  main(ctx) {
    const ui = createIntegratedUi(ctx, {
      position: 'inline',
      onMount: App,
    })
    ui.mount()
  }
})