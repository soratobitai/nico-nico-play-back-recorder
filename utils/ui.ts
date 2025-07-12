import { getChunkByKey, getAllChunks, deleteChunkByKeys, getLatestChunks, getOlderChunks, getChunksCount } from "../hooks/indexedDB/recordingDB"
import { downloadRecordedMovie, getScreenShotAndDownload } from "../utils/feature"

let capButton = null as HTMLButtonElement | null
let startButton = null as HTMLButtonElement | null
let stopButton = null as HTMLButtonElement | null
let recordStatus = null as HTMLDivElement | null
let reloadButton = null as HTMLButtonElement | null
let clearButton = null as HTMLButtonElement | null

let userScrolledAway = false

// 無限スクロール用の状態管理
let isLoadingOlder = false
let hasMoreOlder = true
let oldestLoadedTimestamp = Infinity
let newestLoadedTimestamp = 0
let loadedChunksCount = 0
let totalChunksCount = 0
const CHUNKS_PER_LOAD = 20
const CHUNK_WIDTH = 102 // 固定幅（90px + 左右ボーダー2px + margin 10px）

const insertRecordedMovieAria = async (
    start: () => void,
    stop: () => void,
    reload: () => void,
    clear: () => void,
) => {
    const controlArea = document.querySelector('[class*="_player-controller_"]')
    if (!controlArea) return

    const recordedMovieHTML = `
      <div id="recordedMovieAria">
        <div class="recordedMovieWrapper">
          <div class="recordedMovieBox">
              <div class="loading-spinner"></div>
          </div>
          <div class="control-panel">
            <div class="control-buttons">
              <div class="capbutton" id="capButton">
                <img src="${chrome.runtime.getURL("assets/images/camera.png")}" title="スクリーンショット" />
              </div>
              <button type="button" id="startButton" disabled>録画開始</button>
              <button type="button" id="stopButton" disabled>停止</button>
            </div>
            <div class="control-status">
              <div id="recordStatus">準備中</div>
              <div id="recordTime">00:00:00</div>
            </div>
            <div class="control-buttons">
              <button type="button" id="reloadButton">リスト更新</button>
              <button type="button" id="clearButton">クリア</button>
            </div>
          </div>
        </div>
      </div>
    `
    controlArea.insertAdjacentHTML("beforeend", recordedMovieHTML) // afterend

    capButton = document.getElementById("capButton") as HTMLButtonElement
    startButton = document.getElementById("startButton") as HTMLButtonElement
    stopButton = document.getElementById("stopButton") as HTMLButtonElement
    recordStatus = document.getElementById("recordStatus") as HTMLDivElement
    reloadButton = document.getElementById("reloadButton") as HTMLButtonElement
    clearButton = document.getElementById("clearButton") as HTMLButtonElement

    // キャプチャボタン
    capButton.addEventListener("click", getScreenShotAndDownload)

    // 録画ボタン
    startButton.addEventListener("click", start)

    // 停止ボタン
    stopButton.addEventListener("click", stop)

    // 録画リスト更新ボタン
    reloadButton.addEventListener("click", reload)

    // リセットボタン
    clearButton.addEventListener("click", clear)

    // 録画リストのスクロール制御
    const setupScrollWatcher = () => {
        const box = document.querySelector('.recordedMovieBox') as HTMLElement
        if (!box) return

        box.addEventListener('scroll', () => {
            const scrollRight = box.scrollWidth - box.scrollLeft - box.clientWidth
            const scrollLeft = box.scrollLeft
            const isAtRightEdge = scrollRight < 500
            const isAtLeftEdge = scrollLeft < 500

            if (isAtRightEdge) {
                userScrolledAway = false // 右端に戻ってきた
            } else {
                userScrolledAway = true // ユーザーが左へスクロールした
            }

            // 左端に近づいたら古い録画を読み込み
            if (isAtLeftEdge && hasMoreOlder && !isLoadingOlder) {
                loadOlderRecordings()
            }
        })
    }
    setTimeout(() => {
        setupScrollWatcher()
    }, 1000)
}

