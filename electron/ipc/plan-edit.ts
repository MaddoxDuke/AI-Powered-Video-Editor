import { IpcMain } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { llmCall } from '../claude/client'
import { proposeEDLTool } from '../claude/tools'
import type { Transcript, ClipMeta, EDL, EDLEntry, AppSettings } from '@shared/types'

function loadPrompt(name: string): string {
  const candidates = [
    join(__dirname, '..', '..', 'electron', 'claude', 'prompts', `${name}.md`),
    join(__dirname, '..', 'claude', 'prompts', `${name}.md`),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf-8') } catch { /* try next */ }
  }
  throw new Error(`Prompt file not found: ${name}.md`)
}

const BLOCK_SECONDS = 30  // one timestamp per block — keeps the prompt compact

function buildTranscriptContext(transcript: Transcript, aRollClips: ClipMeta[]): string {
  const clipMap = new Map(aRollClips.map((c) => [clipId(c.path), c]))

  const byClip = new Map<string, typeof transcript.segments>()
  for (const seg of transcript.segments) {
    const arr = byClip.get(seg.clipId) ?? []
    arr.push(seg)
    byClip.set(seg.clipId, arr)
  }

  const parts: string[] = ['## A-roll transcripts\n']
  for (const [id, words] of byClip) {
    const clip = clipMap.get(id)
    const dur = clip ? ` (${clip.duration.toFixed(1)}s)` : ''
    parts.push(`### Clip: ${id}${dur}`)

    // Group words into BLOCK_SECONDS-wide buckets, one timestamp per bucket.
    // e.g. "[0:00] first thirty seconds of speech [0:30] next thirty..."
    // Reduces a 20-min transcript from ~57K chars to ~12K chars.
    const blocks = new Map<number, string[]>()
    for (const w of words) {
      const bucket = Math.floor(w.start / BLOCK_SECONDS) * BLOCK_SECONDS
      const arr = blocks.get(bucket) ?? []
      arr.push(w.text)
      blocks.set(bucket, arr)
    }

    const lines: string[] = []
    for (const [t, ws] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`[${fmtTime(t)}] ${ws.join(' ')}`)
    }

    parts.push(lines.join('\n'))
    parts.push('')
  }
  return parts.join('\n')
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = String(sec % 60).padStart(2, '0')
  return `${m}:${s}`
}

function buildBRollContext(bRollClips: ClipMeta[]): string {
  if (!bRollClips.length) return '## B-roll inventory\n(none)\n'
  const lines = ['## B-roll inventory\n']
  for (const c of bRollClips) {
    lines.push(`- ${clipId(c.path)}  (${c.duration.toFixed(1)}s)`)
  }
  return lines.join('\n')
}

function clipId(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.[^.]+$/, '')
}

/**
 * Fallback for local models that output the EDL JSON directly in their response
 * text instead of via a proper tool call. Finds the outermost JSON object,
 * tries to parse it, and if the JSON was truncated (hit max_tokens) attempts
 * a best-effort repair by closing any open brackets.
 */
function extractJsonFromText(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  // Walk the string tracking brace/bracket depth
  const opens: string[] = []
  const matchClose: Record<string, string> = { '{': '}', '[': ']' }
  let inString = false
  let escape = false
  let end = -1

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue

    if (ch === '{' || ch === '[') {
      opens.push(ch)
    } else if (ch === '}' || ch === ']') {
      opens.pop()
      if (opens.length === 0) { end = i; break }
    }
  }

  if (end !== -1) {
    // Complete JSON found — try to parse as-is
    try { return JSON.parse(text.slice(start, end + 1)) } catch { return null }
  }

  // JSON was truncated (hit max_tokens). Attempt repair: close all open
  // structures, strip any trailing partial value, then parse.
  let partial = text.slice(start)

  // Remove trailing incomplete string, number, or comma
  partial = partial.replace(/,\s*$/, '')          // trailing comma
  partial = partial.replace(/"[^"]*$/, '"..."')   // unterminated string → close it

  // Close any still-open brackets/braces in reverse order
  const closing = opens.map((o) => matchClose[o]).reverse().join('')
  partial += closing

  try { return JSON.parse(partial) } catch { return null }
}

