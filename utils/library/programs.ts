// 録画一覧のページで、録画（区間）を番組ごとにまとめる
import type { RecordingKind, SegmentSummary } from './db'

type ProgramSummary = {
    key: string // 番組を見分ける（以前のバージョンから移した録画は、配信者とタイトルで見分ける）
    programId: string
    title: string
    userName: string
    startedAt: number // 最初に録り始めた時刻
    endedAt: number // 最後に録り終えた時刻（録画中なら、今のところの終わり）
    recording: boolean // 録画中の区間がある
    segments: SegmentSummary[] // 始めた順
    kinds: RecordingKind[]
    bytes: number
    bytesByKind: Record<RecordingKind, number>
}

const KIND_ORDER: RecordingKind[] = ['video', 'comments', 'screen']

// 以前のバージョンから移した録画は番組が分からないので、配信者とタイトルで見分ける
const programKeyOf = (segment: Pick<SegmentSummary, 'programId' | 'title' | 'userName'>) =>
    segment.programId === 'legacy' ? `legacy:${segment.userName}:${segment.title}` : segment.programId

const segmentEnd = (segment: SegmentSummary) => segment.endedAt ?? segment.startedAt + segment.duration * 1000

// 区間を番組ごとにまとめる。最近録った番組から順に並べる
const summarizePrograms = (segments: SegmentSummary[]): ProgramSummary[] => {
    const programs = new Map<string, ProgramSummary>()
    for (const segment of [...segments].sort((a, b) => a.startedAt - b.startedAt)) {
        const key = programKeyOf(segment)
        let program = programs.get(key)
        if (!program) {
            program = {
                key, programId: segment.programId, title: segment.title, userName: segment.userName,
                startedAt: segment.startedAt, endedAt: segmentEnd(segment), recording: false,
                segments: [], kinds: [], bytes: 0, bytesByKind: { video: 0, comments: 0, screen: 0 },
            }
            programs.set(key, program)
        }
        program.segments.push(segment)
        program.endedAt = Math.max(program.endedAt, segmentEnd(segment))
        program.recording ||= segment.endedAt === null
        program.bytes += segment.bytes
        program.bytesByKind[segment.kind] += segment.bytes
        // タイトルが変わった場合（番組の途中でタイトルが変わった など）は、新しい方を使う
        if (segment.title) program.title = segment.title
        if (segment.userName) program.userName = segment.userName
    }
    for (const program of programs.values()) {
        program.kinds = KIND_ORDER.filter(kind => program.segments.some(s => s.kind === kind))
    }
    return [...programs.values()].sort((a, b) => b.endedAt - a.endedAt)
}

// 番組を、検索の言葉（タイトル・配信者）と種類で絞り込む
const filterPrograms = (programs: ProgramSummary[], query: string, kind: RecordingKind | null) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return programs.filter((program) => {
        if (kind && !program.kinds.includes(kind)) return false
        const text = `${program.title} ${program.userName}`.toLowerCase()
        return words.every(word => text.includes(word))
    })
}

// 録った日ごとにまとめる（見出しは「今日」「昨日」「10月18日（土）」）
const groupByDay = (programs: ProgramSummary[], now = new Date()) => {
    const dayKey = (time: number) => new Date(time).toDateString()
    const today = now.toDateString()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString()
    const groups: { label: string, programs: ProgramSummary[] }[] = []
    for (const program of programs) {
        const key = dayKey(program.endedAt)
        const date = new Date(program.endedAt)
        const label = key === today ? '今日'
            : key === yesterday ? '昨日'
            : `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日（${'日月火水木金土'[date.getDay()]}）`
        const last = groups[groups.length - 1]
        if (last && last.label === label) last.programs.push(program)
        else groups.push({ label, programs: [program] })
    }
    return groups
}

// 番組の並べ方（recent: 最近録った順 / size: 大きい順。容量を空けたい時に）
type ProgramOrder = 'recent' | 'size'
const sortPrograms = (programs: ProgramSummary[], order: ProgramOrder) =>
    order === 'size' ? [...programs].sort((a, b) => b.bytes - a.bytes) : programs

