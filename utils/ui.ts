import { listSegments, countSegments, deleteSegments, getSegmentFile } from "./library/api"
import type { SegmentSummary } from "./library/db"
import { downloadSegment, getScreenShotAndDownload, formatDate } from "../utils/feature"
import { UI_COLLAPSED } from "../utils/storage"

let capButton = null as HTMLButtonElement | null
let startButton = null as HTMLButtonElement | null
let stopButton = null as HTMLButtonElement | null
let recordStatus = null as HTMLDivElement | null
let reloadButton = null as HTMLButtonElement | null
let recordingCount = null as HTMLDivElement | null
let screenCaptureButton = null as HTMLButtonElement | null

let userScrolledAway = false

// 無限スクロール用の状態管理
let isLoadingOlder = false
let hasMoreOlder = true
let oldestLoadedTimestamp = Infinity
const CHUNKS_PER_LOAD = 20
const CHUNK_WIDTH = 102 // 固定幅（90px + 左右ボーダー2px + margin 10px）

// 折りたたみ状態管理
let isCollapsed = false
let toggleButton: HTMLButtonElement | null = null

const insertRecordedMovieAria = async (
    start: () => void,
    stop: () => void,
    reload: () => void,
    showSettings: () => void,
    toggleScreenCapture: (() => void) | null, // 画面ごと録画を使えない環境では null（ボタンを表示しない）
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
              <div class="control-buttons-left">
                <div class="reload-button" id="reloadButton" title="録画リスト更新">
                    <img src="${chrome.runtime.getURL("assets/images/refresh.svg")}" alt="更新" />
                </div>
                <div class="recording-info">
                    <span style="color: #aaa; font-size: 11px;"><span id="recordingCount" style="font-size: 13px;">0</span></span>
                </div>
              </div>
              <div class="control-buttons-right">
                <button type="button" id="screenCaptureButton" hidden>画面録画</button>
                <div class="settings-button" id="settingsButton" title="設定">
                  <img src="${chrome.runtime.getURL("assets/images/settings.svg")}" alt="設定" />
                </div>
              </div>
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

    // 設定ボタン
    const settingsButton = document.getElementById("settingsButton") as HTMLButtonElement
    settingsButton.addEventListener("click", showSettings)

    // 画面ごと録画ボタン
    screenCaptureButton = document.getElementById("screenCaptureButton") as HTMLButtonElement
    if (toggleScreenCapture) {
        screenCaptureButton.hidden = false
        screenCaptureButton.addEventListener("click", toggleScreenCapture)
        setScreenCaptureButton(false)
    }

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

// 録画数の表示を更新する
const updateRecordingCount = async () => {
    try {
        const totalCount = await countSegments()
        if (recordingCount) recordingCount.textContent = `${totalCount}`
    } catch (error) {
        console.log('録画数を取得できませんでした:', error)
    }
}

const findSegmentItem = (segmentId: string) =>
    Array.from(document.querySelectorAll<HTMLElement>('.recordedMovie')).find(element => element.dataset.segmentId === segmentId)

// 録画（区間）をリストに追加する。同じ区間が既にあれば置き換える（録画中に表示した区間が録画を終えた時など）
const insertRecordedMovie = (
    segment: SegmentSummary,
    insertPosition: "start" | "end" = "start" // ← "start"（左に追加）または "end"（右に追加）
) => {
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    const recordedMovie = document.createElement("div")
    recordedMovie.classList.add("recordedMovie")
    recordedMovie.dataset.segmentId = segment.segmentId
    recordedMovie.dataset.startedAt = segment.startedAt.toString()

    // メイン画像
    const img = document.createElement("img")
    img.src = segment.thumbnail || chrome.runtime.getURL("assets/images/defaultScreenshot.webp")
    // title属性を設定（録画開始日時 ユーザー名 タイトルの形式）
    img.title = [formatDate(segment.startedAt), segment.userName, segment.title].filter(Boolean).join(' ')
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
            await deleteSegments([segment.segmentId]) // 保存先から削除
            await updateRecordingCount()

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
        downloadSegment(segment.segmentId)
    })
    recordedMovie.appendChild(downloadButton)

    // クリックでモーダルを開く（サムネイルの縁をクリックした場合も）
    recordedMovie.addEventListener('click', () => {
        openModalWithVideo(segment.segmentId, recordedMovie)
    })

    // .no-video があれば、取り除く
    const noVideo = recordedMovieBox.querySelector('.no-video')
    if (noVideo) noVideo.remove()

    const existing = findSegmentItem(segment.segmentId)
    if (existing) {
        existing.replaceWith(recordedMovie)
    } else if (insertPosition === "start") {
        // UIに追加（右端 or 左端）
        recordedMovieBox.prepend(recordedMovie)
        recordedMovieBox.scrollLeft = recordedMovieBox.scrollWidth
    } else {
        // 録画を始めた時刻の順の位置に入れる
        const next = Array.from(recordedMovieBox.querySelectorAll<HTMLElement>('.recordedMovie'))
            .find(element => Number(element.dataset.startedAt) > segment.startedAt)
        recordedMovieBox.insertBefore(recordedMovie, next ?? null)

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
        setModalVideo(video, null) // メモリ解放
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


// モーダルで再生中の動画の Object URL（差し替える時・閉じる時に解放する）
let modalVideoUrl: string | null = null

const setModalVideo = (video: HTMLVideoElement, blob: Blob | null) => {
    if (modalVideoUrl) URL.revokeObjectURL(modalVideoUrl)
    modalVideoUrl = blob ? URL.createObjectURL(blob) : null

    if (modalVideoUrl) {
        video.src = modalVideoUrl
    } else {
        // src に '' を入れるとページの URL を動画として読みに行くので、属性ごと外す
        video.removeAttribute('src')
        video.load()
    }
}

// 動画を取得してモーダルを開く
const openModalWithVideo = async (segmentId: string, clickedElement: HTMLElement) => {
    try {
        // 録画中の区間も、その時点までを再生できる
        const { blob, segment } = await getSegmentFile(segmentId)

        const video = document.getElementById('video-player') as HTMLVideoElement
        setModalVideo(video, blob)

        // 日付・ユーザー名とタイトルをモーダルに表示（前に開いた動画の表示が残らないように毎回書き換える）
        const userNameElement = document.getElementById('modal-user-name')
        const titleElement = document.getElementById('modal-title')

        if (userNameElement) {
            const dateElement = document.createElement('span')
            dateElement.className = 'modal-date'
            dateElement.textContent = formatDate(segment.startedAt)
            userNameElement.replaceChildren(dateElement, ` ${segment.userName}`)
        }
        if (titleElement) {
            titleElement.textContent = segment.title
        }

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

// 消された録画（区間）をリストから取り除く
const removeSegmentItems = async (segmentIds: string[]) => {
    for (const segmentId of segmentIds) findSegmentItem(segmentId)?.remove()
    await updateRecordingCount()
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

// 録画リストを読み込む（最新の CHUNKS_PER_LOAD 件。それより古いものは左へスクロールした時に読み込む）
const loadRecordedMovieList = async () => {
    const recordedMovieBox = document.querySelector('.recordedMovieBox') as HTMLElement | null
    if (!recordedMovieBox) return

    // 最初に無限スクロールを無効化（スクロールイベントを防ぐ）
    hasMoreOlder = false
    isLoadingOlder = false

    // ローディング表示を追加
    recordedMovieBox.innerHTML = `<div class="loading-spinner"></div>`

    try {
        // 最新の録画を取得（新しい順）
        const segments = await listSegments(CHUNKS_PER_LOAD)

        if (segments.length === 0) {
            // データがなければメッセージ表示
            recordedMovieBox.innerHTML = `<div class="no-video">録画リストはありません</div>`
            // 録画数を0に更新
            if (recordingCount) recordingCount.textContent = '0'
            return
        }

        // 状態を初期化
        oldestLoadedTimestamp = Math.min(...segments.map(segment => segment.startedAt))

        await new Promise(resolve => setTimeout(resolve, 500)) // 負荷軽減のため

        // 表示リセット
        recordedMovieBox.innerHTML = ""

        // 新しい順に左端へ追加していき、新しいものが右端に来るようにする
        for (const segment of segments) {
            insertRecordedMovie(segment, "start")
        }

        // 総録画数を取得して更新
        await updateRecordingCount()

        // 処理完了後に適切な状態に戻す
        hasMoreOlder = segments.length === CHUNKS_PER_LOAD // 20件取得できた場合は古い録画がある可能性

    } catch (error) {
        console.error('録画リストの読み込みに失敗しました:', error)
        recordedMovieBox.innerHTML = `<div class="no-video">エラーが発生しました</div>`
        // エラー時も録画数を0に更新
        if (recordingCount) recordingCount.textContent = '0'
    }
}

// 古い録画を読み込む関数
const loadOlderRecordings = async () => {
    if (isLoadingOlder || !hasMoreOlder) return

    // 読み込み中フラグを立てる前に確認する（立てたまま戻ると、以後読み込めなくなる）
    const box = document.querySelector('.recordedMovieBox') as HTMLElement
    if (!box) return
    isLoadingOlder = true

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
        const olderSegments = await listSegments(CHUNKS_PER_LOAD, oldestLoadedTimestamp)

        if (olderSegments.length === 0) {
            hasMoreOlder = false
        } else {
            // 現在のスクロール位置を記録
            const currentScrollLeft = box.scrollLeft

            // 古い録画を左端に追加
            for (const segment of olderSegments) {
                insertRecordedMovie(segment, "start")

                // タイムスタンプを更新
                if (segment.startedAt < oldestLoadedTimestamp) {
                    oldestLoadedTimestamp = segment.startedAt
                }
            }

            // スクロール位置を調整（固定幅で計算）
            const addedWidth = olderSegments.length * CHUNK_WIDTH
            box.scrollLeft = currentScrollLeft + addedWidth
        }

        // ローディングインジケーターを削除
        loadingIndicator.remove()
    } catch (error) {
        console.error('古い録画の読み込みに失敗しました:', error)
    } finally {
        isLoadingOlder = false
    }
}

// 折りたたみボタンを作成・初期化
const insertToggleButton = async (onOpen?: () => void | Promise<void>) => {
    // 既にボタンが存在する場合はスキップ
    if (document.getElementById('recording-toggle-button')) return

    // addon-controller要素を探す
    const addonController = document.querySelector('[class*="addon-controller"]') as HTMLElement
    if (!addonController) return

    // 保存された折りたたみ状態を読み込む
    isCollapsed = await UI_COLLAPSED.getValue()

    // ボタンを作成
    toggleButton = document.createElement('button')
    toggleButton.id = 'recording-toggle-button'
    toggleButton.className = 'recording-toggle-button'
    toggleButton.type = 'button'
    toggleButton.setAttribute('aria-label', 'ニコ生プレイバックレコーダー')
    toggleButton.textContent = '■' // 初期値は青い■
    toggleButton.style.color = '#3b82f6' // 青色

    // 初期状態を反映
    const recordedMovieAria = document.getElementById('recordedMovieAria')
    if (recordedMovieAria) {
        recordedMovieAria.style.display = isCollapsed ? 'none' : 'block'
    }

    // クリックイベント
    toggleButton.addEventListener('click', async () => {
        const previousCollapsed = isCollapsed
        isCollapsed = !isCollapsed
        const recordedMovieAria = document.getElementById('recordedMovieAria')
        if (recordedMovieAria) {
            recordedMovieAria.style.display = isCollapsed ? 'none' : 'block'
        }
        // 状態をストレージに保存
        await UI_COLLAPSED.setValue(isCollapsed)
        
        // UIが閉じていた状態から開いた状態になった時にコールバックを実行
        if (previousCollapsed && !isCollapsed && onOpen) {
            await onOpen()
        }
    })

    // 右端に挿入
    addonController.appendChild(toggleButton)
}

// UIが開いているかどうかを取得する関数
const isUICollapsed = () => {
    return isCollapsed
}

// 録画状態に応じてボタンの表示を更新
const updateToggleButton = (isRecording: boolean) => {
    if (!toggleButton) return

    if (isRecording) {
        // 録画中: 赤い●
        toggleButton.textContent = '🔴'
        toggleButton.style.color = '#ef4444' // 赤色
    } else {
        // 録画していない: 青い■
        toggleButton.textContent = '■'
        toggleButton.style.color = '#3b82f6' // 青色
    }
}

// 画面ごと録画ボタンの表示を更新
function setScreenCaptureButton(active: boolean) {
    if (!screenCaptureButton) return
    screenCaptureButton.classList.toggle('active', active)
    screenCaptureButton.textContent = active ? '画面録画中' : '画面録画'
    screenCaptureButton.title = active
        ? 'クリックすると、画面ごと録画をやめて通常の録画に戻ります。'
        : 'ゲームやギフトも含めて、プレイヤーの画面ごと録画します。「このタブを共有」の許可が必要です。'
}

export {
    insertRecordedMovieAria,
    insertRecordedMovie,
    createModal,
    confirmModal,
    openModalWithVideo,
    loadRecordedMovieList,
    removeSegmentItems,
    updateRecordingCount,
    setRecordingStatus,
    setScreenCaptureButton,
    getTimeString,
    insertToggleButton,
    updateToggleButton,
    isUICollapsed
}