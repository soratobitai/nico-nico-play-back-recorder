// 見直し用の時間軸
// 番組の録画（区間ごとの断片）を、1本の動画の時間軸（秒）に並べる。
// - 続けて録った区間（間が短い）は、録った時刻のとおりに並べる（間はそのまま空く）
// - 録っていない時間が長く空いた区間（ページを開き直した など）は、前の区間の続きに詰めて並べる
// 一度並べた区間の位置は変えない（再生用に読み込んだ部分と食い違わないように）。
import type { RecordingKind, TimelineFragment, TimelineSegment } from '../library/db'

// これより短い間は、録った時刻のとおりに空けて並べる（再生時は飛ばす）
const MAX_CONTINUOUS_GAP_SECONDS = 10
// これより大きく前の区間と重なる区間は、別のタブで同時に録っていたものなので並べない
const MAX_OVERLAP_SECONDS = 2

type PlacedFragment = TimelineFragment & {
    segmentId: string
    start: number // 時間軸の上の開始（秒）
    end: number
}

type PlacedSegment = {
    segmentId: string
    kind: RecordingKind
    mimeType: string
    startedAt: number
    endedAt: number | null
    init: Blob
    // 時間軸の上の時刻 = 区間の中の時刻 + offset（SourceBuffer.timestampOffset に使う）。断片が届くまでは null
    offset: number | null
    fragments: PlacedFragment[] // index の順
}

type SegmentInput = Omit<TimelineSegment, 'fragments'> & { fragments?: TimelineFragment[] }

const fragmentKey = (fragment: { segmentId: string, index: number }) => `${fragment.segmentId}:${fragment.index}`

// 区間の最後の断片の終わりを、録った時刻（ミリ秒）で
const wallEndOf = (segment: PlacedSegment) => {
    const last = segment.fragments[segment.fragments.length - 1]
    return last ? segment.startedAt + (last.startTime + last.duration) * 1000 : segment.startedAt
}

class Timeline {
    private segments: PlacedSegment[] = []
    private flat: PlacedFragment[] = [] // 時間軸の順に並べた断片

    // 並べた区間（再生に使う）
    get placedSegments(): readonly PlacedSegment[] {
        return this.segments.filter(s => s.offset !== null)
    }

    get fragments(): readonly PlacedFragment[] {
        return this.flat
    }

    get isEmpty() {
        return this.flat.length === 0
    }

    get start() {
        return this.flat[0]?.start ?? 0
    }

    get end() {
        return this.flat.length ? Math.max(...this.flat.slice(-3).map(f => f.end)) : 0
    }

    segment(segmentId: string) {
        return this.segments.find(s => s.segmentId === segmentId)
    }

    // 保存先から読んだ番組の録画で更新する。新しい区間は後ろに足し、消された断片・区間は外す
    sync(inputs: TimelineSegment[]) {
        const ids = new Set(inputs.map(s => s.segmentId))
        this.segments = this.segments.filter(s => ids.has(s.segmentId) || s.endedAt === null)
        for (const input of [...inputs].sort((a, b) => a.startedAt - b.startedAt)) {
            const existing = this.segment(input.segmentId)
            if (!existing) {
                this.addSegment(input)
                continue
            }
            existing.endedAt = input.endedAt
            // 保存先にない古い断片は消されたもの。保存先にまだない新しい断片（録画中に届いたもの）は残す
            const stored = new Map(input.fragments.map(f => [f.index, f]))
            const maxStored = Math.max(-1, ...stored.keys())
            existing.fragments = existing.fragments.filter(f => stored.has(f.index) || f.index > maxStored)
            this.appendFragments(existing, input.fragments.filter(f => !existing.fragments.some(e => e.index === f.index)))
        }
        this.rebuild()
    }

    // 区間を足す（録画を始めた順に足すこと。それより前に始まった区間は並べられないので足さない）
    addSegment(input: SegmentInput) {
        if (this.segment(input.segmentId)) return
        const last = this.segments[this.segments.length - 1]
        if (last && input.startedAt < last.startedAt) return
        const segment: PlacedSegment = {
            segmentId: input.segmentId, kind: input.kind, mimeType: input.mimeType,
            startedAt: input.startedAt, endedAt: input.endedAt, init: input.init, offset: null, fragments: [],
        }
        this.segments.push(segment)
        this.appendFragments(segment, input.fragments ?? [])
        this.rebuild()
    }

    addFragments(segmentId: string, fragments: TimelineFragment[]) {
        const segment = this.segment(segmentId)
        if (!segment) return
        this.appendFragments(segment, fragments.filter(f => !segment.fragments.some(e => e.index === f.index)))
        this.rebuild()
    }

    finishSegment(segmentId: string, endedAt: number) {
        const segment = this.segment(segmentId)
        if (!segment) return
        segment.endedAt = endedAt
        if (segment.fragments.length === 0) this.segments = this.segments.filter(s => s !== segment)
        this.rebuild()
    }

    // 読もうとした断片が消されていた
    removeFragment(segmentId: string, index: number) {
        const segment = this.segment(segmentId)
        if (!segment) return
        segment.fragments = segment.fragments.filter(f => f.index !== index)
        this.rebuild()
    }

