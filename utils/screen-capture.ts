// プレイヤーの表示部分を、タブの画面ごと録画するための映像を作る
// ゲーム・ギフト・運営からのお知らせなど、プレイヤーに表示されているものがすべて入る。
// 取り込み中のタブは裏に回っても Chrome が描画を続けるので、別のタブを見ている間も動いたまま録画される。
// Chrome の決まりで、ユーザーの操作（クリック）から呼ぶ必要があり、「このタブを共有」の確認が出る。
import { isFramePipelineSupported, getOutputSize, drawContain, createFramePipeline } from './frame-pipeline'

// Region Capture（要素の部分だけを切り出す）は TypeScript の型定義にないので宣言する
declare const CropTarget: { fromElement: (element: Element) => Promise<unknown> } | undefined
type CroppableTrack = MediaStreamTrack & { cropTo: (target: unknown) => Promise<void> }

// プレイヤーの表示部分（動画・コメント・ゲームなどの層をまとめた要素）
const PLAYER_SCREEN_SELECTOR = '[class*="___player-display-screen___"]'

type ScreenCapture = {
    stream: MediaStream // 切り出して描き直した映像と、タブの音声
    stop: () => void
}

const isScreenCaptureSupported = () =>
    typeof CropTarget !== 'undefined' && isFramePipelineSupported() && !!navigator.mediaDevices?.getDisplayMedia

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
        // プレイヤーの部分だけを切り出す（このタブ以外を取り込んでいる場合はここで失敗する）
        await (videoTrack as CroppableTrack).cropTo(await CropTarget!.fromElement(screen))

        // 全画面表示などでプレイヤーの大きさが変わっても、録画の解像度は変えない
        const { width, height } = getOutputSize(videoHeight, screen.getBoundingClientRect())
        const pipeline = createFramePipeline(videoTrack, width, height, (ctx, frame) => drawContain(ctx, frame, width, height))

        videoTrack.addEventListener('ended', onEnded, { once: true })

        return {
            stream: new MediaStream([pipeline.track, ...display.getAudioTracks()]),
            stop: () => {
                videoTrack.removeEventListener('ended', onEnded)
                pipeline.stop()
                display.getTracks().forEach(track => track.stop())
            },
        }
    } catch (error) {
        display.getTracks().forEach(track => track.stop())
        throw error
    }
}

export { isScreenCaptureSupported, startScreenCapture }
export type { ScreenCapture }
