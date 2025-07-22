import { getChunkByKey, getAllChunks, deleteChunkByKeys, getLatestChunks, getOlderChunks, getChunksCount } from "../hooks/indexedDB/recordingDB"
import { downloadRecordedMovie, getScreenShotAndDownload, formatDate } from "../utils/feature"

let capButton = null as HTMLButtonElement | null
let startButton = null as HTMLButtonElement | null
let stopButton = null as HTMLButtonElement | null
let recordStatus = null as HTMLDivElement | null
let reloadButton = null as HTMLButtonElement | null
let recordingCount = null as HTMLDivElement | null

let userScrolledAway = false

// 無限スクロール用の状態管理
let isLoadingOlder = false
let hasMoreOlder = true
let oldestLoadedTimestamp = Infinity
let loadedChunksCount = 0
const CHUNKS_PER_LOAD = 20
const CHUNK_WIDTH = 102 // 固定幅（90px + 左右ボーダー2px + margin 10px）

const insertRecordedMovieAria = async (
    start: () => void,
    stop: () => void,
    reload: () => void,
    clear: () => void,
) => {
    const controlArea = document.querySelector('[class*="_control-area_"]')
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
              <div id="recordTime">00:00</div>
            </div>
            <div class="control-buttons">
              <div class="recording-info">
                <span style="color: #aaa; font-size: 11px;">録画数 <span id="recordingCount" style="font-size: 13px;">0</span></span>
              </div>
              <button type="button" id="reloadButton" title="録画リスト更新">更新</button>
            </div>
          </div>
        </div>
      </div>
    `
    controlArea.insertAdjacentHTML("afterend", recordedMovieHTML) // afterend beforeend

    capButton = document.getElementById("capButton") as HTMLButtonElement
    startButton = document.getElementById("startButton") as HTMLButtonElement
    stopButton = document.getElementById("stopButton") as HTMLButtonElement
    recordStatus = document.getElementById("recordStatus") as HTMLDivElement
    reloadButton = document.getElementById("reloadButton") as HTMLButtonElement
    recordingCount = document.getElementById("recordingCount") as HTMLDivElement

    // キャプチャボタン
    capButton.addEventListener("click", getScreenShotAndDownload)

    // 録画ボタン
    startButton.addEventListener("click", start)

    // 停止ボタン
    stopButton.addEventListener("click", stop)

    // 録画リスト更新ボタン
    reloadButton.addEventListener("click", reload)

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

const insertRecordedMovie = async (
    chunk: {
        sessionId: string,
        chunkIndex: number,
        blob: Blob,
        imgUrl: string | null,
        createdAt: number,
        userName: string | null,
        title: string | null
    },
    insertPosition: "start" | "end" = "start" // ← "start"（左に追加）または "end"（右に追加）
) => {
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    const recordedMovie = document.createElement("div")
    recordedMovie.classList.add("recordedMovie")
    recordedMovie.setAttribute('sessionId', chunk.sessionId)
    recordedMovie.setAttribute('chunkIndex', chunk.chunkIndex.toString())

    // メイン画像
    const img = document.createElement("img")
    img.src = chunk.imgUrl || chrome.runtime.getURL("assets/images/defaultScreenshot.webp")
    // title属性を設定（作成日_ユーザー名_タイトルの形式）
    const formattedDate = formatDate(chunk.createdAt)
    const titleText = chunk.userName && chunk.title ? `${formattedDate} ${chunk.userName} ${chunk.title}` : 
                     chunk.userName ? `${formattedDate} ${chunk.userName}` :
                     chunk.title ? `${formattedDate} ${chunk.title}` :
                     formattedDate
    if (titleText) {
        img.title = titleText
    }
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
            await deleteChunkByKeys('Chunks', [[chunk.sessionId, chunk.chunkIndex]]) // indexedDBから削除
            // 録画数を更新
            const totalCount = await getChunksCount('Chunks')
            if (recordingCount) recordingCount.textContent = `${totalCount}`
            
            // 録画リストが空になった場合の処理
            const remainingRecordings = recordedMovieBox.querySelectorAll('.recordedMovie')
            if (remainingRecordings.length === 0) {
                recordedMovieBox.innerHTML = `<div class="no-video">録画リストはありません</div>`
            }
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
        downloadRecordedMovie([chunk.sessionId, chunk.chunkIndex])
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
    
    // 総録画数を取得して更新
    const totalCount = await getChunksCount('Chunks')
    if (recordingCount) recordingCount.textContent = `${totalCount}`
}

// モーダルを作成する関数
function createModal() {
    if (document.getElementById('video-modal')) return // すでに作成済みならスキップ

    // 録画リストの要素を取得
    const recordedMovieAria = document.getElementById('recordedMovieAria')
    if (!recordedMovieAria) return

    const modal = document.createElement('div')
    modal.id = 'video-modal'
    modal.innerHTML = `
      <div class="modal-content">
          <div class="modal-header">
              <span id="modal-user-name" class="modal-user-name"></span>
              <span id="close-modal" class="close">&times;</span>
          </div>
          <div class="modal-body">
              <video id="video-player" controls autoplay></video>
          </div>
          <div class="modal-footer">
              <span id="modal-title" class="modal-title"></span>
          </div>
      </div>
  `

    // 録画リストの要素にモーダルを追加
    recordedMovieAria.appendChild(modal)

    // 閉じるボタンの処理
    const closeButton = document.getElementById('close-modal')
    closeButton?.addEventListener('click', () => {
        modal.style.display = 'none'
        const video = document.getElementById('video-player') as HTMLVideoElement
        video.pause()
        video.src = '' // メモリ解放
    })

    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeButton?.click()
        }
    })

    // モーダル以外をクリックでモーダルを閉じる
    document.addEventListener('click', (event) => {
        const modal = document.getElementById('video-modal')
        if (modal && modal.style.display === 'block') {
            const modalContent = modal.querySelector('.modal-content')
            if (modalContent && !modalContent.contains(event.target as Node)) {
                closeButton?.click()
            }
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

        // ユーザー名とタイトルをモーダルに表示
        const userNameElement = document.getElementById('modal-user-name') as HTMLElement
        const titleElement = document.getElementById('modal-title') as HTMLElement
        
        if (userNameElement && chunk.userName) {
            const formattedDate = formatDate(chunk.createdAt)
            userNameElement.innerHTML = `<span class="modal-date">${formattedDate}</span> ${chunk.userName}`
        }
        if (titleElement && chunk.title) {
            titleElement.textContent = chunk.title
        }

        // クリックされたサムネイル要素を取得
        const clickedElement = (event.target as HTMLElement).closest('.recordedMovie') as HTMLElement
        if (!clickedElement) return

        // モーダルサイズを固定
        const modalWidth = 400
        const modalHeight = 300

        const modal = document.getElementById('video-modal') as HTMLElement
        const modalContent = modal.querySelector('.modal-content') as HTMLElement
        
        // モーダルサイズを設定
        modalContent.style.width = `${modalWidth}px`
        modalContent.style.height = `${modalHeight}px`
        
        modal.style.display = 'block'

        // サムネイルの位置を基準に相対的に配置
        const rect = clickedElement.getBoundingClientRect()
        
        // サムネイルの中心X座標を計算
        const thumbnailCenterX = rect.left + rect.width / 2
        
        // 録画リストの要素の位置を取得
        const recordedMovieAria = document.getElementById('recordedMovieAria')
        const ariaRect = recordedMovieAria?.getBoundingClientRect()
        
        if (!ariaRect) return
        
        // 録画リストの要素を基準とした相対位置を計算
        // サムネイルの中心X座標から録画リストの左端を引いて相対位置を算出
        let relativeX = thumbnailCenterX - ariaRect.left - modalWidth / 2
        
        // 境界チェック：左端からはみ出さないように
        if (relativeX < 10) {
            relativeX = 10
        }
        
        // 境界チェック：右端からはみ出さないように
        const maxX = ariaRect.width - modalWidth - 10
        if (relativeX > maxX) {
            relativeX = maxX
        }
        
        // 録画リストの要素を基準とした相対位置を設定
        modalContent.style.position = 'absolute'
        modalContent.style.left = `${relativeX}px`
        modalContent.style.top = `-${modalHeight + 45}px`
        modalContent.style.zIndex = '9999' // 他の要素に隠れないようにz-indexを設定
    } catch (error) {
        console.log('動画のロードに失敗しました:', error)
    }
}

// UIから動画サムネを削除
const deleteMovieIcon = async (deletedKeys: IDBValidKey[]) => {
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
    // 総録画数を取得して更新
    const totalCount = await getChunksCount('Chunks')
    if (recordingCount) recordingCount.textContent = `${totalCount}`
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
    const mm = minutes.toString().padStart(2, '0')
    const ss = seconds.toString().padStart(2, '0')
    const timeString = `${mm}:${ss}`
    return timeString
}

// 録画リストを読み込む共通関数
const loadRecordedMovieList = async (mode: 'latest' | 'all') => {
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    // 最初に無限スクロールを無効化（スクロールイベントを防ぐ）
    hasMoreOlder = false
    isLoadingOlder = false

    // ローディング表示を追加
    recordedMovieBox.innerHTML = `<div class="loading-spinner"></div>`

    try {
        let chunks: Array<{
            sessionId: string,
            chunkIndex: number,
            blob: Blob,
            imgUrl: string | null,
            createdAt: number,
            userName: string | null,
            title: string | null
        }> = []

        if (mode === 'latest') {
            // 最新の録画を取得（最初の20件のみ）
            chunks = await getLatestChunks('Chunks', CHUNKS_PER_LOAD)
        } else {
            // すべての録画を取得
            chunks = await getAllChunks('Chunks')
        }
        
        if (chunks.length === 0) {
            // データがなければメッセージ表示
            recordedMovieBox.innerHTML = `<div class="no-video">録画リストはありません</div>`
            // 録画数を0に更新
            if (recordingCount) recordingCount.textContent = '0'
            return
        }

        // 状態を初期化
        oldestLoadedTimestamp = Math.min(...chunks.map(chunk => chunk.createdAt))
        loadedChunksCount = chunks.length

        await new Promise(resolve => setTimeout(resolve, 500)) // 負荷軽減のため

        // 表示リセット
        recordedMovieBox.innerHTML = ""

        // 録画を表示（最新のものから右端に）
        if (mode === 'latest') {
            // 最新の録画は逆順で表示（新しいものを右端に）
            for (const chunk of chunks) {
                insertRecordedMovie(chunk, "start")

                // await new Promise(resolve => setTimeout(resolve, 20)) // 負荷軽減のため
            }
        } else {
            // 全件取得時は時系列順で表示（古いものを左端から、新しいものを右端に）
            for (const chunk of chunks.reverse()) {
                insertRecordedMovie(chunk, "start")

                await new Promise(resolve => setTimeout(resolve, 20)) // 負荷軽減のため
            }
        }

        // 総録画数を取得して更新
        const totalCount = await getChunksCount('Chunks')
        if (recordingCount) recordingCount.textContent = `${totalCount}`

        // 処理完了後に適切な状態に戻す
        if (mode === 'latest') {
            hasMoreOlder = chunks.length === CHUNKS_PER_LOAD // 20件取得できた場合は古い録画がある可能性
        } else {
            hasMoreOlder = false // 全件表示なので古い録画の読み込みは不要
        }

    } catch (error) {
        const errorMessage = mode === 'latest' ? '録画リストの初期化に失敗しました' : '録画リストの更新に失敗しました'
        console.error(errorMessage + ':', error)
        recordedMovieBox.innerHTML = `<div class="no-video">エラーが発生しました</div>`
        // エラー時も録画数を0に更新
        if (recordingCount) recordingCount.textContent = '0'
    }
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
        loadingIndicator.style.top = '40%'
        loadingIndicator.style.transform = 'translateY(-50%)'
        loadingIndicator.style.zIndex = '1000'
        box.appendChild(loadingIndicator)

        // 古い録画を取得
        const olderChunks = await getOlderChunks('Chunks', oldestLoadedTimestamp, CHUNKS_PER_LOAD)

        if (olderChunks.length === 0) {
            hasMoreOlder = false
        } else {
            // 現在のスクロール位置を記録
            const currentScrollLeft = box.scrollLeft
            
            // 古い録画を左端に追加
            for (const chunk of olderChunks) {
                insertRecordedMovie(chunk, "start")
                
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

export {
    insertRecordedMovieAria,
    insertRecordedMovie,
    createModal,
    confirmModal,
    openModalWithVideo,
    loadRecordedMovieList,
    deleteMovieIcon,
    setRecordingStatus,
    getTimeString
}