const insertRecordedMovie = (
    key: IDBValidKey,
    imgUrl: string | null,
    insertPosition: "start" | "end" = "start" // ← "start"（左に追加）または "end"（右に追加）
) => {
    const [sessionId_, chunkIndex_] = key as [string, string]

    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    const recordedMovie = document.createElement("div")
    recordedMovie.classList.add("recordedMovie")
    recordedMovie.setAttribute('sessionId', sessionId_)
    recordedMovie.setAttribute('chunkIndex', chunkIndex_)

    // メイン画像
    const img = document.createElement("img")
    img.src = imgUrl || chrome.runtime.getURL("assets/images/defaultScreenshot.webp")
    recordedMovie.appendChild(img)

    // ✕ボタン（削除）
    const closeButton = document.createElement("button")
    closeButton.classList.add("closeButton")
    closeButton.textContent = "✕"
    closeButton.title = "削除"
    closeButton.addEventListener("click", async (e) => {
        e.stopPropagation()
        const confirmed = await confirmModal('この動画データを削除しますか？')
        if (confirmed) {
            recordedMovie.remove() // UIから削除
            await deleteChunkByKeys('Chunks', [key]) // indexedDBから削除
        }
    })
    recordedMovie.appendChild(closeButton)

    // ダウンロードボタン
    const downloadButton = document.createElement("button")
    downloadButton.classList.add("downloadButton")
    downloadButton.textContent = "DL"
    downloadButton.title = "ダウンロード"
    downloadButton.addEventListener("click", (e) => {
        e.stopPropagation()
        downloadRecordedMovie(key as [string, number])
    })
    recordedMovie.appendChild(downloadButton)

    // クリックでモーダルを開く
    recordedMovie.addEventListener('click', (event) => {
        const parent = (event.target as HTMLElement).parentElement
        if (!parent) return

        const sessionId = parent.getAttribute('sessionId')
        const chunkIndexStr = parent.getAttribute('chunkIndex')
        if (!sessionId || chunkIndexStr === null) return

        const chunkIndex = Number(chunkIndexStr)
        if (isNaN(chunkIndex)) return

        const key: [string, number] = [sessionId, chunkIndex]
        openModalWithVideo(key, event)
    })

    // .no-video があれば、取り除く
    const noVideo = recordedMovieBox.querySelector('.no-video')
    if (noVideo) noVideo.remove()
    
    // UIに追加（右端 or 左端）
    if (insertPosition === "start") {
        recordedMovieBox.prepend(recordedMovie)
        recordedMovieBox.scrollLeft = recordedMovieBox.scrollWidth
    } else {
        recordedMovieBox.appendChild(recordedMovie)

        // 右端にいる、またはユーザーがスクロールしていなければスクロールする
        const scrollRight = recordedMovieBox.scrollWidth - recordedMovieBox.scrollLeft - recordedMovieBox.clientWidth
        const isAtRightEdge = scrollRight < 20

        if (!userScrolledAway || isAtRightEdge) {
            recordedMovieBox.scrollLeft = recordedMovieBox.scrollWidth
        }
    }
}

// モーダルを作成する関数
function createModal() {
    if (document.getElementById('video-modal')) return // すでに作成済みならスキップ

    // Body要素を取得
    const body = document.querySelector('body')
    if (!body) return

    const modal = document.createElement('div')
    modal.id = 'video-modal'
    modal.innerHTML = `
      <div class="modal-content">
          <span id="close-modal" class="close">&times;</span>
          <video id="video-player" controls autoplay></video>
      </div>
  `

    const updateModalSize = () => {
        modal.style.width = `${body.offsetWidth}px`
        modal.style.height = `${body.offsetHeight}px`
    }

    updateModalSize() // 初期サイズ設定
    window.addEventListener('resize', updateModalSize) // リサイズ時に更新

    document.body.appendChild(modal)

    // 閉じるボタンの処理
    const closeButton = document.getElementById('close-modal')
    closeButton?.addEventListener('click', () => {
        modal.style.display = 'none'
        const video = document.getElementById('video-player') as HTMLVideoElement
        video.pause()
        video.src = '' // メモリ解放
        window.removeEventListener('resize', updateModalSize) // リスナー削除
    })

    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeButton?.click()
        }
    })
}

