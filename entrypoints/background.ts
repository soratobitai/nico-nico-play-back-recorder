// import { saveChunk, cleanUp } from "../hooks/indexdb"

export default defineBackground(async () => {
  // console.log('Hello background!', { id: browser.runtime.id })

  // chrome.runtime.onConnect.addListener(port => {
  //   port.onMessage.addListener(async (message) => {

  //     if (message.action === "saveChunk") {

  //       const uint8Array = new Uint8Array(message.chunk); // 数値配列 → Uint8Array
  //       const blob = new Blob([uint8Array], { type: "video/webm" }); // Uint8Array → Blob

  //       console.log("Received a message to save a chunk", blob)

  //       await saveChunk(blob)

  //       return true; // 非同期処理のため true を返す
  //     }
  //   })
  // })

  // chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {

  //   if (message.action === "saveChunk") {

  //     const uint8Array = new Uint8Array(message.chunk); // 数値配列 → Uint8Array
  //     const blob = new Blob([uint8Array], { type: "video/webm" }) // Uint8Array → Blob

  //     console.log("Received a message to save a chunk", blob)

  //     saveChunk(blob)
  //       .then(() => sendResponse({ success: true }))

  //     return true; // 非同期処理のため true を返す
  //   }

  //   if (message.action === "cleanUp") {
  //     await cleanUp()
  //     sendResponse({ success: true })
  //     return true // 非同期処理のため true を返す
  //   }
  // })
})