// 録った時間（秒）。種類を問わず、どれかを録っていた時間を合わせる（同時に録った所は1回だけ数える）
const recordedSeconds = (segments: SegmentSummary[]) => {
    let total = 0
    let until = -Infinity
    for (const segment of [...segments].sort((a, b) => a.startedAt - b.startedAt)) {
        const end = segmentEnd(segment)
        if (end <= until) continue
        total += end - Math.max(segment.startedAt, until)
        until = end
    }
    return total / 1000
}

// 一覧に出す画像（最後に録った区間の画像）
const thumbnailOf = (segments: SegmentSummary[]) =>
    [...segments].reverse().find(segment => segment.thumbnail)?.thumbnail ?? null

// 区間を、保存した時のファイルの単位にまとめる（items は録り始めた順）
// 続けて並んだ同じ種類の区間のうち、映像・音声の設定（signature）が同じものは1本のファイルにつなぐ。
// 設定が分からない区間（webm・初期化セグメントがまだない）は、それだけで1本
const groupIntoFiles = <T>(items: T[], keyOf: (item: T) => { kind: RecordingKind, signature: string | null }): T[][] => {
    const groups: { kind: RecordingKind, signature: string | null, items: T[] }[] = []
    for (const item of items) {
        const { kind, signature } = keyOf(item)
        const last = groups[groups.length - 1]
        if (signature !== null && last && last.kind === kind && last.signature === signature) last.items.push(item)
        else groups.push({ kind, signature, items: [item] })
    }
    return groups.map(group => group.items)
}

// 録画一覧のページで1行に出す録画（保存した時の1本のファイル）
type RecordingFile = {
    kind: RecordingKind
    segments: SegmentSummary[]
    startedAt: number
    endedAt: number // 録画中なら、今のところの終わり
    recording: boolean
    seconds: number // 録った時間
    bytes: number
    thumbnail: string | null
    // 前のファイルからすぐ続いている（解像度などの設定が変わって、ファイルが分かれた）
    splitBySettings: boolean
    // タイムラインに描く範囲（続けて録った区間はつなぐ。間が空いた所は分ける）
    blocks: { start: number, end: number }[]
}

// これより短い間で続いていれば、続けて録ったものとする（区切りや録り直しの、わずかな間）
const CONTINUOUS_GAP_MS = 3000

// 番組の1つの種類の区間を、保存した時のファイルの単位にまとめる
// signatures: 区間ごとの映像・音声の設定の印（分からなければ null）
const filesOf = (segments: SegmentSummary[], kind: RecordingKind, signatures: ReadonlyMap<string, string | null>): RecordingFile[] => {
    const ofKind = segments.filter(segment => segment.kind === kind).sort((a, b) => a.startedAt - b.startedAt)
    const groups = groupIntoFiles(ofKind, segment => ({ kind, signature: segment.format === 'fmp4' ? signatures.get(segment.segmentId) ?? null : null }))
    let previousEnd = -Infinity
    return groups.map((group) => {
        const blocks: RecordingFile['blocks'] = []
        for (const segment of group) {
            const last = blocks[blocks.length - 1]
            if (last && segment.startedAt - last.end <= CONTINUOUS_GAP_MS) last.end = Math.max(last.end, segmentEnd(segment))
            else blocks.push({ start: segment.startedAt, end: segmentEnd(segment) })
        }
        const startedAt = group[0].startedAt
        const file: RecordingFile = {
            kind,
            segments: group,
            startedAt,
            endedAt: Math.max(...group.map(segmentEnd)),
            recording: group.some(segment => segment.endedAt === null),
            seconds: recordedSeconds(group),
            bytes: group.reduce((sum, segment) => sum + segment.bytes, 0),
            thumbnail: group.find(segment => segment.thumbnail)?.thumbnail ?? null,
            splitBySettings: startedAt - previousEnd <= CONTINUOUS_GAP_MS * 5,
            blocks,
        }
        previousEnd = file.endedAt
        return file
    })
}

export { summarizePrograms, filterPrograms, groupByDay, programKeyOf, sortPrograms, recordedSeconds, thumbnailOf, groupIntoFiles, filesOf, segmentEnd }
export type { ProgramSummary, ProgramOrder, RecordingFile }
