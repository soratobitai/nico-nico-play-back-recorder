// ファイルの保存（ダウンロード）
import { getBridge } from './library/client'

// a タグで保存を始める（owner のページから。閉じられていたら、このページから）
// クリック直後に解放するとダウンロードが始まる前に読めなくなることがあるので、少し待ってから解放する
const saveWithLink = (blob: Blob, filename: string, owner: Document = document) => {
    const doc = owner.defaultView && owner.body ? owner : document
    const url = URL.createObjectURL(blob)
    const a = doc.createElement('a')
    a.href = url
    a.download = filename
    doc.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000)
}

// Blob をファイルとしてダウンロードする
// ニコ生のページ・プレイバックの窓からは、拡張機能のページ（ニコ生のページに埋め込んだ bridge）で保存を始める。
// Chrome は、ニコ生のサイトの「自動ダウンロード」がブロックだと（確認で「ブロック」を選んだ・Chrome 全体で許可しない設定にした）、
// ニコ生のページからは、ページを開いてから1回しか保存させない（2回目からは、ボタンを押しても何も起きない）。
// 拡張機能のページからの保存は、ニコ生のサイトの設定では止められない。
// bridge を使えない時（拡張機能が更新された後など）は、ownerDocument（ボタンを押したページ）から保存する
// （Chrome は、操作のないまま続けて保存したページでは2回目から確認を出す。プレイバックの窓で押した時は、
//   窓の操作はニコ生のタブの操作に数えられないので、窓から始める）
// bridge での保存は、すぐ終わる（保存を始めるだけ）。応答がない時に長く待たない
const DOWNLOAD_TIMEOUT_MS = 10 * 1000
const downloadBlob = async (blob: Blob, filename: string, ownerDocument: Document = document) => {
    if (location.protocol !== 'chrome-extension:') {
        try {
            await (await getBridge()).call({ type: 'download', blob, filename }, DOWNLOAD_TIMEOUT_MS)
            return
        } catch (error) {
            console.log('拡張機能のページで保存できなかったため、このページから保存します:', error)
        }
    }
    saveWithLink(blob, filename, ownerDocument)
}

export { downloadBlob, saveWithLink }
