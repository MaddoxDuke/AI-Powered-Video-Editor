import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { FolderPicker } from '../components/FolderPicker'
import { RenderProgress } from '../components/RenderProgress'
import { TranscriptView } from '../components/TranscriptView'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ClipMeta, EDL, EDLEntry } from '@shared/types'
import { CopyButton } from '../components/CopyButton'
import { TimelineView } from '../components/TimelineView'
import { ModelSelector } from '../components/ModelSelector'

// ── Local state types ─────────────────────────────────────────────────────────

type TranscribeState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'running'; overall: number; currentClip: string }
  | { status: 'done'; errors: Array<{ path: string; error: string }> }
  | { status: 'error'; message: string }

type PlanState =
  | { status: 'idle' }
  | { status: 'running'; chars: number }
  | { status: 'error'; message: string }

type ReviseState =
  | { status: 'idle' }
  | { status: 'running'; chars: number }
  | { status: 'error'; message: string }

type RenderState =
  | { status: 'idle' }
  | { status: 'running'; stage: string; percent: number }
  | { status: 'done'; outputPath: string; chaptersPath?: string }
  | { status: 'error'; message: string }

type RevisionEntry = { request: string; rationale: string }

// ── EDL diff ──────────────────────────────────────────────────────────────────

type EDLDiff = {
  added: EDLEntry[]
  removed: EDLEntry[]
  modified: Array<{ before: EDLEntry; after: EDLEntry }>
  durationDelta: number
}