function validateEDL(raw: unknown): EDL {
  const obj = raw as { entries?: unknown[]; rationale?: string }
  if (!Array.isArray(obj.entries)) throw new Error('EDL missing entries array')
  if (typeof obj.rationale !== 'string') throw new Error('EDL missing rationale')

  const entries: EDLEntry[] = obj.entries.map((e, i) => {
    const entry = e as Record<string, unknown>
    if (!entry.type || !entry.clipId) throw new Error(`Entry ${i} missing type or clipId`)
    if (typeof entry.sourceStart !== 'number' || typeof entry.sourceEnd !== 'number') {
      throw new Error(`Entry ${i} missing sourceStart/sourceEnd`)
    }
    if (entry.type === 'a-roll') {
      return {
        type: 'a-roll',
        clipId: String(entry.clipId),
        sourceStart: Number(entry.sourceStart),
        sourceEnd: Number(entry.sourceEnd),
        // transcriptText is filled in post-hoc by fillTranscriptText()
        transcriptText: String(entry.transcriptText ?? '')
      } satisfies EDLEntry
    } else {
      return {
        type: 'b-roll',
        clipId: String(entry.clipId),
        sourceStart: Number(entry.sourceStart),
        sourceEnd: Number(entry.sourceEnd),
        reason: String(entry.reason ?? ''),
        ...(entry.overUnderlying ? {
          overUnderlying: {
            aRollClipId: String((entry.overUnderlying as Record<string, unknown>).aRollClipId),
            aRollStart: Number((entry.overUnderlying as Record<string, unknown>).aRollStart),
            aRollEnd: Number((entry.overUnderlying as Record<string, unknown>).aRollEnd)
          }
        } : {})
      } satisfies EDLEntry
    }
  })

  const aRollDuration = entries
    .filter((e) => e.type === 'a-roll')
    .reduce((sum, e) => sum + (e.sourceEnd - e.sourceStart), 0)

  return { entries, totalDuration: aRollDuration, rationale: obj.rationale }
}

/**
 * Snaps each A-roll entry's sourceStart/sourceEnd to the nearest actual word
 * boundary in the transcript, then adds a small pre/post-roll buffer so cuts
 * land cleanly on natural speech pauses rather than mid-word or mid-breath.
 *
 * The model works from 30-second block timestamps so its times are approximate.
 * This pass makes every cut frame-accurate.
 */
const PRE_ROLL  = 0.15   // seconds of silence before first word
const POST_ROLL = 0.35   // seconds of silence after last word
const SNAP_WINDOW = 8    // search ±8 s around the model's timestamp

function snapToWordBoundaries(edl: EDL, transcript: Transcript): EDL {
  // Index words by clipId for fast lookup
  const byClip = new Map<string, typeof transcript.segments>()
  for (const w of transcript.segments) {
    const arr = byClip.get(w.clipId) ?? []
    arr.push(w)
    byClip.set(w.clipId, arr)
  }

  const entries = edl.entries.map((entry) => {
    if (entry.type !== 'a-roll') return entry
    const words = byClip.get(entry.clipId)
    if (!words || words.length === 0) return entry

    const { sourceStart, sourceEnd } = entry

    // Find the word whose start is closest to sourceStart (within SNAP_WINDOW)
    const startCandidates = words.filter(
      (w) => Math.abs(w.start - sourceStart) <= SNAP_WINDOW
    )
    const bestStart = startCandidates.length
      ? startCandidates.reduce((best, w) =>
          Math.abs(w.start - sourceStart) < Math.abs(best.start - sourceStart) ? w : best
        )
      : null

    // Find the word whose end is closest to sourceEnd (within SNAP_WINDOW)
    const endCandidates = words.filter(
      (w) => Math.abs(w.end - sourceEnd) <= SNAP_WINDOW
    )
    const bestEnd = endCandidates.length
      ? endCandidates.reduce((best, w) =>
          Math.abs(w.end - sourceEnd) < Math.abs(best.end - sourceEnd) ? w : best
        )
      : null

    const snappedStart = bestStart
      ? Math.max(0, bestStart.start - PRE_ROLL)
      : sourceStart
    const snappedEnd = bestEnd
      ? bestEnd.end + POST_ROLL
      : sourceEnd

    // Sanity: don't let snapping invert the segment
    if (snappedEnd <= snappedStart) return entry

    return { ...entry, sourceStart: snappedStart, sourceEnd: snappedEnd }
  })

  const aRollDuration = entries
    .filter((e) => e.type === 'a-roll')
    .reduce((sum, e) => sum + (e.sourceEnd - e.sourceStart), 0)

  return { ...edl, entries, totalDuration: aRollDuration }
}

