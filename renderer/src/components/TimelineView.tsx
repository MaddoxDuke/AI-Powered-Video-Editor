import { useRef, useState } from 'react'
import type { EDL, EDLEntry } from '@shared/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TimelineSegment {
  entry: EDLEntry
  outputStart: number   // seconds from start of final video
  duration: number      // seconds in final video
}

interface TooltipInfo {
  segment: TimelineSegment
  x: number
  y: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function buildTimeline(edl: EDL): TimelineSegment[] {
  const segments: TimelineSegment[] = []

  // First pass: assign outputStart to each A-roll in order
  let cursor = 0
  const aRollMap = new Map<string, { seg: TimelineSegment; idx: number }>()

  for (const entry of edl.entries) {
    if (entry.type === 'a-roll') {
      const duration = entry.sourceEnd - entry.sourceStart
      const seg: TimelineSegment = { entry, outputStart: cursor, duration }
      segments.push(seg)
      // Key: clipId + sourceStart so the same clip used twice maps correctly
      aRollMap.set(`${entry.clipId}:${entry.sourceStart}`, { seg, idx: segments.length - 1 })
      cursor += duration
    }
  }

  const totalDuration = cursor

  // Second pass: place B-roll relative to its underlying A-roll
  for (const entry of edl.entries) {
    if (entry.type !== 'b-roll') continue

    const duration = entry.sourceEnd - entry.sourceStart

    if (entry.overUnderlying) {
      const { aRollClipId, aRollStart } = entry.overUnderlying

      // Find the A-roll segment that this B-roll overlays
      // Match by clipId + closest sourceStart
      let bestMatch: TimelineSegment | null = null
      let bestDist = Infinity
      for (const [key, { seg }] of aRollMap) {
        if (!key.startsWith(aRollClipId + ':')) continue
        const dist = Math.abs(seg.entry.sourceStart - aRollStart)
        if (dist < bestDist) { bestDist = dist; bestMatch = seg }
      }

      if (bestMatch) {
        // outputStart = A-roll's output position + offset within the A-roll window
        const offsetIntoARoll = aRollStart - bestMatch.entry.sourceStart
        const outputStart = bestMatch.outputStart + Math.max(0, offsetIntoARoll)
        segments.push({ entry, outputStart, duration })
        continue
      }
    }

    // No overUnderlying or no match — place at end (shouldn't normally happen)
    segments.push({ entry, outputStart: totalDuration, duration })
  }

  return segments
}

function markerInterval(totalSecs: number): number {
  if (totalSecs <= 120) return 15
  if (totalSecs <= 300) return 30
  if (totalSecs <= 600) return 60
  if (totalSecs <= 1800) return 120
  return 300
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  edl: EDL
}

export function TimelineView({ edl }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const segments = buildTimeline(edl)
  const totalDuration = edl.totalDuration
  if (totalDuration <= 0) return null

  const interval = markerInterval(totalDuration)
  const markerCount = Math.floor(totalDuration / interval)
  const markers: number[] = []
  for (let i = 1; i <= markerCount; i++) markers.push(i * interval)

  function pct(sec: number) { return (sec / totalDuration) * 100 }

  function segKey(s: TimelineSegment) {
    return `${s.entry.type}:${s.entry.clipId}:${s.outputStart.toFixed(2)}`
  }

  function handleMouseEnter(seg: TimelineSegment, e: React.MouseEvent) {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({ segment: seg, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  function handleMouseLeave() { setTooltip(null) }

  function handleClick(seg: TimelineSegment) {
    const k = segKey(seg)
    setSelectedKey(prev => prev === k ? null : k)
  }

  const aRollSegs = segments.filter(s => s.entry.type === 'a-roll')
  const bRollSegs = segments.filter(s => s.entry.type === 'b-roll')

  return (
    <div className="flex flex-col gap-2 select-none">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono uppercase tracking-widest text-zinc-500">Timeline</span>
        <span className="text-xs text-zinc-600 font-mono">{fmtTime(totalDuration)} total</span>
      </div>

      {/* Scrollable track area */}
      <div
        ref={containerRef}
        className="relative overflow-x-auto overflow-y-visible rounded bg-zinc-950 border border-zinc-800"
        style={{ minHeight: 88 }}
      >
        {/* Inner fixed-width canvas — scrollable horizontally */}
        <div className="relative" style={{ minWidth: '100%', width: '100%', height: 88 }}>

          {/* ── Time ruler ─────────────────────────────────────────────────── */}
          <div className="absolute inset-x-0 top-0 h-5 border-b border-zinc-800">
            {/* 0:00 label */}
            <span
              className="absolute top-1 text-[10px] font-mono text-zinc-600"
              style={{ left: 2 }}
            >
              0:00
            </span>
            {markers.map(t => (
              <div
                key={t}
                className="absolute top-0 h-full border-l border-zinc-800 flex items-start pl-0.5"
                style={{ left: `${pct(t)}%` }}
              >
                <span className="text-[10px] font-mono text-zinc-600 mt-1 ml-0.5">{fmtTime(t)}</span>
              </div>
            ))}
          </div>

          {/* ── B-roll track (thin, violet) — top track ────────────────────── */}
          <div
            className="absolute inset-x-0"
            style={{ top: 28, height: 16 }}
          >
            {/* Track label */}
            <span
              className="absolute -left-0 top-0 text-[9px] font-mono text-zinc-700 leading-none"
              style={{ lineHeight: '16px', left: 2 }}
            >
              B
            </span>
            {bRollSegs.map(seg => {
              const key = segKey(seg)
              const isSelected = selectedKey === key
              const left = pct(seg.outputStart)
              const width = Math.max(pct(seg.duration), 0.3)
              return (
                <div
                  key={key}
                  className={`absolute top-0 h-full rounded-sm cursor-pointer transition-all
                    ${isSelected
                      ? 'bg-violet-400 ring-1 ring-violet-300 z-20'
                      : 'bg-violet-700/80 hover:bg-violet-500/90 z-10'}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onMouseEnter={e => handleMouseEnter(seg, e)}
                  onMouseLeave={handleMouseLeave}
                  onMouseMove={e => handleMouseEnter(seg, e)}
                  onClick={() => handleClick(seg)}
                />
              )
            })}
          </div>

          {/* ── A-roll track (thick, blue) — bottom track ───────────────────── */}
          <div
            className="absolute inset-x-0"
            style={{ top: 50, height: 30 }}
          >
            {/* Track label */}
            <span
              className="absolute top-0 text-[9px] font-mono text-zinc-700 leading-none"
              style={{ lineHeight: '30px', left: 2 }}
            >
              A
            </span>
            {aRollSegs.map(seg => {
              const key = segKey(seg)
              const isSelected = selectedKey === key
              const left = pct(seg.outputStart)
              const width = Math.max(pct(seg.duration), 0.2)
              const label = seg.entry.type === 'a-roll'
                ? (seg.entry.transcriptText
                    ? seg.entry.transcriptText.slice(0, 60) + (seg.entry.transcriptText.length > 60 ? '…' : '')
                    : seg.entry.clipId)
                : seg.entry.clipId
              return (
                <div
                  key={key}
                  className={`absolute top-0 h-full rounded-sm cursor-pointer overflow-hidden transition-all
                    ${isSelected
                      ? 'bg-blue-400 ring-1 ring-blue-300 z-20'
                      : 'bg-blue-700/80 hover:bg-blue-500/90 z-10'}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onMouseEnter={e => handleMouseEnter(seg, e)}
                  onMouseLeave={handleMouseLeave}
                  onMouseMove={e => handleMouseEnter(seg, e)}
                  onClick={() => handleClick(seg)}
                >
                  {/* Only show label if the block is wide enough */}
                  {width > 3 && (
                    <span className="absolute inset-0 flex items-center px-1 text-[9px] font-mono text-blue-100/80 truncate pointer-events-none">
                      {label}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Tooltip ──────────────────────────────────────────────────────── */}
          {tooltip && (
            <div
              className="absolute z-50 pointer-events-none bg-zinc-800 border border-zinc-600 rounded-md shadow-lg p-2 max-w-xs"
              style={{
                left: Math.min(tooltip.x + 8, (containerRef.current?.clientWidth ?? 400) - 200),
                top: tooltip.y < 50 ? tooltip.y + 16 : tooltip.y - 90,
              }}
            >
              <div className="flex flex-col gap-0.5">
                <span className={`text-[10px] font-mono font-semibold ${
                  tooltip.segment.entry.type === 'a-roll' ? 'text-blue-400' : 'text-violet-400'
                }`}>
                  {tooltip.segment.entry.type === 'b-roll' ? 'B-roll' : 'A-roll'} — {tooltip.segment.entry.clipId}
                </span>
                <span className="text-[10px] text-zinc-400 font-mono">
                  out: {fmtTime(tooltip.segment.outputStart)} → {fmtTime(tooltip.segment.outputStart + tooltip.segment.duration)}
                  {' '}({tooltip.segment.duration.toFixed(1)}s)
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  src: {tooltip.segment.entry.sourceStart.toFixed(1)}s → {tooltip.segment.entry.sourceEnd.toFixed(1)}s
                </span>
                {tooltip.segment.entry.type === 'a-roll' && tooltip.segment.entry.transcriptText && (
                  <span className="text-[10px] text-zinc-300 mt-1 leading-snug line-clamp-3">
                    "{tooltip.segment.entry.transcriptText.slice(0, 120)}{tooltip.segment.entry.transcriptText.length > 120 ? '…' : ''}"
                  </span>
                )}
                {tooltip.segment.entry.type === 'b-roll' && tooltip.segment.entry.overUnderlying && (
                  <span className="text-[10px] text-zinc-500 font-mono">
                    over: {tooltip.segment.entry.overUnderlying.aRollClipId} {fmtTime(tooltip.segment.entry.overUnderlying.aRollStart)}–{fmtTime(tooltip.segment.entry.overUnderlying.aRollEnd)}
                  </span>
                )}
                {tooltip.segment.entry.type === 'b-roll' && tooltip.segment.entry.reason && (
                  <span className="text-[10px] text-zinc-400 italic">{tooltip.segment.entry.reason}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Selected segment detail card */}
      {selectedKey && (() => {
        const sel = segments.find(s => segKey(s) === selectedKey)
        if (!sel) return null
        return (
          <div className="flex flex-col gap-1 p-3 rounded bg-zinc-800 border border-zinc-700 text-xs">
            <div className="flex items-center justify-between">
              <span className={`font-mono font-semibold ${sel.entry.type === 'a-roll' ? 'text-blue-400' : 'text-violet-400'}`}>
                {sel.entry.type === 'b-roll' ? 'B-roll' : 'A-roll'} — {sel.entry.clipId}
              </span>
              <button
                onClick={() => setSelectedKey(null)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors text-sm leading-none"
              >
                ✕
              </button>
            </div>
            <div className="font-mono text-zinc-500">
              output: {fmtTime(sel.outputStart)} → {fmtTime(sel.outputStart + sel.duration)} ({sel.duration.toFixed(1)}s)
            </div>
            <div className="font-mono text-zinc-500">
              source: {sel.entry.sourceStart.toFixed(2)}s → {sel.entry.sourceEnd.toFixed(2)}s
            </div>
            {sel.entry.type === 'a-roll' && sel.entry.transcriptText && (
              <div className="text-zinc-300 leading-relaxed mt-1 border-t border-zinc-700 pt-1">
                "{sel.entry.transcriptText}"
              </div>
            )}
            {sel.entry.type === 'b-roll' && sel.entry.reason && (
              <div className="text-zinc-400 italic mt-1">{sel.entry.reason}</div>
            )}
          </div>
        )
      })()}
    </div>
  )
}
