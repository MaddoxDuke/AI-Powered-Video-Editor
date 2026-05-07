import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { RenderProgress } from '../components/RenderProgress'
import { CopyButton } from '../components/CopyButton'
import { ModelSelector } from '../components/ModelSelector'
import { CueTimeline } from '../components/CueTimeline'
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

type RevisionEntry = { request: string; rationale: string }

export function AnimateTab() {
  const {
    combinedVideoPath,
    edl,
    transcript,
    settings,
    animationPlan,
    finalVideoPath,
    setAnimationPlan,
    setFinalVideo,
    setCombinedVideo,
    setActiveTab,
  } = useStore()

  const [planning, setPlanning] = useState(false)
  const [plan, setPlan] = useState<AnimationPlan | null>(animationPlan)
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set())
  const [rendering, setRendering] = useState(false)
  const [renderProgress, setRenderProgress] = useState<{ stage: string; percent: number } | null>(null)
  const [finalPath, setFinalPath] = useState<string | null>(finalVideoPath)
  const [error, setError] = useState<string | null>(null)

  // Style prompt state
  const [styleText, setStyleText] = useState('')
  const [styleImagePath, setStyleImagePath] = useState<string | null>(null)

  // Model selector state
  const [selectedModel, setSelectedModel] = useState<string>(
    settings?.anthropicModel ?? 'claude-sonnet-4-5'
  )

  // Active cue for timeline
  const [activeCueId, setActiveCueId] = useState<string | null>(null)

  // Revise state
  const [revising, setRevising] = useState(false)
  const [reviseRequest, setReviseRequest] = useState('')
  const [revisionHistory, setRevisionHistory] = useState<RevisionEntry[]>([])
  const [reviseError, setReviseError] = useState<string | null>(null)

  // Sync plan from store on mount (in case we navigated away and back)
  useEffect(() => {
    if (animationPlan && !plan) {
      setPlan(animationPlan)
      setApprovedIds(new Set(animationPlan.cues.map((c) => c.id)))
    }
  }, [animationPlan])

  // Update selectedModel when settings loads
  useEffect(() => {
    if (settings?.anthropicModel) {
      setSelectedModel(settings.anthropicModel)
    }
  }, [settings])

  // Listen for animation render progress events
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

  function handleCueTimelineClick(id: string) {
    setActiveCueId(id)
    document.getElementById('cue-' + id)?.scrollIntoView({ behavior: 'smooth' })
  }

  async function handlePickVideo() {
    const path = await window.api.pickFile([{ name: 'Video', extensions: ['mp4', 'mov', 'm4v'] }])
    if (path) setCombinedVideo(path)
  }

  async function handlePickStyleImage() {
    const path = await window.api.pickFile([{ name: 'Image', extensions: ['jpg', 'jpeg', 'png', 'webp'] }])
    if (path) setStyleImagePath(path)
  }

  async function handlePlanAnimations() {
    if (!edl || !combinedVideoPath || !settings) return
    setPlanning(true)
    setError(null)

    const effectiveSettings = { ...settings, anthropicModel: selectedModel }

    try {
      const apiKey = await window.api.getApiKey()
      const combinedDuration = edl.totalDuration

      // transcript is optional — plan-animate falls back to EDL transcriptText
      const result = await window.api.planAnimate(
        edl,
        transcript,
        combinedDuration,
        effectiveSettings,
        apiKey,
        styleText.trim() || null,
        styleImagePath
      )

      if (!result.ok || !result.plan) {
        setError(result.error ?? 'Animation planning failed')
        return
      }

      setPlan(result.plan)
      setAnimationPlan(result.plan)
      setApprovedIds(new Set(result.plan.cues.map((c) => c.id)))
      setFinalPath(null)
      setActiveCueId(null)
      // Clear style prompt after successful plan
      setStyleText('')
      setStyleImagePath(null)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setPlanning(false)
    }
  }

  async function handleReviseAnimations() {
    if (!plan || !edl || !settings || !reviseRequest.trim()) return
    setRevising(true)
    setReviseError(null)

    const effectiveSettings = { ...settings, anthropicModel: selectedModel }

    try {
      const apiKey = await window.api.getApiKey()
      const result = await window.api.reviseAnimate(
        plan,
        reviseRequest.trim(),
        edl.totalDuration,
        effectiveSettings,
        apiKey
      )

      if (!result.ok || !result.plan) {
        setReviseError(result.error ?? 'Revision failed')
        return
      }

      setRevisionHistory((h) => [...h, { request: reviseRequest.trim(), rationale: result.plan!.rationale }])
      setPlan(result.plan)
      setAnimationPlan(result.plan)
      setApprovedIds(new Set(result.plan.cues.map((c) => c.id)))
      setReviseRequest('')
      setActiveCueId(null)
    } catch (err: unknown) {
      setReviseError((err as Error).message)
    } finally {
      setRevising(false)
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

  // ── Guard: no combined video yet ─────────────────────────────────────────────

  if (!combinedVideoPath) {
    const aRollCount = edl?.entries.filter((e) => e.type === 'a-roll').length ?? 0

    return (
      <div className="flex flex-col items-center justify-center h-full gap-6 text-center p-8">
        <LockIcon />
        <div className="flex flex-col gap-1">
          <p className="text-zinc-300 font-medium">No combined video loaded</p>
          <p className="text-zinc-500 text-sm">
            Render one in the Edit tab, or pick an existing{' '}
            <code className="text-zinc-400">combined.mp4</code>.
          </p>
        </div>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={handlePickVideo}
            className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors"
          >
            Pick existing video…
          </button>

          {/* EDL status hint */}
          {!edl ? (
            <div className="flex items-start gap-2 p-3 rounded bg-zinc-900 border border-zinc-800 text-left">
              <span className="text-amber-400 text-xs mt-0.5">⚠</span>
              <p className="text-xs text-zinc-400">
                No EDL loaded. Go to the{' '}
                <button
                  onClick={() => setActiveTab('edit')}
                  className="text-violet-400 hover:text-violet-300 underline"
                >
                  Edit tab
                </button>
                {' '}and load your saved EDL first.
              </p>
            </div>
          ) : (
            <p className="text-xs text-green-500">
              ✓ EDL loaded — {aRollCount} A-roll segments ready
            </p>
          )}
        </div>
      </div>
    )
  }

  const approvedCount = plan ? plan.cues.filter((c) => approvedIds.has(c.id)).length : 0
  const isDone = finalPath !== null
  const canPlan = !!edl && !rendering && !revising
  const isBusy = planning || rendering || revising

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
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Combined video</h2>
          <button
            onClick={handlePickVideo}
            className="text-xs text-zinc-500 hover:text-zinc-300 underline transition-colors"
          >
            Change…
          </button>
        </div>
        <video
          src={`file://${combinedVideoPath}`}
          controls
          className="w-full rounded border border-zinc-800 max-h-96"
        />
        {!transcript && (
          <p className="text-xs text-zinc-500">
            No word-level transcript in session — animation timestamps will be derived from EDL segment text.
          </p>
        )}
      </section>

      {/* ── Plan animations ───────────────────────────────────────────────── */}
      {!isDone && (
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Animation plan</h2>

          {error && <ErrorBox message={error} />}

          {!edl && (
            <p className="text-xs text-amber-400">
              ⚠ Load an EDL in the{' '}
              <button onClick={() => setActiveTab('edit')} className="underline hover:text-amber-300">
                Edit tab
              </button>
              {' '}before planning animations.
            </p>
          )}

          {/* Style prompt — only shown before first plan */}
          {!plan && (
            <details className="text-xs">
              <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300 transition-colors select-none">
                Animation style (optional)
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <textarea
                  value={styleText}
                  onChange={(e) => setStyleText(e.target.value)}
                  placeholder={'Describe your style... e.g. "minimal and clean, white on black, no orange" or "bold aggressive automotive, high contrast"'}
                  rows={3}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-violet-500 resize-none"
                />

                {settings?.llmProvider === 'anthropic' && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={handlePickStyleImage}
                      className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                    >
                      Add reference image…
                    </button>
                    {styleImagePath && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-zinc-400 font-mono truncate max-w-xs">
                          {styleImagePath.split('/').pop()}
                        </span>
                        <button
                          type="button"
                          onClick={() => setStyleImagePath(null)}
                          className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                        >
                          ✕ remove
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-zinc-600">
                  Text and image reference are passed to Claude when generating the plan.
                </p>
              </div>
            </details>
          )}

          {planning ? (
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-xs text-zinc-400">Planning animations with Claude…</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handlePlanAnimations}
                disabled={!canPlan}
                className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
              >
                {plan ? 'Re-plan animations' : 'Plan animations with AI'}
              </button>
              <ModelSelector settings={settings} value={selectedModel} onChange={setSelectedModel} />
            </div>
          )}

          {plan && !planning && (
            <p className="text-xs text-zinc-400 leading-relaxed border-l-2 border-zinc-700 pl-3">
              {plan.rationale}
            </p>
          )}
        </section>
      )}

      {/* ── Cue timeline strip ────────────────────────────────────────────── */}
      {plan && !isDone && (
        <div className="px-0">
          <CueTimeline
            cues={plan.cues}
            totalDuration={edl?.totalDuration ?? 0}
            approvedIds={approvedIds}
            activeCueId={activeCueId}
            onCueClick={handleCueTimelineClick}
          />
        </div>
      )}

      {/* ── Cue list ─────────────────────────────────────────────────────── */}
      {plan && !isDone && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Animation cues</h2>
            <span className="text-xs text-zinc-500">{approvedCount}/{plan.cues.length} approved</span>
          </div>

          <div className="flex flex-col gap-2">
            {plan.cues.map((cue) => (
              <div key={cue.id} id={'cue-' + cue.id}>
                <CueCard
                  cue={cue}
                  approved={approvedIds.has(cue.id)}
                  onToggle={toggleApproval}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Revise panel ─────────────────────────────────────────────────── */}
      {plan && !isDone && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Refine plan</h2>

          {reviseError && <ErrorBox message={reviseError} />}

          {/* Revision history */}
          {revisionHistory.length > 0 && (
            <div className="flex flex-col gap-2">
              {revisionHistory.map((entry, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <div className="self-end max-w-xs bg-violet-600/20 border border-violet-600/30 rounded-lg px-3 py-2">
                    <p className="text-xs text-violet-300">{entry.request}</p>
                  </div>
                  <div className="self-start max-w-sm bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2">
                    <p className="text-xs text-zinc-400 leading-relaxed">{entry.rationale}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {revising ? (
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-xs text-zinc-400">Revising animation plan…</span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <textarea
                value={reviseRequest}
                onChange={(e) => setReviseRequest(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleReviseAnimations() }}
                placeholder={'e.g. "Change the accent color to blue"\n"Remove the kinetic text cue"\n"Add a data card when the torque spec is mentioned"'}
                rows={3}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-violet-500 resize-none"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleReviseAnimations}
                  disabled={isBusy || !reviseRequest.trim()}
                  className="px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
                >
                  Revise
                </button>
                <ModelSelector settings={settings} value={selectedModel} onChange={setSelectedModel} />
                <span className="text-xs text-zinc-600">⌘↵ to submit</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Render progress ───────────────────────────────────────────────── */}
      {rendering && renderProgress && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Rendering</h2>
          <RenderProgress label={renderProgress.stage} progress={renderProgress.percent / 100} />
        </section>
      )}

      {/* ── Done state ────────────────────────────────────────────────────── */}
      {isDone && finalPath && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Final video</h2>
          <p className="text-xs text-green-400">✓ Render complete</p>
          <p className="text-xs text-zinc-500 font-mono truncate" title={finalPath}>{finalPath}</p>
          <div className="flex gap-2 flex-wrap">
            <a
              href={`file://${finalPath}`}
              className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-300 transition-colors"
            >
              Open file
            </a>
            <button
              onClick={() => { setFinalPath(null); setRenderProgress(null) }}
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
            disabled={!plan || approvedCount === 0 || rendering || planning || revising}
            className="px-5 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
          >
            {rendering ? 'Rendering…' : `Render with animations (${approvedCount})`}
          </button>
          <button
            onClick={handleSkipAnimations}
            disabled={isBusy}
            className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm text-zinc-300 font-medium transition-colors disabled:opacity-40"
          >
            Skip animations
          </button>
          {error && !rendering && (
            <span className="text-xs text-red-400 truncate max-w-xs">{error.slice(0, 100)}</span>
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
