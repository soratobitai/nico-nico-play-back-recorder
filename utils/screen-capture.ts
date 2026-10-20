// プレイヤーの表示部分を、タブの画面ごと録画するための映像を作る
// ゲーム・ギフト・運営からのお知らせなど、プレイヤーに表示されているものがすべて入る。
// 取り込み中のタブは裏に回っても Chrome が描画を続けるので、別のタブを見ている間も動いたまま録画される。
// Chrome の決まりで、ユーザーの操作（クリック）から呼ぶ必要があり、「このタブを共有」の確認が出る。
// プレイヤーの部分は、タブ全体のコマから、プレイヤーの位置を切り出して描く
// （Region Capture（cropTo）で切り出すと、環境によってコマが1枚も届かず、音声だけの録画になることがあった）
import { isFramePipelineSupported, getOutputSize, drawContain, createFramePipeline, type FrameRegion } from './frame-pipeline'

// プレイヤーの表示部分（動画・コメント・ゲームなどの層をまとめた要素）
const PLAYER_SCREEN_SELECTOR = '[class*="___player-display-screen___"]'

type ScreenCapture = {
    stream: MediaStream // 切り出して描き直した映像と、タブの音声
    stop: () => void
}

const isScreenCaptureSupported = () =>
    isFramePipelineSupported() && !!navigator.mediaDevices?.getDisplayMedia

type Viewport = { innerWidth: number, innerHeight: number, clientWidth: number }

// タブ全体のコマの中で、要素（rect はページの表示領域の中の位置）が写っている所
// コマはタブの表示領域を写したもの（画面の拡大率などで、大きさは表示領域の CSS の大きさとは違う）。
// 縦のスクロールバーがコマに写っているかは環境で違うので、コマの縦横比に近い方の幅を表示領域の幅とする
const regionInFrame = (frame: { width: number, height: number }, rect: { x: number, y: number, width: number, height: number }, viewport: Viewport): FrameRegion => {
    const aspect = frame.width / frame.height
    const viewportWidth = Math.abs(viewport.innerWidth / viewport.innerHeight - aspect) <= Math.abs(viewport.clientWidth / viewport.innerHeight - aspect)
        ? viewport.innerWidth
        : viewport.clientWidth
    const scaleX = frame.width / viewportWidth
    const scaleY = frame.height / viewport.innerHeight
    // 表示領域からはみ出した所は写っていないので、写っている所だけにする
    const left = Math.max(0, rect.x * scaleX)
    const top = Math.max(0, rect.y * scaleY)
    const right = Math.min(frame.width, (rect.x + rect.width) * scaleX)
    const bottom = Math.min(frame.height, (rect.y + rect.height) * scaleY)
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

// 画面ごと録画を始める。共有の確認でキャンセルされた場合や、この環境で使えない場合は例外になる
// onEnded は、Chrome の「共有を停止」などで取り込みが終わった時に呼ばれる（stop() では呼ばれない）
const startScreenCapture = async (videoHeight: number, onEnded: () => void): Promise<ScreenCapture> => {
    const screen = document.querySelector(PLAYER_SCREEN_SELECTOR)
    if (!screen) throw new Error('プレイヤーが見つかりません')
    if (!isScreenCaptureSupported()) throw new Error('この環境では画面ごと録画できません')

    const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true, // タブの音声（ギフトの効果音なども入る）
        preferCurrentTab: true, // このタブを共有するかだけを確認する
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
    } as DisplayMediaStreamOptions)

    try {
        const [videoTrack] = display.getVideoTracks()
        // このタブ以外（他のタブ・ウィンドウ・画面全体）を選ばれた時は、プレイヤーを切り出せないので使わない
        const surface = (videoTrack.getSettings() as { displaySurface?: string }).displaySurface
        if (surface && surface !== 'browser') throw new Error('このタブ以外が選ばれました')

        // プレイヤーの位置（全画面表示・シアターモード・スクロールなどで変わったら測り直す。
        // 大きさが変わらずに位置だけ動いた時のために、1秒ごとにも測る）
        let rect = screen.getBoundingClientRect()
        const measure = () => { rect = screen.getBoundingClientRect() }
        const resizeObserver = new ResizeObserver(measure)
        resizeObserver.observe(screen)
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, { capture: true, passive: true })
        const measureTimer = setInterval(measure, 1000)

        // 全画面表示などでプレイヤーの大きさが変わっても、録画の解像度は変えない
        const { width, height } = getOutputSize(videoHeight, rect)
        const pipeline = createFramePipeline(videoTrack, width, height, (ctx, frame) => drawContain(ctx, frame, width, height, regionInFrame(
            { width: frame.displayWidth, height: frame.displayHeight },
            rect,
            { innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: document.documentElement.clientWidth },
        )))

        videoTrack.addEventListener('ended', onEnded, { once: true })

        return {
            stream: new MediaStream([pipeline.track, ...display.getAudioTracks()]),
            stop: () => {
                videoTrack.removeEventListener('ended', onEnded)
                resizeObserver.disconnect()
                clearInterval(measureTimer)
                window.removeEventListener('resize', measure)
                window.removeEventListener('scroll', measure, { capture: true })
                pipeline.stop()
                display.getTracks().forEach(track => track.stop())
            },
        }
    } catch (error) {
        display.getTracks().forEach(track => track.stop())
        throw error
    }
}

export { isScreenCaptureSupported, startScreenCapture, regionInFrame }
export type { ScreenCapture }
