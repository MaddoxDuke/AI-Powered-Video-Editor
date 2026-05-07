import { IpcMain } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { llmCall } from '../claude/client'
import { proposeAnimationPlanTool } from '../claude/tools'
import type { EDL, EDLEntry, Transcript, AnimationCue, AnimationPlan, AppSettings } from '@shared/types'

/**
 * Fallback: build combined-video transcript directly from each A-roll entry's
 * transcriptText field. Used when the full word-level Transcript is not
 * available (e.g. the user loaded a saved EDL and an existing video without
 * going through the transcription step in the current session).
 */
function buildTranscriptFromEDL(edl: EDL): string {
  const lines: string[] = ['## Combined video transcript (from EDL)\n']
  let clock = 0

  for (const entry of edl.entries) {
    if (entry.type === 'a-roll') {
      const text = (entry as Extract<EDLEntry, { type: 'a-roll' }>).transcriptText?.trim()
      if (text) lines.push(`[${fmtTime(clock)}] ${text}`)
      clock += entry.sourceEnd - entry.sourceStart
    } else if (entry.type === 'b-roll') {
      if (entry.timelapse) {
        clock += Math.min(8, (entry.sourceEnd - entry.sourceStart) / (entry.timelapseSpeed ?? 8))
      } else if (entry.transition) {
        clock += Math.min(4, entry.sourceEnd - entry.sourceStart)
      }
    }
  }

  return lines.length > 1 ? lines.join('\n') : '## Combined video transcript\n(no text found in EDL)\n'
}

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

const BLOCK_SECONDS = 30

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = String(Math.round(sec % 60)).padStart(2, '0')
  return `${m}:${s}`
}

/**
 * Build a combined-video transcript from the EDL + word-level transcript.
 * A-roll entries have their source timestamps mapped to final-video time.
 * Non-A-roll entries (b-roll, timelapse, transition) advance the clock but
 * contribute no words.
 */
function buildCombinedTranscript(edl: EDL, transcript: Transcript): string {
  // Index words by clipId
  const byClip = new Map<string, typeof transcript.segments>()
  for (const seg of transcript.segments) {
    const arr = byClip.get(seg.clipId) ?? []
    arr.push(seg)
    byClip.set(seg.clipId, arr)
  }

  // Bucket words into 30s blocks keyed by their final-video time
  const blocks = new Map<number, string[]>()
  let clock = 0  // current position in final video (seconds)

  for (const entry of edl.entries) {
    if (entry.type === 'a-roll') {
      const aEntry = entry as Extract<EDLEntry, { type: 'a-roll' }>
      const segDuration = aEntry.sourceEnd - aEntry.sourceStart
      const words = byClip.get(aEntry.clipId) ?? []

      for (const word of words) {
        if (word.start < aEntry.sourceStart || word.start > aEntry.sourceEnd) continue
        // Map source time → final video time
        const offsetInSeg = word.start - aEntry.sourceStart
        const finalTime = clock + offsetInSeg
        const bucket = Math.floor(finalTime / BLOCK_SECONDS) * BLOCK_SECONDS
        const arr = blocks.get(bucket) ?? []
        arr.push(word.text)
        blocks.set(bucket, arr)
      }

      clock += segDuration
    } else if (entry.type === 'b-roll') {
      // B-roll overlays don't advance clock (they play over A-roll audio)
      // Standalone timelapse/transition clips do advance clock
      if (entry.timelapse) {
        const speed = entry.timelapseSpeed ?? 8
        const sourceDur = entry.sourceEnd - entry.sourceStart
        const outputDur = Math.min(8, sourceDur / speed)
        clock += outputDur
      } else if (entry.transition) {
        const sourceDur = entry.sourceEnd - entry.sourceStart
        const outputDur = Math.min(4, sourceDur)
        clock += outputDur
      }
      // Regular b-roll overlay: no clock advance (plays over a-roll)
    }
  }

  if (blocks.size === 0) return '## Combined video transcript\n(no words found)\n'

  const lines: string[] = ['## Combined video transcript\n']
  for (const [t, ws] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`[${fmtTime(t)}] ${ws.join(' ')}`)
  }
  return lines.join('\n')
}

