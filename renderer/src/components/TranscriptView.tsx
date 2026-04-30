import type { Transcript, WordSegment } from '@shared/types'

interface Props {
  transcript: Transcript
  currentTime?: number          // playhead seconds — highlights active word (Phase 4)
  onWordClick?: (word: WordSegment) => void
}

export function TranscriptView({ transcript, currentTime, onWordClick }: Props) {
  if (transcript.segments.length === 0) {
    return (
      <p className="text-sm text-zinc-600 italic">No speech detected.</p>
    )
  }

  // Group words into paragraphs: new paragraph after ≥1.5 s silence
  const paragraphs = groupIntoParagraphs(transcript.segments, 1.5)

  return (
    <div className="flex flex-col gap-4 font-mono text-sm leading-relaxed select-text">
      {paragraphs.map((words, pi) => (
        <p key={pi} className="flex flex-wrap gap-x-1 gap-y-0.5">
          {words.map((word, wi) => {
            const isActive =
              currentTime !== undefined &&
              currentTime >= word.start &&
              currentTime <= word.end
            const isLowConf = word.confidence < 0.6

            return (
              <span
                key={`${pi}-${wi}`}
                title={`${fmt(word.start)} – ${fmt(word.end)}  conf: ${Math.round(word.confidence * 100)}%`}
                onClick={() => onWordClick?.(word)}
                className={[
                  'rounded px-0.5 cursor-pointer transition-colors',
                  isActive
                    ? 'bg-blue-500/30 text-blue-200'
                    : isLowConf
                    ? 'text-zinc-500 hover:text-zinc-300'
                    : 'text-zinc-300 hover:bg-zinc-800',
                ].join(' ')}
              >
                {word.text}
              </span>
            )
          })}
        </p>
      ))}
    </div>
  )
}

function groupIntoParagraphs(words: WordSegment[], gapSeconds: number): WordSegment[][] {
  if (words.length === 0) return []
  const groups: WordSegment[][] = [[words[0]]]
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap >= gapSeconds) {
      groups.push([words[i]])
    } else {
      groups[groups.length - 1].push(words[i])
    }
  }
  return groups
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}