/**
 * Fills in transcriptText on every A-roll entry from the actual transcript
 * segments. This means the model doesn't need to repeat transcript text in
 * its output — saves 30-50% of output tokens on long projects.
 */
function fillTranscriptText(edl: EDL, transcript: Transcript): EDL {
  const entries = edl.entries.map((entry) => {
    if (entry.type !== 'a-roll') return entry
    // Already populated by the model — keep it
    if (entry.transcriptText && entry.transcriptText.length > 5) return entry

    const words = transcript.segments
      .filter(
        (w) =>
          w.clipId === entry.clipId &&
          w.start >= entry.sourceStart - 0.5 &&
          w.end <= entry.sourceEnd + 0.5
      )
      .map((w) => w.text)
      .join(' ')
      .trim()

    return { ...entry, transcriptText: words || '' }
  })
  return { ...edl, entries }
}

export function registerPlanEditHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'plan-edit:plan',
    async (
      event,
      transcript: Transcript,
      aRollClips: ClipMeta[],
      bRollClips: ClipMeta[],
      settings: AppSettings,
      apiKey: string
    ) => {
      try {
        const systemPrompt = loadPrompt('plan-edit')
        const totalSourceSecs = aRollClips.reduce((s, c) => s + c.duration, 0)
        const totalSourceMins = (totalSourceSecs / 60).toFixed(1)
        const durationNote = settings.targetDurationAuto
          ? `Total source footage: ${totalSourceMins} minutes. Target duration: use your judgment per the guidelines in the system prompt (8–12% of source, aiming for 8–18 minutes).`
          : `Total source footage: ${totalSourceMins} minutes. Target duration: aim for approximately ${settings.targetDurationMinutes} minutes.`

        const userMessage = [
          durationNote,
          '',
          buildTranscriptContext(transcript, aRollClips),
          buildBRollContext(bRollClips)
        ].join('\n')

        const modelLabel =
          settings.llmProvider === 'anthropic' ? 'claude-sonnet-4-5'
          : settings.llmProvider === 'openai-compat' ? (settings.openaiCompatModel || 'local-model')
          : settings.ollamaModel
        console.log('[plan-edit] prompt chars:', userMessage.length + systemPrompt.length,
          '| transcript words:', transcript.segments.length,
          '| provider:', settings.llmProvider,
          '| model:', modelLabel)

        const response = await llmCall(
          {
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            tools: [proposeEDLTool],
            forceTool: 'propose_edl',
            maxTokens: 16384
          },
          settings,
          apiKey,
          (chars) => { event.sender.send('plan-edit:progress', { chars }) }
        )

        const toolCall = response.toolCalls.find((t) => t.name === 'propose_edl')
        const rawInput = toolCall
          ? toolCall.input
          : extractJsonFromText(response.text)

        if (!rawInput) {
          throw new Error('Model did not return a valid EDL. Response: ' + response.text.slice(0, 500))
        }

        const edl = fillTranscriptText(snapToWordBoundaries(validateEDL(rawInput), transcript), transcript)
        return { ok: true, edl }
      } catch (err: unknown) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'plan-edit:revise',
    async (
      event,
      currentEDL: EDL,
      transcript: Transcript,
      aRollClips: ClipMeta[],
      bRollClips: ClipMeta[],
      revisionRequest: string,
      settings: AppSettings,
      apiKey: string
    ) => {
      try {
        const systemPrompt = loadPrompt('revise-edit')

        const userMessage = [
          `## Revision request\n${revisionRequest}`,
          '',
          `## Current EDL\n\`\`\`json\n${JSON.stringify(currentEDL, null, 2)}\n\`\`\``,
          '',
          buildTranscriptContext(transcript, aRollClips),
          buildBRollContext(bRollClips)
        ].join('\n')

        const response = await llmCall(
          {
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            tools: [proposeEDLTool],
            forceTool: 'propose_edl',
            maxTokens: 16384
          },
          settings,
          apiKey,
          (chars) => { event.sender.send('plan-edit:progress', { chars }) }
        )

        const toolCall = response.toolCalls.find((t) => t.name === 'propose_edl')
        const rawInput = toolCall
          ? toolCall.input
          : extractJsonFromText(response.text)

        if (!rawInput) {
          throw new Error('Model did not return a valid EDL. Response: ' + response.text.slice(0, 500))
        }

        const edl = fillTranscriptText(snapToWordBoundaries(validateEDL(rawInput), transcript), transcript)
        return { ok: true, edl }
      } catch (err: unknown) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
