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
import { runFFmpeg, probeSize } from './ffmpeg'
import type { EDL, EDLEntry, ClipMeta } from '@shared/types'

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

/** Trim a source clip to [start, end] seconds and re-encode. */
async function trimClip(
  sourcePath: string,
  start: number,
  end: number,
  outputPath: string,
  onProgress?: (p: number) => void
): Promise<void> {
  await runFFmpeg([
    '-ss', String(start),
    '-to', String(end),
    '-i', sourcePath,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k',
    '-avoid_negative_ts', 'make_zero',
    outputPath
  ], onProgress ? (p) => onProgress(p.percent / 100) : undefined)
}

// ── Main render ───────────────────────────────────────────────────────────────

export async function applyEDL(
  edl: EDL,
  aRollClips: ClipMeta[],
  bRollClips: ClipMeta[],
  outputPath: ClipMeta['path'],
  onProgress: (p: RenderProgress) => void
): Promise<void> {
  const tmp = tmpDir(outputPath)
  const manifest = loadManifest(tmp)
  const toDeleteOnSuccess: string[] = []

  try {
    // ── Step 1: trim A-roll segments (with checkpointing) ─────────────────────
    const aRollEntries = edl.entries.filter(
      (e): e is Extract<EDLEntry, { type: 'a-roll' }> => e.type === 'a-roll'
    )

    const skippedClips: string[] = []
    const trimmedPaths: string[] = []

    for (let i = 0; i < aRollEntries.length; i++) {
      const entry = aRollEntries[i]
      const out = join(tmp, `aroll_${i}.mp4`)

      // Check if this segment was already trimmed in a previous interrupted run
      const cached = manifest.aroll[String(i)]
      if (cached && existsSync(cached)) {
        console.log(`[render] checkpoint hit: aroll_${i} (${entry.clipId})`)
        trimmedPaths.push(cached)
        toDeleteOnSuccess.push(cached)
        continue
      }

      const src = findClipPath(entry.clipId, aRollClips)
      if (!src) {
        // Warn and skip rather than crash — the clip ID the model produced
        // doesn't match any file. Surface the mismatch to the user at the end.
        const msg = `A-roll clip not found: "${entry.clipId}" — skipped. Available: ${availableClipIds(aRollClips)}`
        console.warn(`[render] ${msg}`)
        skippedClips.push(entry.clipId)
        continue
      }

      onProgress({
        stage: `Trimming A-roll ${i + 1}/${aRollEntries.length}${manifest.aroll[String(0)] ? ' (resuming)' : ''}`,
        percent: Math.round((i / aRollEntries.length) * 40)
      })

      await trimClip(src, entry.sourceStart, entry.sourceEnd, out)
      trimmedPaths.push(out)
      toDeleteOnSuccess.push(out)

      // Save checkpoint after each successful trim
      manifest.aroll[String(i)] = out
      saveManifest(tmp, manifest)
    }

    if (trimmedPaths.length === 0) {
      throw new Error(
        `No A-roll segments could be rendered. Missing clips: ${skippedClips.join(', ')}. ` +
        `Available clip IDs: ${availableClipIds(aRollClips)}`
      )
    }

    // ── Step 2: concat A-roll ─────────────────────────────────────────────────
    onProgress({ stage: 'Concatenating A-roll', percent: 40 })
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

    // ── Step 3: overlay B-roll ────────────────────────────────────────────────
    const bRollEntries = edl.entries.filter(
      (e): e is Extract<EDLEntry, { type: 'b-roll' }> => e.type === 'b-roll'
    )

    const finalise = async () => {
      onProgress({ stage: 'Finalising', percent: 90 })
      await runFFmpeg(['-i', concatOut, '-c', 'copy', outputPath])
      onProgress({ stage: 'Done', percent: 100 })
    }

    if (!bRollEntries.length) {
      await finalise()
      cleanup(toDeleteOnSuccess)
      cleanup([manifestPath(tmp)])
      return
    }

    const aRollTimeline = buildATimeline(aRollEntries)
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

      onProgress({
        stage: `Trimming B-roll ${i + 1}/${bRollEntries.length}`,
        percent: 50 + Math.round((i / bRollEntries.length) * 20)
      })

      await trimClip(src, entry.sourceStart, entry.sourceEnd, out)
      toDeleteOnSuccess.push(out)

      manifest.broll[String(i)] = out
      saveManifest(tmp, manifest)

      const outputStart = bRollOutputStart(entry, aRollTimeline, aRollEntries)
      overlays.push({ path: out, outputStart, duration: entry.sourceEnd - entry.sourceStart })
    }

    if (!overlays.length) {
      await finalise()
      cleanup(toDeleteOnSuccess)
      cleanup([manifestPath(tmp)])
      return
    }

    onProgress({ stage: 'Compositing B-roll overlays', percent: 70 })
    await overlayBRoll(concatOut, overlays, outputPath, width, height)

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

function buildATimeline(
  aEntries: Array<{ clipId: string; sourceStart: number; sourceEnd: number }>
): ASegment[] {
  let t = 0
  return aEntries.map((e) => {
    const seg = { ...e, outputStart: t }
    t += e.sourceEnd - e.sourceStart
    return seg
  })
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
  height: number
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
    const end = (ov.outputStart + ov.duration).toFixed(3)
    const out = i === overlays.length - 1 ? '[vout]' : `[v${i}]`
    filters.push(`${prev}[bv${i}]overlay=0:0:enable='between(t,${start},${end})'${out}`)
    prev = `[v${i}]`
  }

  await runFFmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'copy',
    outputPath
  ])
}