function confirmModal(message: string = '本当に削除してもよろしいですか？'): Promise<boolean> {
    return new Promise((resolve) => {
        const existing = document.getElementById('custom-confirm-modal')
        if (existing) existing.remove()

        // モーダル全体の作成
        const modal = document.createElement('div')
        modal.id = 'custom-confirm-modal'
        modal.innerHTML = `
      <div class="modal-dialog">
        <p class="modal-message">${message}</p>
        <div class="modal-buttons">
          <button class="confirm-yes">はい</button>
          <button class="confirm-no">いいえ</button>
        </div>
      </div>
    `
        document.body.appendChild(modal)

        // ボタン取得とイベント登録
        const yesBtn = modal.querySelector('.confirm-yes') as HTMLButtonElement
        const noBtn = modal.querySelector('.confirm-no') as HTMLButtonElement

        yesBtn.addEventListener('click', () => {
            modal.remove()
            resolve(true)
        })

        noBtn.addEventListener('click', () => {
            modal.remove()
            resolve(false)
        })

        modal.addEventListener('click', () => {
            modal.remove()
            resolve(false)
        })
    })
}


// 動画を取得してモーダルを開く
const openModalWithVideo = async (key: IDBValidKey, event: MouseEvent) => {
    try {
        const chunk = await getChunkByKey('Chunks', key)
        if (!chunk) throw new Error('動画データが見つかりません')

        const url = URL.createObjectURL(chunk.blob)

        const video = document.getElementById('video-player') as HTMLVideoElement
        video.src = url

        const modal = document.getElementById('video-modal') as HTMLElement
        const modalContent = modal.querySelector('.modal-content') as HTMLElement
        modal.style.display = 'block'
        modalContent.style.width = '300px'
        modalContent.style.height = '250px'

        // クリック位置を考慮してモーダルの位置を設定
        const { pageX, pageY } = event
        const modalWidth = modalContent.offsetWidth
        const modalHeight = modalContent.offsetHeight
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight

        let posX = pageX - (modalWidth / 2)
        let posY = pageY - modalHeight - 50

        // はみ出さないように調整
        if (posX + modalWidth > viewportWidth) posX = viewportWidth - modalWidth - 10
        if (posY + modalHeight > viewportHeight) posY = viewportHeight - modalHeight - 10

        modalContent.style.position = 'absolute'
        modalContent.style.left = `${posX}px`
        modalContent.style.top = `${posY}px`
    } catch (error) {
        console.log('動画のロードに失敗しました:', error)
    }
}

// 録画リストを更新
const reloadRecordedMovieList = async () => {
    // 無限スクロール用の初期化関数を使用
    await initializeRecordedMovieList()
}

// UIから動画サムネを削除
const deleteMovieIcon = (deletedKeys: IDBValidKey[]) => {
    for (const key of deletedKeys) {
        const [sessionId, chunkIndex] = key as [string, string]
        const elements = document.querySelectorAll('.recordedMovie')
        elements.forEach(element => {
            if (element.getAttribute('sessionId') == sessionId && element.getAttribute('chunkIndex') == chunkIndex) {
                element.remove()
                // 削除された録画の数を減らす
                loadedChunksCount = Math.max(0, loadedChunksCount - 1)
            }
        })
    }
}

// コントロールパネルのボタンの状態を設定
const setRecordingStatus = (isStartBtn: boolean, isStopBtn: boolean, message: string) => {
    if (startButton) startButton.disabled = !isStartBtn
    if (stopButton) stopButton.disabled = !isStopBtn
    if (isStartBtn) {
        if (recordStatus) recordStatus.classList.remove("textRed")
    } else {
        if (recordStatus) recordStatus.classList.add("textRed")
    }
    if (recordStatus) recordStatus.textContent = message
}

// 録画時間を取得する関数
const getTimeString = (startTime: number) => {
    const now = Date.now()
    const elapsed = now - startTime
    const minutes = Math.floor(elapsed / 60000)
    const seconds = Math.floor((elapsed % 60000) / 1000)
    const hours = Math.floor(minutes / 60)
    const mm = (minutes % 60).toString().padStart(2, '0')
    const ss = seconds.toString().padStart(2, '0')
    const hh = hours.toString().padStart(2, '0')
    const timeString = `${hh}:${mm}:${ss}`
    return timeString
}

// フルスクリーン時に非表示
function watchFullscreenChange() {
    const recordedMovieAria = document.getElementById('recordedMovieAria')
    const recordedMovieWrapper = document.getElementsByClassName('recordedMovieWrapper')[0] as HTMLElement

    if (!recordedMovieAria || !recordedMovieWrapper) return

    const target = document.querySelector('[class*="_leo-player_"]')
    if (!target) return

    const observer = new ResizeObserver(entries => {
        for (const entry of entries) {
            const elementWidth = entry.contentRect.width
            const windowWidth = window.innerWidth
            const tolerance = 5

            if (Math.abs(elementWidth - windowWidth) <= tolerance) {
                recordedMovieAria.style.height = '0px'
                recordedMovieWrapper.style.height = '0px'
            } else {
                recordedMovieAria.style.height = '90px'
                recordedMovieWrapper.style.height = '90px'
            }
        }
    })

    observer.observe(target)
}