function validateAnimationPlan(raw: unknown, combinedDuration: number): AnimationPlan {
  const obj = raw as { cues?: unknown[]; rationale?: string }
  if (!Array.isArray(obj.cues)) throw new Error('Animation plan missing cues array')
  if (typeof obj.rationale !== 'string') throw new Error('Animation plan missing rationale')

  const cues: AnimationCue[] = obj.cues.map((c, i) => {
    const cue = c as Record<string, unknown>

    if (!cue.id || typeof cue.id !== 'string') throw new Error(`Cue ${i} missing id`)
    if (typeof cue.startInFinal !== 'number') throw new Error(`Cue ${i} missing startInFinal`)
    if (typeof cue.duration !== 'number') throw new Error(`Cue ${i} missing duration`)
    if (!cue.kind || typeof cue.kind !== 'string') throw new Error(`Cue ${i} missing kind`)
    if (!['lower-third', 'callout', 'kinetic-text', 'data-card'].includes(cue.kind as string)) {
      throw new Error(`Cue ${i} has unknown kind: ${cue.kind}`)
    }
    if (!cue.triggerText || typeof cue.triggerText !== 'string') throw new Error(`Cue ${i} missing triggerText`)
    if (!cue.reason || typeof cue.reason !== 'string') throw new Error(`Cue ${i} missing reason`)

    // Validate variables object
    const rawVars = cue.variables
    const variables: Record<string, string> = {}
    if (rawVars && typeof rawVars === 'object') {
      for (const [k, v] of Object.entries(rawVars as Record<string, unknown>)) {
        variables[k] = String(v)
      }
    }

    // Clamp startInFinal to valid range
    const startInFinal = Math.max(1.0, Math.min(
      Number(cue.startInFinal),
      combinedDuration - Number(cue.duration) - 0.5
    ))

    // Clamp duration to 2–6s
    const duration = Math.max(2, Math.min(6, Number(cue.duration)))

    return {
      id: String(cue.id),
      startInFinal,
      duration,
      kind: cue.kind as AnimationCue['kind'],
      triggerText: String(cue.triggerText),
      variables,
      reason: String(cue.reason)
    }
  })

  // Sort by startInFinal
  cues.sort((a, b) => a.startInFinal - b.startInFinal)

  return { cues, rationale: obj.rationale }
}

function imageToVision(filePath: string): { base64: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp' } {
  const ext = require('path').extname(filePath).toLowerCase()
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
  return { base64: require('fs').readFileSync(filePath).toString('base64'), mimeType }
}

export function registerPlanAnimateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'animate:plan',
    async (
      event,
      edl: EDL,
      transcript: Transcript | null,
      combinedDuration: number,
      settings: AppSettings,
      apiKey: string,
      styleText?: string | null,
      styleImagePath?: string | null
    ) => {
      try {
        const systemPrompt = loadPrompt('plan-animate')

        // Prefer word-level transcript (more accurate timestamps) but fall
        // back gracefully to the EDL's transcriptText fields when the user
        // is working from a saved EDL + existing video without re-transcribing.
        const combinedTranscript = transcript
          ? buildCombinedTranscript(edl, transcript)
          : buildTranscriptFromEDL(edl)
        const durationMins = Math.floor(combinedDuration / 60)
        const durationSecs = Math.round(combinedDuration % 60)

        let userMessage = [
          `Total combined video duration: ${durationMins}:${String(durationSecs).padStart(2, '0')} (${combinedDuration.toFixed(1)}s)`,
          '',
          `## EDL rationale\n${edl.rationale}`,
          '',
          combinedTranscript,
        ].join('\n')

        if (styleText) {
          userMessage += `\n\n## Animation style preference\n${styleText}`
        }

        if (styleImagePath && settings.llmProvider !== 'anthropic') {
          userMessage += `\n(Style reference image provided but not supported by current LLM provider — describe the style in text instead.)`
        }

        const modelLabel =
          settings.llmProvider === 'anthropic' ? (settings.anthropicModel || 'claude-sonnet-4-5')
          : settings.llmProvider === 'openai-compat' ? (settings.openaiCompatModel || 'local-model')
          : settings.ollamaModel
        console.log('[plan-animate] prompt chars:', userMessage.length + systemPrompt.length,
          '| provider:', settings.llmProvider,
          '| model:', modelLabel)

        const visionImages =
          styleImagePath && settings.llmProvider === 'anthropic'
            ? [imageToVision(styleImagePath)]
            : undefined

        const response = await llmCall(
          {
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            tools: [proposeAnimationPlanTool],
            forceTool: 'propose_animation_plan',
            maxTokens: 2048,
            ...(visionImages ? { visionImages } : {})
          },
          settings,
          apiKey,
          (chars) => { event.sender.send('animate:plan-progress', { chars }) }
        )

        const toolCall = response.toolCalls.find((t) => t.name === 'propose_animation_plan')
        if (!toolCall) {
          throw new Error('Model did not return a valid animation plan. Response: ' + response.text.slice(0, 500))
        }

        const plan = validateAnimationPlan(toolCall.input, combinedDuration)
        return { ok: true, plan }
      } catch (err: unknown) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle(
    'animate:revise',
    async (
      _event,
      plan: AnimationPlan,
      request: string,
      combinedDuration: number,
      settings: AppSettings,
      apiKey: string
    ) => {
      try {
        const systemPrompt = loadPrompt('revise-animate')

        const userMessage = [
          `## Current animation plan`,
          JSON.stringify(plan, null, 2),
          '',
          `## Revision request`,
          request,
        ].join('\n')

        const response = await llmCall(
          {
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            tools: [proposeAnimationPlanTool],
            forceTool: 'propose_animation_plan',
            maxTokens: 2048
          },
          settings,
          apiKey
        )

        const toolCall = response.toolCalls.find((t) => t.name === 'propose_animation_plan')
        if (!toolCall) {
          throw new Error('Model did not return a valid animation plan. Response: ' + response.text.slice(0, 500))
        }

        const revised = validateAnimationPlan(toolCall.input, combinedDuration)
        return { ok: true, plan: revised }
      } catch (err: unknown) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