    // 時刻 t を含む断片の位置。t が間（録っていない時間）にあれば次の断片、最後より後なら最後の断片。断片がなければ -1
    indexAt(t: number) {
        const flat = this.flat
        if (flat.length === 0) return -1
        let lo = 0
        let hi = flat.length - 1
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (flat[mid].end <= t) lo = mid + 1
            else hi = mid
        }
        return lo
    }

    // 時刻 t に映っているものを録った時刻（ミリ秒）
    wallClockAt(t: number): number | null {
        const i = this.indexAt(t)
        if (i < 0) return null
        const fragment = this.flat[i]
        const segment = this.segment(fragment.segmentId)!
        const clamped = Math.min(Math.max(t, fragment.start), fragment.end)
        return segment.startedAt + (clamped - segment.offset!) * 1000
    }

    // 録った時刻（ミリ秒）に映っているものの、時間軸の上の時刻。録っていない時間なら次に録った時刻、
    // 最後より後なら終わり。断片がなければ null（別の種類の録画に切り替えた時に、同じ場面から見るために使う）
    timeAtWallClock(wallClock: number): number | null {
        if (this.flat.length === 0) return null
        for (const fragment of this.flat) {
            const segment = this.segment(fragment.segmentId)!
            const wallStart = segment.startedAt + fragment.startTime * 1000
            const wallEnd = wallStart + fragment.duration * 1000
            if (wallClock < wallEnd) return fragment.start + Math.max(0, wallClock - wallStart) / 1000
        }
        return this.end
    }

    private appendFragments(segment: PlacedSegment, fragments: TimelineFragment[]) {
        if (fragments.length === 0) return
        const sorted = [...fragments].sort((a, b) => a.index - b.index)
        if (segment.offset === null && !this.place(segment, sorted[0])) return
        for (const fragment of sorted) {
            const start = fragment.startTime + segment.offset!
            segment.fragments.push({ ...fragment, segmentId: segment.segmentId, start, end: start + fragment.duration })
        }
        segment.fragments.sort((a, b) => a.index - b.index)
    }

    // 区間の最初の断片が届いた時に、時間軸の上の位置を決める。並べられなければ false（区間を外す）
    private place(segment: PlacedSegment, first: TimelineFragment) {
        const previous = this.segments.slice(0, this.segments.indexOf(segment)).reverse().find(s => s.offset !== null && s.fragments.length > 0)
        if (!previous) {
            segment.offset = -first.startTime
            return true
        }
        const gapSeconds = (segment.startedAt + first.startTime * 1000 - wallEndOf(previous)) / 1000
        if (gapSeconds < -MAX_OVERLAP_SECONDS) {
            this.segments = this.segments.filter(s => s !== segment)
            return false
        }
        if (gapSeconds <= MAX_CONTINUOUS_GAP_SECONDS) {
            // 録った時刻のとおりに並べる
            segment.offset = previous.offset! + (segment.startedAt - previous.startedAt) / 1000
        } else {
            // 前の区間の終わりに詰める
            const previousEnd = Math.max(...previous.fragments.map(f => f.end))
            segment.offset = previousEnd - first.startTime
        }
        return true
    }

    private rebuild() {
        this.flat = this.segments
            .filter(s => s.offset !== null)
            .flatMap(s => s.fragments)
            .sort((a, b) => a.start - b.start)
    }
}

type BufferPlan = {
    append: PlacedFragment[] // 読み込む断片（この順に）
    removeBefore: number | null // これより前を捨てる（断片の境目）
    removeFrom: number | null // これより後を捨てる（断片の境目）
}

type BufferWindow = { ahead: number, keepBehind: number, keepAhead: number }

// 再生位置 t のまわりで、読み込む断片と捨てる範囲を決める
// - t から ahead 秒先までの断片を読み込む（読み込み済みのものは除く）
// - キーフレームから始まらない断片を飛び飛びに読み込む時は、キーフレームの断片までさかのぼって読み込む
// - t より keepBehind 秒以上前と、keepAhead 秒以上先は捨てる
const planBuffer = (timeline: Timeline, t: number, appended: ReadonlySet<string>, window: BufferWindow): BufferPlan => {
    const flat = timeline.fragments
    const at = timeline.indexAt(t)
    if (at < 0) return { append: [], removeBefore: null, removeFrom: null }

    const isPrevious = (a: PlacedFragment, b: PlacedFragment) => a.segmentId === b.segmentId && a.index === b.index - 1
    const chosen = new Set<string>()
    const append: PlacedFragment[] = []
    for (let i = at; i < flat.length && flat[i].start < t + window.ahead; i++) {
        const fragment = flat[i]
        if (appended.has(fragmentKey(fragment)) || chosen.has(fragmentKey(fragment))) continue
        // 直前の断片から続けて読み込まないなら、キーフレームまでさかのぼる
        const lead: PlacedFragment[] = []
        let j = i
        while (!flat[j].keyframe && j > 0 && isPrevious(flat[j - 1], flat[j])
            && !appended.has(fragmentKey(flat[j - 1])) && !chosen.has(fragmentKey(flat[j - 1]))) {
            j--
            lead.unshift(flat[j])
        }
        for (const f of [...lead, fragment]) {
            chosen.add(fragmentKey(f))
            append.push(f)
        }
    }

    const behind = timeline.indexAt(t - window.keepBehind)
    const removeBefore = behind > 0 && flat[behind].start < t ? flat[behind].start : null
    const aheadIndex = flat.findIndex(f => f.start >= t + window.keepAhead)
    const removeFrom = aheadIndex >= 0 ? flat[aheadIndex].start : null
    return { append, removeBefore, removeFrom }
}

export { Timeline, planBuffer, fragmentKey }
export type { PlacedFragment, PlacedSegment, BufferPlan, BufferWindow }
