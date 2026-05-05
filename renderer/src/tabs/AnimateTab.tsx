import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { RenderProgress } from '../components/RenderProgress'
import { CopyButton } from '../components/CopyButton'
import type { AnimationPlan, AnimationCue } from '@shared/types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = String(Math.round(sec % 60)).padStart(2, '0')
  return `${m}:${s}`
}

const KIND_COLORS: Record<AnimationCue['kind'], string> = {
  'lower-third': 'bg-violet-600/20 text-violet-300 border-violet-600/40',
  'callout':     'bg-blue-600/20 text-blue-300 border-blue-600/40',
  'kinetic-text':'bg-orange-600/20 text-orange-300 border-orange-600/40',
  'data-card':   'bg-green-600/20 text-green-300 border-green-600/40',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg className="animate-spin text-zinc-400" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 bg-red-950/40 border border-red-800 rounded p-3">
      <p className="flex-1 text-xs text-red-400 font-mono whitespace-pre-wrap break-all">{message}</p>
      <CopyButton text={message} />
    </div>
  )
}

function KindBadge({ kind }: { kind: AnimationCue['kind'] }) {
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-mono shrink-0 ${KIND_COLORS[kind]}`}>
      {kind}
    </span>
  )
}

function CueCard({
  cue,
  approved,
  onToggle
}: {
  cue: AnimationCue
  approved: boolean
  onToggle: (id: string) => void
}) {
  const varEntries = Object.entries(cue.variables).filter(([k]) => k !== 'duration')

  return (
    <div
      className={`flex gap-3 p-3 rounded border transition-colors cursor-pointer ${
        approved
          ? 'bg-zinc-800/60 border-zinc-700 hover:border-zinc-600'
          : 'bg-zinc-900/40 border-zinc-800 opacity-50 hover:opacity-70'
      }`}
      onClick={() => onToggle(cue.id)}
    >
      {/* Checkbox */}
      <div className="flex items-start pt-0.5">
        <input
          type="checkbox"
          checked={approved}
          onChange={() => onToggle(cue.id)}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 accent-violet-500 cursor-pointer"
        />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-1.5 flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <KindBadge kind={cue.kind} />
          <span className="text-xs text-zinc-400 tabular-nums font-mono">
            {fmtTime(cue.startInFinal)}
          </span>
          <span className="text-xs text-zinc-600">{cue.duration}s</span>
        </div>

        {/* Trigger text */}
        <p className="text-xs text-zinc-400 italic truncate" title={cue.triggerText}>
          "{cue.triggerText.length > 60 ? cue.triggerText.slice(0, 57) + '…' : cue.triggerText}"
        </p>

        {/* Variables */}
        {varEntries.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {varEntries.map(([k, v]) => (
              <span key={k} className="text-xs font-mono bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300">
                {k}=<span className="text-zinc-100">{v}</span>
              </span>
            ))}
          </div>
        )}

        {/* Reason */}
        <p className="text-xs text-zinc-500 leading-relaxed">{cue.reason}</p>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function AnimateTab() {
  const {
    combinedVideoPath,
    edl,
    transcript,
    settings,
    animationPlan,
    finalVideoPath,
    setAnimationPlan,
    setFinalVideo
  } = useStore()

  const [planning, setPlanning] = useState(false)
  const [plan, setPlan] = useState<AnimationPlan | null>(animationPlan)
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set())
  const [rendering, setRendering] = useState(false)
  const [renderProgress, setRenderProgress] = useState<{ stage: string; percent: number } | null>(null)
  const [finalPath, setFinalPath] = useState<string | null>(finalVideoPath)
  const [error, setError] = useState<string | null>(null)

  // Sync plan from store on mount (in case we navigated away and back)
  useEffect(() => {
    if (animationPlan && !plan) {
      setPlan(animationPlan)
      setApprovedIds(new Set(animationPlan.cues.map((c) => c.id)))
    }
  }, [animationPlan])

  // Listen for animation progress events
  useEffect(() => {
    const unsub = window.api.on('animate:progress', (raw) => {
      const p = raw as { stage: string; percent: number }
      setRenderProgress(p)
    })
    return () => unsub()
  }, [])

  function toggleApproval(id: string) {
    setApprovedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handlePlanAnimations() {
    if (!edl || !transcript || !combinedVideoPath || !settings) return
    setPlanning(true)
    setError(null)

    try {
      const apiKey = await window.api.getApiKey()
      // Use EDL totalDuration as approximation for combined video duration
      const combinedDuration = edl.totalDuration

      const result = await window.api.planAnimate(edl, transcript, combinedDuration, settings, apiKey)

      if (!result.ok || !result.plan) {
        setError(result.error ?? 'Animation planning failed')
        setPlanning(false)
        return
      }

      setPlan(result.plan)
      setAnimationPlan(result.plan)
      setApprovedIds(new Set(result.plan.cues.map((c) => c.id)))
      setFinalPath(null)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setPlanning(false)
    }
  }

  async function handleRenderAnimations() {
    if (!plan || !combinedVideoPath || !settings) return

    const approvedCues = plan.cues.filter((c) => approvedIds.has(c.id))
    if (approvedCues.length === 0) return

    const filteredPlan: AnimationPlan = { ...plan, cues: approvedCues }

    setRendering(true)
    setRenderProgress({ stage: 'Starting…', percent: 0 })
    setError(null)

    try {
      const result = await window.api.renderAnimations(filteredPlan, combinedVideoPath, settings.exportFolder)

      if (!result.ok || !result.finalPath) {
        setError(result.error ?? 'Render failed')
        setRendering(false)
        setRenderProgress(null)
        return
      }

      setFinalPath(result.finalPath)
      setFinalVideo(result.finalPath)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setRendering(false)
    }
  }

  function handleSkipAnimations() {
    if (!combinedVideoPath) return
    setFinalVideo(combinedVideoPath)
    setFinalPath(combinedVideoPath)
  }

  function openInFinder(path: string) {
    // Use shell.openPath equivalent — show in finder
    window.api.on('noop', () => {})  // ensure api is present
    // Direct shell reveal via Electron's shell module isn't in preload,
    // so we open the folder by opening the file path directly
    const link = document.createElement('a')
    link.href = `file://${path}`
    link.click()
  }

  // ── Guard: no combined video yet ─────────────────────────────────────────────

  if (!combinedVideoPath) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <LockIcon />
        <div>
          <p className="text-zinc-300 font-medium">No combined video yet</p>
          <p className="text-zinc-500 text-sm mt-1">
            Complete the edit in the Edit tab first. Once you render{' '}
            <code className="text-zinc-400">combined.mp4</code>, it will appear here.
          </p>
        </div>
      </div>
    )
  }

  const approvedCount = plan ? plan.cues.filter((c) => approvedIds.has(c.id)).length : 0
  const isDone = finalPath !== null

  return (
    <div className="flex flex-col gap-6 p-8 h-full overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Animate</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Review your cut, plan motion graphics with Claude, then render.
        </p>
      </div>

      {/* ── Combined video preview ────────────────────────────────────────── */}
      <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Combined video</h2>
        <video
          src={`file://${combinedVideoPath}`}
          controls
          className="w-full rounded border border-zinc-800 max-h-96"
        />
      </section>

      {/* ── Plan animations button ────────────────────────────────────────── */}
      {!isDone && (
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Animation plan</h2>

          {error && <ErrorBox message={error} />}

          {planning && (
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-xs text-zinc-400">Planning animations with Claude…</span>
            </div>
          )}

          {!planning && (
            <button
              onClick={handlePlanAnimations}
              disabled={!edl || !transcript || rendering}
              className="self-start px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
            >
              {plan ? 'Re-plan animations' : 'Plan animations with AI'}
            </button>
          )}

          {/* Plan rationale */}
          {plan && !planning && (
            <p className="text-xs text-zinc-400 leading-relaxed border-l-2 border-zinc-700 pl-3">
              {plan.rationale}
            </p>
          )}
        </section>
      )}

      {/* ── Cue list ─────────────────────────────────────────────────────── */}
      {plan && !isDone && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">
              Animation cues
            </h2>
            <span className="text-xs text-zinc-500">
              {approvedCount}/{plan.cues.length} approved
            </span>
          </div>

          <div className="flex flex-col gap-2">
            {plan.cues.map((cue) => (
              <CueCard
                key={cue.id}
                cue={cue}
                approved={approvedIds.has(cue.id)}
                onToggle={toggleApproval}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Render progress ───────────────────────────────────────────────── */}
      {rendering && renderProgress && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Rendering</h2>
          <RenderProgress
            label={renderProgress.stage}
            progress={renderProgress.percent / 100}
          />
        </section>
      )}

      {/* ── Done state ────────────────────────────────────────────────────── */}
      {isDone && finalPath && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Final video</h2>
          <p className="text-xs text-green-400">Render complete</p>
          <p className="text-xs text-zinc-500 font-mono truncate" title={finalPath}>
            {finalPath}
          </p>
          <div className="flex gap-2">
            <a
              href={`file://${finalPath}`}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-300 transition-colors"
            >
              Open file
            </a>
            <button
              onClick={() => openInFinder(finalPath)}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-300 transition-colors"
            >
              Show in Finder
            </button>
            <button
              onClick={() => {
                setFinalPath(null)
                setRenderProgress(null)
              }}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-500 transition-colors"
            >
              Make changes
            </button>
          </div>
        </section>
      )}

      {/* ── Action bar ───────────────────────────────────────────────────── */}
      {!isDone && (
        <div className="mt-auto pt-4 border-t border-zinc-800 flex items-center gap-3 flex-wrap">
          <button
            onClick={handleRenderAnimations}
            disabled={!plan || approvedCount === 0 || rendering || planning}
            className="px-5 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
          >
            {rendering ? 'Rendering…' : `Render with animations (${approvedCount})`}
          </button>
          <button
            onClick={handleSkipAnimations}
            disabled={rendering || planning}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-300 font-medium transition-colors disabled:opacity-40"
          >
            Skip animations
          </button>
          {error && !rendering && (
            <span className="text-xs text-red-400 truncate">{error.slice(0, 80)}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function LockIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" className="text-zinc-700">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0110 0v4" />
    </svg>
  )
}
