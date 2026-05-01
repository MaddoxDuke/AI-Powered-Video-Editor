/**
 * Applies an EDL to produce combined.mp4.
 *
 * Strategy:
 *  1. Trim each A-roll segment to a temp file (with checkpointing).
 *  2. Concat all A-roll clips into a base track.
 *  3. Overlay B-roll entries using filter_complex.
 *
 * Checkpointing: every completed trim is recorded in a manifest.json inside
 * the .render-tmp folder. If the render is interrupted and re-run with the
 * same output path, already-trimmed segments are reused — no re-work.
 */

import { join, dirname, basename, extname } from 'path'
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { runFFmpeg, probeSize, probeDuration } from './ffmpeg'
import type { EDL, EDLEntry, ClipMeta } from '@shared/types'

// ── Chapter helpers ───────────────────────────────────────────────────────────

function fmtChapterTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Writes a YouTube-compatible chapters file (chapters_[id].txt) alongside
 * the rendered video. Returns the path written, or null if no chapters.
 */
export function writeChaptersFile(edl: EDL, outputPath: string): string | null {
  if (!edl.chapters || edl.chapters.length === 0) return null

  const timeline = buildATimeline(edl.entries)

  const lines: string[] = []
  for (const chapter of edl.chapters) {
    const seg = timeline.find((s) => s.clipId === chapter.aRollClipId)
    if (!seg) continue
    const offset = Math.max(0, chapter.aRollStart - seg.sourceStart)
    const outputTime = seg.outputStart + offset
    lines.push(`${fmtChapterTime(outputTime)} ${chapter.title}`)
  }

  if (!lines.length) return null

  // Ensure first chapter is 0:00 (YouTube requirement)
  if (!lines[0].startsWith('0:00')) lines.unshift('0:00 Intro')

  const dir = dirname(outputPath)
  const id = basename(outputPath, extname(outputPath)).replace(/^(combined|draft)_/, '')
  const chaptersPath = join(dir, `chapters_${id}.txt`)
  writeFileSync(chaptersPath, lines.join('\n'))
  return chaptersPath
}

export type RenderProgress = { stage: string; percent: number }

// ── Clip lookup ───────────────────────────────────────────────────────────────

/**
 * Finds a clip by ID using a three-tier strategy:
 *   1. Exact basename match (case-insensitive)
 *   2. Partial match — the clip filename contains the ID or vice-versa
 *   3. Returns null + caller decides how to handle
 */
function findClipPath(clipId: string, clips: ClipMeta[]): string | null {
  const needle = clipId.toLowerCase().trim()

  // Tier 1: exact case-insensitive match on basename without extension
  const exact = clips.find((c) => basename(c.path, extname(c.path)).toLowerCase() === needle)
  if (exact) return exact.path

  // Tier 2: one contains the other (handles minor prefix/suffix differences)
  const partial = clips.find((c) => {
    const id = basename(c.path, extname(c.path)).toLowerCase()
    return id.includes(needle) || needle.includes(id)
  })
  if (partial) return partial.path

  return null
}

function availableClipIds(clips: ClipMeta[]): string {
  return clips.map((c) => basename(c.path, extname(c.path))).join(', ')
}

// ── Checkpoint manifest ───────────────────────────────────────────────────────

type Manifest = {
  /** Map from segment index (string) to the trimmed file path */
  aroll: Record<string, string>
  broll: Record<string, string>
}

function manifestPath(tmp: string): string {
  return join(tmp, 'manifest.json')
}

function loadManifest(tmp: string): Manifest {
  const p = manifestPath(tmp)
  if (!existsSync(p)) return { aroll: {}, broll: {} }
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Manifest
  } catch {
    return { aroll: {}, broll: {} }
  }
}

