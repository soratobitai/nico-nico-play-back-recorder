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

export { summarizePrograms, filterPrograms, groupByDay, programKeyOf }
export type { ProgramSummary }