// 古い録画を読み込む関数
const loadOlderRecordings = async () => {
    if (isLoadingOlder || !hasMoreOlder) return

    isLoadingOlder = true
    const box = document.querySelector('.recordedMovieBox') as HTMLElement
    if (!box) return

    try {
        // ローディングインジケーターを左端に追加
        const loadingIndicator = document.createElement('div')
        loadingIndicator.className = 'loading-indicator'
        loadingIndicator.innerHTML = '<div class="loading-spinner"></div>'
        loadingIndicator.style.position = 'absolute'
        loadingIndicator.style.left = '10px'
        loadingIndicator.style.top = '50%'
        loadingIndicator.style.transform = 'translateY(-50%)'
        loadingIndicator.style.zIndex = '1000'
        box.appendChild(loadingIndicator)

        // 古い録画を取得
        const olderChunks = await getOlderChunks('Chunks', oldestLoadedTimestamp, CHUNKS_PER_LOAD)

        console.log("olderChunks", olderChunks)

        if (olderChunks.length === 0 || loadedChunksCount >= totalChunksCount) {
            hasMoreOlder = false
        } else {
            // 現在のスクロール位置を記録
            const currentScrollLeft = box.scrollLeft
            
            // 古い録画を左端に追加
            for (const chunk of olderChunks.reverse()) {
                insertRecordedMovie([chunk.sessionId, chunk.chunkIndex], chunk.imgUrl, "start")
                
                // タイムスタンプを更新
                if (chunk.createdAt < oldestLoadedTimestamp) {
                    oldestLoadedTimestamp = chunk.createdAt
                }
            }
            
            // スクロール位置を調整（固定幅で計算）
            const addedWidth = olderChunks.length * CHUNK_WIDTH
            box.scrollLeft = currentScrollLeft + addedWidth
            
            loadedChunksCount += olderChunks.length
        }

        // ローディングインジケーターを削除
        loadingIndicator.remove()
    } catch (error) {
        console.error('古い録画の読み込みに失敗しました:', error)
    } finally {
        isLoadingOlder = false
    }
}



// 録画リストを初期化する関数
const initializeRecordedMovieList = async () => {
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    // ローディング表示を追加
    recordedMovieBox.innerHTML = `<div class="loading-spinner"></div>`

    try {
        // 全録画数を取得（軽量）
        totalChunksCount = await getChunksCount('Chunks')
        
        if (totalChunksCount === 0) {
            // データがなければメッセージ表示
            recordedMovieBox.innerHTML = `<div class="no-video">録画リストはありません</div>`
            return
        }

        // 録画リストの幅を全録画データ分に設定
        const totalWidth = totalChunksCount * CHUNK_WIDTH
        recordedMovieBox.style.width = `${totalWidth}px`

        // 最新の録画を取得（最初の20件のみ）
        const latestChunks = await getLatestChunks('Chunks', CHUNKS_PER_LOAD)

        console.log("init latestChunks", latestChunks)
        
        // 表示リセット
        recordedMovieBox.innerHTML = ""

        // 状態を初期化
        oldestLoadedTimestamp = Math.min(...latestChunks.map(chunk => chunk.createdAt))
        newestLoadedTimestamp = Math.max(...latestChunks.map(chunk => chunk.createdAt))
        loadedChunksCount = latestChunks.length
        hasMoreOlder = totalChunksCount > CHUNKS_PER_LOAD // 総数が20件を超えていれば古い録画がある

        // 録画を表示（最新のものから右端に）
        for (const chunk of latestChunks.reverse()) {
            insertRecordedMovie([chunk.sessionId, chunk.chunkIndex], chunk.imgUrl, "end")
        }
    } catch (error) {
        console.error('録画リストの初期化に失敗しました:', error)
        recordedMovieBox.innerHTML = `<div class="no-video">エラーが発生しました</div>`
    }
}

export {
    insertRecordedMovieAria,
    insertRecordedMovie,
    createModal,
    confirmModal,
    openModalWithVideo,
    reloadRecordedMovieList,
    deleteMovieIcon,
    setRecordingStatus,
    getTimeString,
    watchFullscreenChange,
    initializeRecordedMovieList
}