function saveManifest(tmp: string, manifest: Manifest): void {
  writeFileSync(manifestPath(tmp), JSON.stringify(manifest, null, 2))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir(outputPath: string): string {
  const dir = join(dirname(outputPath), '.render-tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    try { if (existsSync(p)) unlinkSync(p) } catch { /* best effort */ }
  }
}

const MAX_TIMELAPSE_SECONDS = 8

/** Trim a source clip to [start, end] seconds and re-encode. */
async function trimClip(
  sourcePath: string,
  start: number,
  end: number,
  outputPath: string,
  draft: boolean,
  onProgress?: (p: number) => void
): Promise<void> {
  await runFFmpeg([
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    '-c:v', 'libx264',
    '-preset', draft ? 'ultrafast' : 'fast',
    '-crf',   draft ? '28'        : '18',
    '-c:a', 'aac', '-b:a', draft ? '128k' : '192k',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ], onProgress ? (p) => onProgress(p.percent / 100) : undefined)
}

/**
 * Trim a transition clip (standalone, no voice).
 * Always outputs a silent stereo audio track so the concat stream is consistent.
 */
async function trimTransitionClip(
  sourcePath: string,
  start: number,
  end: number,
  outputPath: string,
  draft: boolean
): Promise<void> {
  const duration = end - start
  await runFFmpeg([
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    '-f', 'lavfi', '-i', `aevalsrc=0:channel_layout=stereo:sample_rate=48000:duration=${duration}`,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', draft ? 'ultrafast' : 'fast',
    '-crf',   draft ? '28'        : '18',
    '-c:a', 'aac', '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ])
}

/**
 * Trim and speed up a timelapse clip. Output duration is capped at
 * MAX_TIMELAPSE_SECONDS regardless of source length or speed setting.
 */
async function trimTimelapse(
  sourcePath: string,
  start: number,
  end: number,
  speed: number,
  outputPath: string,
  draft: boolean
): Promise<void> {
  const sourceDuration = end - start
  const rawOutput = sourceDuration / speed
  const outputDuration = Math.min(MAX_TIMELAPSE_SECONDS, rawOutput)
  // Recalculate actual speed needed to fit within the cap
  const actualSpeed = sourceDuration / outputDuration
  const pts = (1 / actualSpeed).toFixed(6)

  // Generate a silent audio track matching the output duration.
  // Every concat segment must have both video and audio streams — missing
  // audio causes sync drift and mute sections in the final video.
  await runFFmpeg([
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    '-f', 'lavfi', '-i', `aevalsrc=0:channel_layout=stereo:sample_rate=48000:duration=${outputDuration}`,
    '-vf', `setpts=${pts}*PTS`,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'libx264',
    '-preset', draft ? 'ultrafast' : 'fast',
    '-crf',   draft ? '28'        : '22',
    '-c:a', 'aac', '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ])
}

// ── Main render ───────────────────────────────────────────────────────────────

export async function applyEDL(
  edl: EDL,
  aRollClips: ClipMeta[],
  bRollClips: ClipMeta[],
  outputPath: ClipMeta['path'],
  onProgress: (p: RenderProgress) => void,
  draft = false
): Promise<void> {
  const tmp = tmpDir(outputPath)
  const manifest = loadManifest(tmp)
  const toDeleteOnSuccess: string[] = []

  try {
    // ── Step 1: trim A-roll + standalone timelapse segments ───────────────────
    // Process EDL entries in order, treating both A-roll and standalone timelapse
    // as segments that appear sequentially in the final concat.
    const aRollEntries = edl.entries.filter(
      (e): e is Extract<EDLEntry, { type: 'a-roll' }> => e.type === 'a-roll'
    )
    const timelapseEntries = edl.entries.filter(
      (e): e is Extract<EDLEntry, { type: 'b-roll' }> => e.type === 'b-roll' && !!e.timelapse
    )
    const transitionEntries = edl.entries.filter(
      (e): e is Extract<EDLEntry, { type: 'b-roll' }> => e.type === 'b-roll' && !!e.transition
    )

    // Build ordered sequence of all concat-able segments (A-roll + timelapse + transition)
    type ConcatSegment = { kind: 'aroll' | 'timelapse' | 'transition'; entryIndex: number; entry: EDLEntry }
    const concatSegments: ConcatSegment[] = []
    let aIdx = 0, tlIdx = 0, trIdx = 0
    for (const entry of edl.entries) {
      if (entry.type === 'a-roll') {
        concatSegments.push({ kind: 'aroll', entryIndex: aIdx++, entry })
      } else if (entry.type === 'b-roll' && entry.timelapse) {
        concatSegments.push({ kind: 'timelapse', entryIndex: tlIdx++, entry })
      } else if (entry.type === 'b-roll' && entry.transition) {
        concatSegments.push({ kind: 'transition', entryIndex: trIdx++, entry })
      }
    }

    const skippedClips: string[] = []
    const trimmedPaths: string[] = []

    for (let i = 0; i < concatSegments.length; i++) {
      const seg = concatSegments[i]
      const entry = seg.entry
      const key = `${seg.kind}_${seg.entryIndex}`
      const out = join(tmp, `${seg.kind}_${seg.entryIndex}.mp4`)

      // Check checkpoint
      const cached = manifest.aroll[key]
      if (cached && existsSync(cached)) {
        console.log(`[render] checkpoint hit: ${key} (${entry.clipId})`)
        trimmedPaths.push(cached)
        toDeleteOnSuccess.push(cached)
        continue
      }

      if (seg.kind === 'aroll') {
        const aEntry = entry as Extract<EDLEntry, { type: 'a-roll' }>
        const src = findClipPath(aEntry.clipId, aRollClips)
        if (!src) {
          const msg = `A-roll clip not found: "${aEntry.clipId}" — skipped. Available: ${availableClipIds(aRollClips)}`
          console.warn(`[render] ${msg}`)
          skippedClips.push(aEntry.clipId)
          continue
        }

        onProgress({
          stage: `Trimming A-roll ${seg.entryIndex + 1}/${aRollEntries.length}${draft ? ' (draft)' : ''}`,
          percent: Math.round((i / concatSegments.length) * 40)
        })

        await trimClip(src, aEntry.sourceStart, aEntry.sourceEnd, out, draft)
      } else if (seg.kind === 'timelapse') {
        const tlEntry = entry as Extract<EDLEntry, { type: 'b-roll' }>
        const src = findClipPath(tlEntry.clipId, bRollClips)
        if (!src) {
          console.warn(`[render] Timelapse clip not found: "${tlEntry.clipId}" — skipping`)
          continue
        }

        onProgress({
          stage: `Encoding timelapse ${seg.entryIndex + 1}/${timelapseEntries.length}`,
          percent: Math.round((i / concatSegments.length) * 40)
        })

        const speed = tlEntry.timelapseSpeed ?? 8
        await trimTimelapse(src, tlEntry.sourceStart, tlEntry.sourceEnd, speed, out, draft)
      } else {
        // Transition segment — trim is already baked into sourceStart/sourceEnd by capBRollDuration
        const trEntry = entry as Extract<EDLEntry, { type: 'b-roll' }>
        const src = findClipPath(trEntry.clipId, bRollClips)
        if (!src) {
          console.warn(`[render] Transition clip not found: "${trEntry.clipId}" — skipping`)
          continue
        }

        onProgress({
          stage: `Encoding transition ${seg.entryIndex + 1}/${transitionEntries.length}`,
          percent: Math.round((i / concatSegments.length) * 40)
        })

        await trimTransitionClip(src, trEntry.sourceStart, trEntry.sourceEnd, out, draft)
      }

      trimmedPaths.push(out)
      toDeleteOnSuccess.push(out)
      manifest.aroll[key] = out
      saveManifest(tmp, manifest)
    }

    if (trimmedPaths.length === 0) {
      throw new Error(
        `No A-roll segments could be rendered. Missing clips: ${skippedClips.join(', ')}. ` +
        `Available clip IDs: ${availableClipIds(aRollClips)}`
      )
    }

    // ── Step 2: concat A-roll + timelapse ─────────────────────────────────────
    onProgress({ stage: 'Concatenating', percent: 40 })
    const concatList = join(tmp, 'concat.txt')
    toDeleteOnSuccess.push(concatList)
    writeFileSync(concatList, trimmedPaths.map((p) => `file '${p}'`).join('\n'))

    const concatOut = join(tmp, 'aroll_concat.mp4')
    toDeleteOnSuccess.push(concatOut)
    await runFFmpeg([
      '-f', 'concat', '-safe', '0', '-i', concatList,
      '-c', 'copy',
      concatOut
    ])

    // ── Step 3: overlay B-roll (non-timelapse, non-transition only) ──────────
    const bRollEntries = edl.entries.filter(
      (e): e is Extract<EDLEntry, { type: 'b-roll' }> => e.type === 'b-roll' && !e.timelapse && !e.transition
    )

    const finalise = async () => {
      onProgress({ stage: 'Finalising', percent: 90 })
      if (draft) {
        // Draft: copy as-is, skip loudnorm for speed
        await runFFmpeg(['-i', concatOut, '-c', 'copy', outputPath])
      } else {
        // Full render: repair PTS gaps then normalize audio to -16 LUFS
        await runFFmpeg([
          '-i', concatOut,
          '-c:v', 'copy',
          '-af', 'aresample=async=1000,loudnorm=I=-16:TP=-1.5:LRA=11',
          '-c:a', 'aac', '-b:a', '192k',
          outputPath
        ])
      }
      onProgress({ stage: 'Done', percent: 100 })
    }

    // Draft mode: skip B-roll entirely for fast iteration
    if (draft || !bRollEntries.length) {
      await finalise()
      cleanup(toDeleteOnSuccess)
      cleanup([manifestPath(tmp)])
      return
    }

    const aRollTimeline = buildATimeline(edl.entries)
    const { width, height } = await probeSize(concatOut)

    type OverlayInfo = { path: string; outputStart: number; duration: number }
    const overlays: OverlayInfo[] = []

    for (let i = 0; i < bRollEntries.length; i++) {
      const entry = bRollEntries[i]
      const out = join(tmp, `broll_${i}.mp4`)

      // Check B-roll checkpoint
      const cached = manifest.broll[String(i)]
      if (cached && existsSync(cached)) {
        console.log(`[render] checkpoint hit: broll_${i} (${entry.clipId})`)
        const outputStart = bRollOutputStart(entry, aRollTimeline, aRollEntries)
        overlays.push({ path: cached, outputStart, duration: entry.sourceEnd - entry.sourceStart })
        toDeleteOnSuccess.push(cached)
        continue
      }

      const src = findClipPath(entry.clipId, bRollClips)
      if (!src) {
        console.warn(`[render] B-roll clip not found: "${entry.clipId}" — skipping overlay`)
        continue
      }

      // Clamp sourceEnd to actual clip duration — prevents a 24s clip being
      // used as a 10-minute overlay (the "still image" bug)
      const clipMeta = bRollClips.find((c) => c.path === src)
      const maxEnd = clipMeta ? clipMeta.duration - 0.1 : entry.sourceEnd
      const clampedStart = Math.max(0, entry.sourceStart)
      const clampedEnd   = Math.min(entry.sourceEnd, maxEnd)

      if (clampedEnd - clampedStart < 0.5) {
        console.warn(`[render] B-roll "${entry.clipId}" too short after clamping (${(clampedEnd - clampedStart).toFixed(2)}s) — skipping`)
        continue
      }

      onProgress({
        stage: `Trimming B-roll ${i + 1}/${bRollEntries.length}`,
        percent: 50 + Math.round((i / bRollEntries.length) * 20)
      })

      await trimClip(src, clampedStart, clampedEnd, out, draft)
      toDeleteOnSuccess.push(out)

      manifest.broll[String(i)] = out
      saveManifest(tmp, manifest)

      const outputStart = bRollOutputStart(entry, aRollTimeline, aRollEntries)
      overlays.push({ path: out, outputStart, duration: clampedEnd - clampedStart })
    }

    if (!overlays.length) {
      await finalise()
      cleanup(toDeleteOnSuccess)
      cleanup([manifestPath(tmp)])
      return
    }

    onProgress({ stage: 'Compositing B-roll overlays', percent: 70 })

    // Clamp every overlay to stay within the base video duration.
    // Without this, overlays whose outputStart lands past the end of the base
    // video cause FFmpeg to extend the output with audioless video segments.
    const baseDuration = await probeDuration(concatOut)
    const clampedOverlays = overlays
      .map((ov) => {
        const start = Math.min(ov.outputStart, baseDuration - 0.1)
        const duration = Math.min(ov.duration, baseDuration - start)
        return { ...ov, outputStart: Math.max(0, start), duration: Math.max(0, duration) }
      })
      .filter((ov) => ov.duration > 0.1)

    if (!clampedOverlays.length) {
      await finalise()
      cleanup(toDeleteOnSuccess)
      cleanup([manifestPath(tmp)])
      return
    }

    await overlayBRoll(concatOut, clampedOverlays, outputPath, width, height, draft, baseDuration)

    onProgress({ stage: 'Done', percent: 100 })

    // Clean up temp files and checkpoint only after full success
    cleanup(toDeleteOnSuccess)
    cleanup([manifestPath(tmp)])

    if (skippedClips.length) {
      // Non-fatal: render succeeded but some clips were missing
      throw new Error(
        `Render completed but ${skippedClips.length} clip(s) were not found and were skipped: ${skippedClips.join(', ')}. ` +
        `Check that clip IDs in the EDL match your source filenames.`
      )
    }

  } catch (err) {
    // Leave .render-tmp intact so the next run can resume from checkpoints
    console.error('[render] error — checkpoints preserved in', tmp)
    throw err
  }
}

// ── Timeline helpers ──────────────────────────────────────────────────────────

type ASegment = { clipId: string; sourceStart: number; sourceEnd: number; outputStart: number }

/**
 * Builds a timeline mapping each A-roll entry to its output start time.
 * Timelapse entries (standalone B-roll) occupy time in the output between
 * A-roll segments and must be accounted for here so overlay positions are correct.
 */
function buildATimeline(
  allEntries: EDLEntry[]
): ASegment[] {
  const result: ASegment[] = []
  let t = 0
  for (const e of allEntries) {
    if (e.type === 'a-roll') {
      result.push({ clipId: e.clipId, sourceStart: e.sourceStart, sourceEnd: e.sourceEnd, outputStart: t })
      t += e.sourceEnd - e.sourceStart
    } else if (e.type === 'b-roll' && e.timelapse) {
      const speed = e.timelapseSpeed ?? 8
      const outputDur = Math.min(MAX_TIMELAPSE_SECONDS, (e.sourceEnd - e.sourceStart) / speed)
      t += outputDur
    } else if (e.type === 'b-roll' && e.transition) {
      // Transition output duration is already baked into sourceStart/sourceEnd by capBRollDuration
      t += e.sourceEnd - e.sourceStart
    }
  }
  return result
}

function bRollOutputStart(
  entry: Extract<EDLEntry, { type: 'b-roll' }>,
  timeline: ASegment[],
  _aEntries: Array<{ clipId: string; sourceStart: number; sourceEnd: number }>
): number {
  if (!entry.overUnderlying) return 0
  const { aRollClipId, aRollStart } = entry.overUnderlying
  const seg = timeline.find((s) => s.clipId === aRollClipId)
  if (!seg) return 0
  return seg.outputStart + (aRollStart - seg.sourceStart)
}

// ── B-roll overlay compositor ─────────────────────────────────────────────────

async function overlayBRoll(
  baseVideo: string,
  overlays: Array<{ path: string; outputStart: number; duration: number }>,
  outputPath: string,
  width: number,
  height: number,
  draft: boolean,
  baseDuration: number
): Promise<void> {
  const inputs: string[] = ['-i', baseVideo]
  for (const ov of overlays) inputs.push('-i', ov.path)

  const filters: string[] = []
  for (let i = 0; i < overlays.length; i++) {
    filters.push(`[${i + 1}:v]scale=${width}:${height},setsar=1[bv${i}]`)
  }

  let prev = '[0:v]'
  for (let i = 0; i < overlays.length; i++) {
    const ov = overlays[i]
    const start = ov.outputStart.toFixed(3)
    const end = Math.min(ov.outputStart + ov.duration, baseDuration).toFixed(3)
    const out = i === overlays.length - 1 ? '[vout]' : `[v${i}]`
    filters.push(`${prev}[bv${i}]overlay=0:0:enable='between(t,${start},${end})'${out}`)
    prev = `[v${i}]`
  }

  // Audio: normalize on full render, copy on draft.
  // aresample=async=1000 repairs any PTS gaps from concat before loudnorm
  // sees them, preventing the brief silence at the start of the output.
  if (!draft) {
    filters.push('[0:a]aresample=async=1000,loudnorm=I=-16:TP=-1.5:LRA=11[aout]')
  }

  await runFFmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', draft ? '0:a' : '[aout]',
    // Hard-cap output to base video duration — prevents any extension
    '-t', baseDuration.toFixed(3),
    '-c:v', 'libx264', '-preset', draft ? 'ultrafast' : 'fast', '-crf', draft ? '28' : '18',
    '-c:a', draft ? 'copy' : 'aac',
    ...(!draft ? ['-b:a', '192k'] : []),
    outputPath
  ])
}