function diffEDL(before: EDL, after: EDL): EDLDiff {
  const beforeA = before.entries.filter((e): e is Extract<EDLEntry, { type: 'a-roll' }> => e.type === 'a-roll')
  const afterA  = after.entries.filter((e): e is Extract<EDLEntry, { type: 'a-roll' }> => e.type === 'a-roll')

  const matchedBefore = new Set<number>()
  const matchedAfter  = new Set<number>()
  const modified: EDLDiff['modified'] = []

  for (let ai = 0; ai < afterA.length; ai++) {
    const a = afterA[ai]
    let bestIdx = -1
    let bestDist = Infinity
    for (let bi = 0; bi < beforeA.length; bi++) {
      if (matchedBefore.has(bi)) continue
      const b = beforeA[bi]
      if (b.clipId !== a.clipId) continue
      const dist = Math.abs(b.sourceStart - a.sourceStart)
      if (dist < 8 && dist < bestDist) { bestDist = dist; bestIdx = bi }
    }
    if (bestIdx !== -1) {
      matchedBefore.add(bestIdx)
      matchedAfter.add(ai)
      const b = beforeA[bestIdx]
      if (Math.abs(b.sourceStart - a.sourceStart) > 0.5 || Math.abs(b.sourceEnd - a.sourceEnd) > 0.5) {
        modified.push({ before: b, after: a })
      }
    }
  }

  const added   = afterA.filter((_, i) => !matchedAfter.has(i))
  const removed = beforeA.filter((_, i) => !matchedBefore.has(i))

  // B-roll: simple added/removed by clipId+start
  const beforeB = before.entries.filter((e) => e.type === 'b-roll')
  const afterB  = after.entries.filter((e) => e.type === 'b-roll')
  const matchedBB = new Set<number>()
  for (const ab of afterB) {
    const idx = beforeB.findIndex((bb, i) =>
      !matchedBB.has(i) && bb.clipId === ab.clipId && Math.abs(bb.sourceStart - ab.sourceStart) < 3
    )
    if (idx !== -1) matchedBB.add(idx)
    else added.push(ab)
  }
  beforeB.forEach((bb, i) => { if (!matchedBB.has(i)) removed.push(bb) })

  return { added, removed, modified, durationDelta: after.totalDuration - before.totalDuration }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function EditTab() {
  const {
    aRollFolder, bRollFolder,
    aRollClips, bRollClips,
    isScanning, transcript, edl, settings,
    setARollFolder, setARollClips,
    setBRollFolder, setBRollClips,
    setTranscript, setEDL, setCombinedVideo, setActiveTab
  } = useStore()

  const [txState, setTxState]       = useState<TranscribeState>({ status: 'idle' })
  const [planState, setPlanState]   = useState<PlanState>({ status: 'idle' })
  const [reviseState, setReviseState] = useState<ReviseState>({ status: 'idle' })
  const [renderState, setRenderState] = useState<RenderState>({ status: 'idle' })
  const [describeState, setDescribeState] = useState<
    | { status: 'idle' }
    | { status: 'running'; current: number; total: number; clipName: string }
    | { status: 'done' }
  >({ status: 'idle' })

  const [reviseRequest, setReviseRequest] = useState('')
  const [revisionHistory, setRevisionHistory] = useState<RevisionEntry[]>([])
  const [lastDiff, setLastDiff] = useState<EDLDiff | null>(null)
  const [savedFilePath, setSavedFilePath] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<string>(
    settings?.anthropicModel ?? 'claude-sonnet-4-5'
  )

  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (settings?.anthropicModel) {
      setSelectedModel(settings.anthropicModel)
    }
  }, [settings])

  useEffect(() => {
    const unsub = window.api.on('render-cut:progress', (raw) => {
      const p = raw as { stage: string; percent: number }
      setRenderState({ status: 'running', stage: p.stage, percent: p.percent })
    })
    unsubRef.current = unsub
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = window.api.on('plan-edit:progress', (raw) => {
      const p = raw as { chars: number }
      setPlanState((prev) => prev.status === 'running' ? { ...prev, chars: p.chars } : prev)
      setReviseState((prev) => prev.status === 'running' ? { ...prev, chars: p.chars } : prev)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = window.api.on('broll:describe-progress', (raw) => {
      const p = raw as { current: number; total: number; clipName: string }
      setDescribeState({ status: 'running', ...p })
    })
    return () => unsub()
  }, [])

  // Helper: set EDL in state and auto-save to workspace
  function applyEDL(newEdl: EDL) {
    setEDL(newEdl)
    window.api.edlAutoSave(newEdl)
  }

  function handleARollPick(folder: string, clips: ClipMeta[]) {
    setARollFolder(folder); setARollClips(clips); setTxState({ status: 'idle' })
  }
  async function handleBRollPick(folder: string, clips: ClipMeta[]) {
    setBRollFolder(folder)
    // Load any cached descriptions immediately
    const cached = await window.api.brollLoadDescriptions(folder)
    const enriched = clips.map((c) => {
      const name = c.path.split('/').pop() ?? ''
      return cached[name] ? { ...c, description: cached[name] } : c
    })
    setBRollClips(enriched)
  }

  async function handleDescribeBRoll(force = false) {
    if (!bRollClips.length || !bRollFolder) return
    setDescribeState({ status: 'running', current: 0, total: bRollClips.length, clipName: '' })
    const apiKey = await window.api.getApiKey()
    const descriptions = await window.api.brollDescribe(bRollClips, bRollFolder, apiKey, force)
    const enriched = bRollClips.map((c) => {
      const name = c.path.split('/').pop() ?? ''
      return descriptions[name] ? { ...c, description: descriptions[name] } : c
    })
    setBRollClips(enriched)
    setDescribeState({ status: 'done' })
  }

  async function handleTranscribe() {
    setTxState({ status: 'checking' })
    const check = await window.api.transcribeCheck()
    if (!check.ok) { setTxState({ status: 'error', message: check.error ?? 'faster-whisper unavailable' }); return }

    setTxState({ status: 'running', overall: 0, currentClip: '' })
    const unsub = window.api.on('transcribe:progress', (raw) => {
      const p = raw as { clipId: string; overallProgress: number }
      setTxState((prev) => prev.status === 'running'
        ? { ...prev, overall: p.overallProgress, currentClip: p.clipId }
        : prev)
    })

    const model = settings?.whisperModel ?? DEFAULT_SETTINGS.whisperModel
    const result = await window.api.transcribeAll(aRollClips, model)
    unsub()

    if (!result.ok) { setTxState({ status: 'error', message: 'Transcription failed.' }); return }
    setTranscript(result.transcript)
    setTxState({ status: 'done', errors: result.errors })
  }

  async function handlePlanEdit() {
    if (!transcript || !settings) return
    setPlanState({ status: 'running', chars: 0 })
    setLastDiff(null)
    setRevisionHistory([])
    const apiKey = await window.api.getApiKey()
    const effectiveSettings = { ...settings, anthropicModel: selectedModel }
    const result = await window.api.planEdit(transcript, aRollClips, bRollClips, effectiveSettings, apiKey)
    if (!result.ok || !result.edl) {
      setPlanState({ status: 'error', message: result.error ?? 'Planning failed' })
      return
    }
    applyEDL(result.edl)
    setPlanState({ status: 'idle' })
  }

  async function runRevision(request: string) {
    if (!edl || !transcript || !settings) return
    const previousEDL = edl
    setReviseState({ status: 'running', chars: 0 })
    setLastDiff(null)

    const apiKey = await window.api.getApiKey()
    const effectiveSettings = { ...settings, anthropicModel: selectedModel }
    const result = await window.api.reviseEdit(edl, transcript, aRollClips, bRollClips, request, effectiveSettings, apiKey)

    if (!result.ok || !result.edl) {
      setReviseState({ status: 'error', message: result.error ?? 'Revision failed' })
      return
    }

    const diff = diffEDL(previousEDL, result.edl)
    setLastDiff(diff)
    setRevisionHistory((h) => [...h, { request, rationale: result.edl!.rationale }])
    applyEDL(result.edl)
    setReviseState({ status: 'idle' })
  }

  async function handleRevise() {
    if (!reviseRequest.trim()) return
    await runRevision(reviseRequest.trim())
    setReviseRequest('')
  }

  async function handleRefineToSilence() {
    await runRevision(
      'Refine the in/out points of every A-roll entry to align with the nearest silence gap ' +
      'in the silence data provided. For each entry: snap sourceStart to the end of the nearest ' +
      'silence gap at or just before the current start (where speech begins), and snap sourceEnd ' +
      'to the start of the nearest silence gap at or just after the current end (where speech pauses). ' +
      'Do not change which clips are selected, their order, or which content is included — only ' +
      'fine-tune the in/out points to land on natural pauses. Leave B-roll entries unchanged.'
    )
  }

  async function handleSaveAs() {
    if (!edl) return
    const res = await window.api.edlSaveAs(edl)
    if (res.ok && !res.canceled && res.filePath) {
      setSavedFilePath(res.filePath)
    }
  }

  async function handleLoad() {
    const res = await window.api.edlLoad()
    if (res.ok && !res.canceled && res.edl) {
      applyEDL(res.edl)
      setSavedFilePath(res.filePath ?? null)
      setRevisionHistory([])
      setLastDiff(null)
    }
  }

  async function handleRender(draft = false) {
    if (!edl || !transcript || !settings) return
    setRenderState({ status: 'running', stage: draft ? 'Starting draft render…' : 'Starting…', percent: 0 })
    const result = await window.api.renderCut(edl, aRollClips, bRollClips, transcript, settings.exportFolder, draft)
    if (!result.ok || !result.outputPath) {
      setRenderState({ status: 'error', message: result.error ?? 'Render failed' })
      return
    }
    if (!draft) setCombinedVideo(result.outputPath)
    setRenderState({ status: 'done', outputPath: result.outputPath, chaptersPath: result.chaptersPath })
  }

  const isTranscribing = txState.status === 'running' || txState.status === 'checking'
  const isBusy = planState.status === 'running' || reviseState.status === 'running'

  return (
    <div className="flex flex-col gap-6 p-8 h-full overflow-y-auto">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Edit</h1>
        <p className="text-sm text-zinc-500 mt-1">Select footage, transcribe, plan the edit, then render.</p>
      </div>

      {/* ── Folder pickers ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Source footage</h2>
        <FolderPicker label="A-Roll" roll="a" folder={aRollFolder} clips={aRollClips} isScanning={isScanning} onPick={handleARollPick} />
        <FolderPicker label="B-Roll" roll="b" folder={bRollFolder} clips={bRollClips} isScanning={isScanning} onPick={handleBRollPick} />
      </section>

      {/* ── Clip inventory ─────────────────────────────────────────────────── */}
      {(aRollClips.length > 0 || bRollClips.length > 0) && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Clip inventory</h2>
          <ClipTable clips={aRollClips} label="A-Roll" color="blue" />
          <ClipTable clips={bRollClips} label="B-Roll" color="violet" />

          {/* B-roll description */}
          {bRollClips.length > 0 && (
            <div className="flex items-center gap-3 pt-1">
              {describeState.status === 'running' ? (
                <div className="flex items-center gap-2">
                  <Spinner />
                  <span className="text-xs text-zinc-400">
                    Describing {describeState.current}/{describeState.total}
                    {describeState.clipName ? ` — ${describeState.clipName}` : ''}
                  </span>
                </div>
              ) : (
                <button
                  onClick={() => {
                    const isRedo = describeState.status === 'done' || bRollClips.some((c) => c.description)
                    handleDescribeBRoll(isRedo)
                  }}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
                >
                  {describeState.status === 'done' || bRollClips.some((c) => c.description)
                    ? 'Re-describe B-roll'
                    : '✦ Auto-describe B-roll'}
                </button>
              )}
              {describeState.status === 'done' && (
                <span className="text-xs text-green-400">Descriptions saved ✓</span>
              )}
              {bRollClips.some((c) => c.description) && describeState.status !== 'running' && describeState.status !== 'done' && (
                <span className="text-xs text-zinc-600">{bRollClips.filter((c) => c.description).length} clips described</span>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Transcription ──────────────────────────────────────────────────── */}
      {aRollClips.length > 0 && (
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Transcription</h2>
            {transcript && <span className="text-xs text-green-400">{transcript.segments.length} words</span>}
          </div>

          {txState.status === 'error' && <ErrorBox message={txState.message} />}
          {txState.status === 'running' && (
            <RenderProgress label={txState.currentClip ? `Transcribing ${txState.currentClip}…` : 'Starting…'} progress={txState.overall} />
          )}
          {txState.status === 'done' && txState.errors.length > 0 && (
            <div className="rounded bg-yellow-950/40 border border-yellow-800 p-3">
              {txState.errors.map((e) => (
                <p key={e.path} className="text-xs text-yellow-400">{e.path.split('/').pop()}: {e.error}</p>
              ))}
            </div>
          )}

          {!transcript && (
            <button onClick={handleTranscribe} disabled={isTranscribing}
              className="self-start px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40">
              {isTranscribing ? 'Transcribing…' : `Transcribe ${aRollClips.length} clip${aRollClips.length !== 1 ? 's' : ''}`}
            </button>
          )}
          {transcript && txState.status !== 'running' && (
            <button onClick={() => { setTranscript({ segments: [] }); setTxState({ status: 'idle' }) }}
              className="self-start px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-400 transition-colors">
              Re-transcribe
            </button>
          )}
        </section>
      )}

      {/* ── Transcript view ────────────────────────────────────────────────── */}
      {transcript && transcript.segments.length > 0 && (
        <TranscriptSection transcript={transcript} />
      )}

      {/* ── Edit plan ──────────────────────────────────────────────────────── */}
      {transcript && transcript.segments.length > 0 && (
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Edit plan</h2>

          {planState.status === 'error' && <ErrorBox message={planState.message} />}
          {planState.status === 'running' && (
            <PlanProgress chars={planState.chars} provider={settings?.llmProvider} label="Planning edit…" />
          )}

          {edl && <EDLSummary edl={edl} />}
          {edl && <TimelineView edl={edl} />}

          <div className="flex gap-2 flex-wrap items-center">
            <button
              onClick={handlePlanEdit}
              disabled={isBusy}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
            >
              {edl ? 'Re-plan edit' : 'Plan edit with AI'}
            </button>
            <ModelSelector settings={settings} value={selectedModel} onChange={setSelectedModel} />
            {edl && (<>
              <button
                onClick={handleSaveAs}
                disabled={isBusy}
                className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-300 font-medium transition-colors disabled:opacity-40"
              >
                Save EDL…
              </button>
              <button
                onClick={handleLoad}
                disabled={isBusy}
                className="px-3 py-2 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-300 font-medium transition-colors disabled:opacity-40"
              >
                Load EDL…
              </button>
              {savedFilePath && (
                <span className="text-xs text-zinc-600 font-mono truncate max-w-xs" title={savedFilePath}>
                  {savedFilePath.split('/').pop()}
                </span>
              )}
            </>)}
          </div>

          {/* ── Revise panel ─────────────────────────────────────────────── */}
          {edl && (
            <div className="flex flex-col gap-3 pt-3 border-t border-zinc-800">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Request a change</h3>
                {transcript && (
                  <button
                    onClick={handleRefineToSilence}
                    disabled={isBusy}
                    title="Snap all A-roll cut points to the nearest silence gap"
                    className="px-3 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
                  >
                    ✂ Refine to silence
                  </button>
                )}
              </div>

              {/* Revision history */}
              {revisionHistory.length > 0 && (
                <div className="flex flex-col gap-2">
                  {revisionHistory.map((entry, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <div className="self-end max-w-xs bg-blue-600/20 border border-blue-600/30 rounded-lg px-3 py-2">
                        <p className="text-xs text-blue-300">{entry.request}</p>
                      </div>
                      <div className="self-start max-w-sm bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2">
                        <p className="text-xs text-zinc-400 leading-relaxed">{entry.rationale}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Diff from last revision */}
              {lastDiff && <EDLDiffView diff={lastDiff} />}

              {/* Input */}
              {reviseState.status === 'error' && <ErrorBox message={reviseState.message} />}
              {reviseState.status === 'running' && (
                <PlanProgress chars={reviseState.chars} provider={settings?.llmProvider} label="Revising edit…" />
              )}

              {reviseState.status !== 'running' && (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={reviseRequest}
                    onChange={(e) => setReviseRequest(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRevise() }}
                    placeholder={'e.g. "Cut the carburetor section, it goes on too long"\n"Add more B-roll over the exhaust work"\n"Trim the intro by about a minute"'}
                    rows={3}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500 resize-none"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={handleRevise}
                      disabled={isBusy || !reviseRequest.trim()}
                      className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
                    >
                      Apply revision
                    </button>
                    <ModelSelector settings={settings} value={selectedModel} onChange={setSelectedModel} />
                    <span className="text-xs text-zinc-600">⌘↵ to submit</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Render ─────────────────────────────────────────────────────────── */}
      {edl && (
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Render</h2>

          {renderState.status === 'error' && <ErrorBox message={renderState.message} />}
          {renderState.status === 'running' && (
            <RenderProgress label={renderState.stage} progress={renderState.percent / 100} />
          )}
          {renderState.status === 'done' && (
            <div className="flex flex-col gap-1">
              <p className="text-xs text-green-400">Rendered successfully</p>
              <p className="text-xs text-zinc-500 font-mono truncate">{renderState.outputPath}</p>
              {renderState.chaptersPath && (
                <p className="text-xs text-zinc-500 font-mono truncate">
                  chapters → {renderState.chaptersPath}
                </p>
              )}
            </div>
          )}

          {renderState.status !== 'done' && (
            <div className="flex gap-2 flex-wrap items-center">
              <button
                onClick={() => handleRender(false)}
                disabled={renderState.status === 'running' || isBusy}
                className="px-4 py-2 rounded bg-green-700 hover:bg-green-600 text-white text-sm font-medium transition-colors disabled:opacity-40"
              >
                {renderState.status === 'running' ? 'Rendering…' : 'Render combined.mp4'}
              </button>
              <button
                onClick={() => handleRender(true)}
                disabled={renderState.status === 'running' || isBusy}
                className="px-4 py-2 rounded bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 text-zinc-300 text-sm font-medium transition-colors disabled:opacity-40"
              >
                Draft render
              </button>
              <span className="text-xs text-zinc-600">Draft = A-roll only, fast encode — for checking cuts</span>
            </div>
          )}
          {renderState.status === 'done' && (
            <button
              onClick={() => setActiveTab('animate')}
              className="self-start px-4 py-2 rounded bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition-colors"
            >
              Continue to animations →
            </button>
          )}
        </section>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function EDLDiffView({ diff }: { diff: EDLDiff }) {
  const { added, removed, modified, durationDelta } = diff
  if (!added.length && !removed.length && !modified.length) return null

  const fmtDelta = (s: number) => {
    const sign = s >= 0 ? '+' : '−'
    const abs = Math.abs(s)
    const m = Math.floor(abs / 60)
    const sec = Math.round(abs % 60)
    return `${sign}${m > 0 ? `${m}m ` : ''}${sec}s`
  }

  const fmtRange = (e: EDLEntry) =>
    `${e.clipId}  ${e.sourceStart.toFixed(1)}–${e.sourceEnd.toFixed(1)}s`

  return (
    <div className="flex flex-col gap-1.5 rounded bg-zinc-800/50 border border-zinc-700 p-3">
      {/* Summary line */}
      <div className="flex items-center gap-3 text-xs mb-1">
        {added.length > 0 && <span className="text-green-400">+{added.length} added</span>}
        {removed.length > 0 && <span className="text-red-400">−{removed.length} removed</span>}
        {modified.length > 0 && <span className="text-amber-400">~{modified.length} modified</span>}
        <span className={`ml-auto font-mono ${durationDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {fmtDelta(durationDelta)}
        </span>
      </div>

      {/* Added */}
      {added.map((e, i) => (
        <div key={`add-${i}`} className="flex items-center gap-2 text-xs text-green-400">
          <span className="w-3">+</span>
          <span className="font-mono text-green-300/80">{fmtRange(e)}</span>
          {e.type === 'a-roll' && e.transcriptText && (
            <span className="text-green-500/60 truncate">{e.transcriptText.slice(0, 60)}</span>
          )}
          {e.type === 'b-roll' && <span className="text-green-500/60 truncate">{e.reason}</span>}
        </div>
      ))}

      {/* Removed */}
      {removed.map((e, i) => (
        <div key={`rem-${i}`} className="flex items-center gap-2 text-xs text-red-400">
          <span className="w-3">−</span>
          <span className="font-mono text-red-300/80 line-through">{fmtRange(e)}</span>
          {e.type === 'a-roll' && e.transcriptText && (
            <span className="text-red-500/60 truncate">{e.transcriptText.slice(0, 60)}</span>
          )}
        </div>
      ))}

      {/* Modified */}
      {modified.map(({ before, after }, i) => (
        <div key={`mod-${i}`} className="flex flex-col gap-0.5 text-xs">
          <div className="flex items-center gap-2 text-amber-400/70">
            <span className="w-3">~</span>
            <span className="font-mono line-through">{fmtRange(before)}</span>
          </div>
          <div className="flex items-center gap-2 text-amber-400">
            <span className="w-3"> </span>
            <span className="font-mono">{fmtRange(after)}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function EDLSummary({ edl }: { edl: EDL }) {
  const aCount = edl.entries.filter((e) => e.type === 'a-roll').length
  const bCount = edl.entries.filter((e) => e.type === 'b-roll').length
  const mins = Math.floor(edl.totalDuration / 60)
  const secs = Math.round(edl.totalDuration % 60)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-4 text-xs text-zinc-400">
        <span><span className="text-zinc-200">{aCount}</span> A-roll segments</span>
        <span><span className="text-zinc-200">{bCount}</span> B-roll overlays</span>
        <span>~<span className="text-zinc-200">{mins}:{String(secs).padStart(2, '0')}</span> total</span>
      </div>
      {edl.rationale && (
        <p className="text-xs text-zinc-400 leading-relaxed border-l-2 border-zinc-700 pl-3">
          {edl.rationale}
        </p>
      )}
      <details className="text-xs">
        <summary className="text-zinc-600 cursor-pointer hover:text-zinc-400 transition-colors">Show EDL entries</summary>
        <div className="mt-2 flex flex-col gap-1 max-h-48 overflow-y-auto">
          {edl.entries.map((e, i) => (
            <div key={i} className={`flex gap-2 py-0.5 ${e.type === 'a-roll' ? 'text-blue-400' : 'text-violet-400'}`}>
              <span className="font-mono w-4">{e.type === 'a-roll' ? 'A' : 'B'}</span>
              <span className="text-zinc-500 font-mono">{e.clipId}</span>
              <span className="text-zinc-600 font-mono">{e.sourceStart.toFixed(1)}–{e.sourceEnd.toFixed(1)}s</span>
              {e.type === 'a-roll' && <span className="text-zinc-500 truncate">{e.transcriptText}</span>}
              {e.type === 'b-roll' && <span className="text-zinc-500 truncate">{e.reason}</span>}
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

function TranscriptSection({ transcript }: { transcript: import('@shared/types').Transcript }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full text-left"
      >
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Transcript</h2>
        <span className="text-xs text-zinc-600">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {open && <TranscriptView transcript={transcript} />}
    </section>
  )
}

function ClipTable({ clips, label, color }: { clips: ClipMeta[]; label: string; color: 'blue' | 'violet' }) {
  if (!clips.length) return null
  const dot = color === 'blue' ? 'bg-blue-500' : 'bg-violet-500'
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <span className="text-xs font-mono text-zinc-400">{label}</span>
        <span className="text-xs text-zinc-600">({clips.length})</span>
      </div>
      <table className="w-full text-xs text-zinc-400 border-collapse">
        <thead><tr className="border-b border-zinc-800">
          <th className="text-left py-1 pr-4 font-normal text-zinc-600">File</th>
          <th className="text-right py-1 pr-4 font-normal text-zinc-600">Duration</th>
          <th className="text-left py-1 font-normal text-zinc-600">Notes</th>
        </tr></thead>
        <tbody>{clips.map((c) => (
          <tr key={c.path} className="border-b border-zinc-800/50">
            <td className="py-1 pr-4 text-zinc-300 font-mono">{c.path.split('/').pop()}</td>
            <td className="py-1 pr-4 text-right tabular-nums">{c.duration > 0 ? `${Math.floor(c.duration / 60)}:${String(Math.round(c.duration % 60)).padStart(2, '0')}` : '—'}</td>
            <td className="py-1 text-zinc-500 italic">
              {c.warning && <span className="text-red-400 not-italic">⚠ {c.warning}</span>}
              {!c.warning && c.description && c.description}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
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

function Spinner() {
  return (
    <svg className="animate-spin text-zinc-400" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

// ── PlanProgress ──────────────────────────────────────────────────────────────

const EXPECTED_CHARS = 6000

function PlanProgress({ chars, provider, label }: { chars: number; provider?: string; label: string }) {
  const hasStream = provider === 'openai-compat' && chars > 0
  const fillPct = hasStream ? Math.min((chars / EXPECTED_CHARS) * 90, 90) : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-xs text-zinc-400">
          {label}{hasStream ? ` (${(chars / 1000).toFixed(1)}k chars)` : ''}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
        {hasStream ? (
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-150 ease-out"
            style={{ width: `${fillPct}%` }}
          />
        ) : (
          <div className="h-full w-1/3 rounded-full bg-blue-500/60" style={{ animation: 'shimmer 1.4s ease-in-out infinite' }} />
        )}
      </div>
    </div>
  )
}
