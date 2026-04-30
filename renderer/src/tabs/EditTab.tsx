import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { FolderPicker } from '../components/FolderPicker'
import { RenderProgress } from '../components/RenderProgress'
import { TranscriptView } from '../components/TranscriptView'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { ClipMeta, EDL } from '@shared/types'
import { CopyButton } from '../components/CopyButton'

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

type RenderState =
  | { status: 'idle' }
  | { status: 'running'; stage: string; percent: number }
  | { status: 'done'; outputPath: string }
  | { status: 'error'; message: string }

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

  const [txState, setTxState] = useState<TranscribeState>({ status: 'idle' })
  const [planState, setPlanState] = useState<PlanState>({ status: 'idle' })
  const [renderState, setRenderState] = useState<RenderState>({ status: 'idle' })
  const unsubRef = useRef<(() => void) | null>(null)

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
    })
    return () => unsub()
  }, [])

  function handleARollPick(folder: string, clips: ClipMeta[]) {
    setARollFolder(folder); setARollClips(clips); setTxState({ status: 'idle' })
  }
  function handleBRollPick(folder: string, clips: ClipMeta[]) {
    setBRollFolder(folder); setBRollClips(clips)
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
    const apiKey = await window.api.getApiKey()
    const result = await window.api.planEdit(transcript, aRollClips, bRollClips, settings, apiKey)
    if (!result.ok || !result.edl) {
      setPlanState({ status: 'error', message: result.error ?? 'Planning failed' })
      return
    }
    setEDL(result.edl)
    setPlanState({ status: 'idle' })
  }

  async function handleRender() {
    if (!edl || !transcript || !settings) return
    setRenderState({ status: 'running', stage: 'Starting…', percent: 0 })
    const result = await window.api.renderCut(edl, aRollClips, bRollClips, transcript, settings.exportFolder)
    if (!result.ok || !result.outputPath) {
      setRenderState({ status: 'error', message: result.error ?? 'Render failed' })
      return
    }
    setCombinedVideo(result.outputPath)
    setRenderState({ status: 'done', outputPath: result.outputPath })
  }

  const isTranscribing = txState.status === 'running' || txState.status === 'checking'

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
        <section className="flex flex-col gap-3 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Transcript</h2>
          <TranscriptView transcript={transcript} />
        </section>
      )}

      {/* ── Plan edit ──────────────────────────────────────────────────────── */}
      {transcript && transcript.segments.length > 0 && (
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Edit plan</h2>

          {planState.status === 'error' && <ErrorBox message={planState.message} />}
          {planState.status === 'running' && (
            <PlanProgress chars={planState.chars} provider={settings?.llmProvider} />
          )}

          {edl && (
            <EDLSummary edl={edl} />
          )}

          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handlePlanEdit}
              disabled={planState.status === 'running'}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors disabled:opacity-40"
            >
              {edl ? 'Re-plan edit' : 'Plan edit with AI'}
            </button>
          </div>
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
            </div>
          )}

          {renderState.status !== 'done' && (
            <button
              onClick={handleRender}
              disabled={renderState.status === 'running'}
              className="self-start px-4 py-2 rounded bg-green-700 hover:bg-green-600 text-white text-sm font-medium transition-colors disabled:opacity-40"
            >
              {renderState.status === 'running' ? 'Rendering…' : 'Render combined.mp4'}
            </button>
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
            <td className="py-1">{c.warning && <span className="text-red-400">⚠ {c.warning}</span>}</td>
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
// Shows a real streaming bar for openai-compat (token SSE), and an animated
// indeterminate bar for Ollama/Anthropic where we don't have token events.

const EXPECTED_CHARS = 6000  // typical JSON EDL output is 4–8k chars

function PlanProgress({ chars, provider }: { chars: number; provider?: string }) {
  const hasStream = provider === 'openai-compat' && chars > 0
  // Fill to max 90% so the bar never appears "done" before we get the result back
  const fillPct = hasStream ? Math.min((chars / EXPECTED_CHARS) * 90, 90) : 0

  const label = provider === 'ollama'
    ? 'Local model is planning the edit…'
    : provider === 'openai-compat'
    ? `Generating edit plan… ${chars > 0 ? `(${(chars / 1000).toFixed(1)}k chars)` : ''}`
    : 'Claude is planning the edit…'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Spinner />
        <span className="text-xs text-zinc-400">{label}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
        {hasStream ? (
          // Real progress driven by token stream
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-150 ease-out"
            style={{ width: `${fillPct}%` }}
          />
        ) : (
          // Indeterminate shimmer for providers without streaming
          <div className="h-full w-1/3 rounded-full bg-blue-500/60" style={{ animation: 'shimmer 1.4s ease-in-out infinite' }} />
        )}
      </div>
    </div>
  )
}
