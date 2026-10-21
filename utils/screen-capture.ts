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
// 縦のスクロールバーがコマに写っているかは環境で違うので、コマの縦横比に近い方の幅を表示領域の幅とする。
// 表示領域からはみ出した所（スクロールした時など）も含めた、要素全体の位置を返す。コマの外の部分は、描く時に
// 切り詰められて黒のまま残る（はみ出した分を除いて返すと、見えている部分だけが拡大されて、録画の中で映像がずれるため）
const regionInFrame = (frame: { width: number, height: number }, rect: { x: number, y: number, width: number, height: number }, viewport: Viewport): FrameRegion => {
    const aspect = frame.width / frame.height
    const viewportWidth = Math.abs(viewport.innerWidth / viewport.innerHeight - aspect) <= Math.abs(viewport.clientWidth / viewport.innerHeight - aspect)
        ? viewport.innerWidth
        : viewport.clientWidth
    const scaleX = frame.width / viewportWidth
    const scaleY = frame.height / viewport.innerHeight
    return { x: rect.x * scaleX, y: rect.y * scaleY, width: rect.width * scaleX, height: rect.height * scaleY }
}

const measureViewport = (): Viewport => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: document.documentElement.clientWidth })

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

        // プレイヤーの位置と表示領域の大きさ（全画面表示・シアターモード・スクロールなどで変わったら測り直す。
        // 大きさが変わらずに位置だけ動いた時のために、1秒ごとにも測る。コマごとに測ると、そのたびに
        // ページのレイアウトを計算させて重いので、測っておいた値で描く）
        // プレイヤーが作り直されていたら、探し直す
        let player = screen
        let rect = player.getBoundingClientRect()
        let viewport = measureViewport()
        const measure = () => {
            if (!player.isConnected) {
                const found = document.querySelector(PLAYER_SCREEN_SELECTOR)
                if (found) {
                    resizeObserver.unobserve(player)
                    player = found
                    resizeObserver.observe(player)
                }
            }
            rect = player.getBoundingClientRect()
            viewport = measureViewport()
        }
        const resizeObserver = new ResizeObserver(measure)

        // 全画面表示などでプレイヤーの大きさが変わっても、録画の解像度は変えない
        const { width, height } = getOutputSize(videoHeight, rect)
        const pipeline = createFramePipeline(videoTrack, width, height, (ctx, frame) => drawContain(ctx, frame, width, height, regionInFrame(
            { width: frame.displayWidth, height: frame.displayHeight },
            rect,
            viewport,
        )))

        // 測り直しは、描き直しを作れてから始める（作れずに例外になった時に、残らないように）
        resizeObserver.observe(player)
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, { capture: true, passive: true })
        const measureTimer = setInterval(measure, 1000)

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
