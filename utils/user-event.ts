// ユーザーが操作した時の出来事か
// 録画バーや設定画面はニコ生のページの中にあるので、ページのスクリプトがボタンを押したことにして、
// 録画を止めたり設定を変えたりできないように、ユーザーの操作（isTrusted）だけを受け付ける
let acceptSynthetic = false

const isUserEvent = (event: Event) => event.isTrusted || acceptSynthetic

// テストでは、作った出来事もユーザーの操作として扱う
const setAcceptSyntheticEvents = (accept: boolean) => {
    acceptSynthetic = accept
}

export { isUserEvent, setAcceptSyntheticEvents }
