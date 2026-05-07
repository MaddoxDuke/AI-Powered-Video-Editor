import type { AnimationCue } from '@shared/types'

type Props = {
  cues: AnimationCue[]
  totalDuration: number
  approvedIds: Set<string>
  activeCueId: string | null
  onCueClick: (id: string) => void
}

const KIND_BG: Record<AnimationCue['kind'], string> = {
  'lower-third':  'bg-violet-500',
  'callout':      'bg-blue-500',
  'kinetic-text': 'bg-orange-500',
  'data-card':    'bg-green-500',
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = String(Math.round(sec % 60)).padStart(2, '0')
  return `${m}:${s}`
}

export function CueTimeline({ cues, totalDuration, approvedIds, activeCueId, onCueClick }: Props) {
  if (!cues.length || totalDuration <= 0) return null

  return (
    <div
      className="relative w-full h-7 rounded bg-zinc-800 overflow-visible"
      style={{ minHeight: '28px' }}
    >
      {cues.map((cue) => {
        const leftPct = (cue.startInFinal / totalDuration) * 100
        const widthPct = (cue.duration / totalDuration) * 100
        const isApproved = approvedIds.has(cue.id)
        const isActive = cue.id === activeCueId
        const colorClass = KIND_BG[cue.kind]
        const tooltip = `${cue.kind} @ ${fmtTime(cue.startInFinal)} (${cue.duration}s)`

        return (
          <button
            key={cue.id}
            title={tooltip}
            onClick={() => onCueClick(cue.id)}
            className={`absolute top-1 h-5 rounded cursor-pointer transition-opacity ${colorClass} ${
              isApproved ? 'opacity-70' : 'opacity-30'
            } ${isActive ? 'ring-2 ring-white ring-offset-1 ring-offset-zinc-800' : ''} hover:opacity-100`}
            style={{
              left: `${leftPct}%`,
              width: `max(4px, ${widthPct}%)`,
            }}
          />
        )
      })}
    </div>
  )
}
