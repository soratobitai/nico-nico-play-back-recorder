// 録画の画質の表し方（録画バーと録画一覧で同じにする）
import type { VideoSize } from './fmp4'
import type { SourceSize } from './library/db'

const sizeText = (size: VideoSize) => `${size.width}×${size.height}`

// 録画の映像の大きさ（size）と、録っている間の配信の映像の大きさ（sources。描き直して録った時だけ分かる）から、画質の表示を作る
// 配信と違う大きさに描き直して録った時（「1本の録画にそろえる」など）は、「288p→720p」のように配信の画質も出す
// （録画のファイルは 720p でも、元の配信の画質より細かくはならないので）。配信の画質が途中で変わった時は「288p/720p→720p」（低い順）
const describeQuality = (size: VideoSize, sources: readonly VideoSize[] = []) => {
    const distinct = [...new Map(sources.map(source => [sizeText(source), source])).values()]
        .sort((a, b) => a.height - b.height || a.width - b.width)
    if (!distinct.some(source => source.height !== size.height)) {
        return { label: `${size.height}p`, detail: sizeText(size) }
    }
    const way = distinct.every(source => source.height < size.height) ? '引き伸ばして'
        : distinct.every(source => source.height > size.height) ? '縮小して'
        : '描き直して'
    return {
        label: `${[...new Set(distinct.map(source => `${source.height}p`))].join('/')}→${size.height}p`,
        detail: `${sizeText(size)}（配信の ${distinct.map(sizeText).join('・')} を${way}録画）`,
    }
}

// 配信の画質の表示から除く、短い間だけだった配信の大きさ（秒）
// （ニコ生は番組を開いた直後の数秒だけ画質が低いので、そのたびに「288p/720p→720p」と出ないように）
const MIN_SOURCE_SECONDS = 10

// 配信の映像の大きさを、大きさごとに録った長さを合わせて、短い間だけだったものを除く（どれも短ければ、最も長いものを残す）
const mainSources = (sources: readonly SourceSize[]): VideoSize[] => {
    const merged = new Map<string, SourceSize>()
    for (const source of sources) {
        const same = merged.get(sizeText(source))
        if (same) same.seconds += source.seconds
        else merged.set(sizeText(source), { ...source })
    }
    const all = [...merged.values()]
    const long = all.filter(source => source.seconds >= MIN_SOURCE_SECONDS)
    return long.length > 0 ? long : all.sort((a, b) => b.seconds - a.seconds).slice(0, 1)
}

export { describeQuality, mainSources, MIN_SOURCE_SECONDS }
