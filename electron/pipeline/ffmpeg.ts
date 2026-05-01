import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { join } from 'path'

const execFileAsync = promisify(execFile)

function getFFmpegPath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const s = require('ffmpeg-static') as string
    if (s && existsSync(s)) return s
  } catch { /* fall through */ }
  return 'ffmpeg'
}

function getFFprobePath(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const s = require('ffprobe-static') as { path: string }
    if (s?.path && existsSync(s.path)) return s.path
  } catch { /* fall through */ }
  return 'ffprobe'
}

export const FFMPEG = getFFmpegPath()
export const FFPROBE = getFFprobePath()

export type FFmpegProgress = { percent: number; fps?: number; speed?: string }

/** Run ffmpeg, calling onProgress with 0-100 as it encodes. */
export function runFFmpeg(
  args: string[],
  onProgress?: (p: FFmpegProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = require('child_process').spawn(FFMPEG, ['-y', ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    }) as import('child_process').ChildProcess

    let durationSec = 0
    let stderr = ''

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderr += text

      // Parse total duration on first appearance
      if (!durationSec) {
        const m = text.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
        if (m) {
          durationSec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        }
      }

      // Parse progress
      if (onProgress && durationSec > 0) {
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
        const fpsMatch = text.match(/fps=\s*([\d.]+)/)
        const speedMatch = text.match(/speed=\s*([\d.]+x)/)
        if (timeMatch) {
          const elapsed = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3])
          onProgress({
            percent: Math.min(100, Math.round((elapsed / durationSec) * 100)),
            fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
            speed: speedMatch ? speedMatch[1] : undefined
          })
        }
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`FFmpeg exited ${code}:\n${stderr.slice(-1000)}`))
      }
    })

    proc.on('error', reject)
  })
}

/** Probe a single file and return duration in seconds. */
export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
  ])
  const info = JSON.parse(stdout) as { format?: { duration?: string } }
  return parseFloat(info.format?.duration ?? '0')
}

/** Extract a single frame at `timeSec` to a JPEG file. */
export async function extractFrame(
  inputPath: string,
  outputPath: string,
  timeSec: number
): Promise<void> {
  await runFFmpeg([
    '-ss', String(timeSec),
    '-i', inputPath,
    '-frames:v', '1',
    '-q:v', '3',
    outputPath
  ])
}

/**
 * Extract 3 frames (at 10%, 50%, 90% of clip duration) and stitch them
 * side-by-side into a single JPEG strip. Gives Haiku the full arc of the
 * clip (start → middle → end) in one image with no extra API token cost.
 */
export async function extractFrameStrip(
  inputPath: string,
  outputPath: string,
  duration: number
): Promise<void> {
  const times = [0.1, 0.5, 0.9].map((t) => Math.max(0.1, t * duration))
  const { tmpdir } = await import('os')
  const { join: pjoin } = await import('path')
  const { unlinkSync, existsSync: fsExists } = await import('fs')

  const framePaths = times.map((_, i) =>
    pjoin(tmpdir(), `ve_strip_${Date.now()}_${i}.jpg`)
  )

  try {
    // Extract each frame sequentially
    for (let i = 0; i < times.length; i++) {
      await runFFmpeg([
        '-ss', String(times[i]),
        '-i', inputPath,
        '-frames:v', '1',
        '-q:v', '4',
        '-vf', 'scale=480:-2',   // shrink each frame — final strip ~1440px wide
        framePaths[i]
      ])
    }

    // Stitch frames side-by-side with hstack
    await runFFmpeg([
      '-i', framePaths[0],
      '-i', framePaths[1],
      '-i', framePaths[2],
      '-filter_complex', 'hstack=inputs=3',
      '-q:v', '4',
      outputPath
    ])
  } finally {
    for (const p of framePaths) {
      try { if (fsExists(p)) unlinkSync(p) } catch { /* ignore */ }
    }
  }
}

/**
 * Detects silence gaps in an audio/video file using FFmpeg's silencedetect filter.
 * Returns an array of { start, end } pairs (seconds) where audio is below the threshold.
 *
 * noise:   -35dB  — typical background hum in a garage; speech is well above this
 * duration: 0.8s  — minimum silence length to report (ignores brief pauses mid-word)
 */
export async function detectSilences(
  inputPath: string,
  noiseTolerance = '-35dB',
  minDuration = 0.8
): Promise<Array<{ start: number; end: number }>> {
  return new Promise((resolve, reject) => {
    const proc = require('child_process').spawn(
      FFMPEG,
      [
        '-i', inputPath,
        '-af', `silencedetect=noise=${noiseTolerance}:duration=${minDuration}`,
        '-f', 'null', '-'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    ) as import('child_process').ChildProcess

    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        // silencedetect always exits 0 but guard anyway
        reject(new Error(`silencedetect exited ${code}`))
        return
      }

      const silences: Array<{ start: number; end: number }> = []
      const startRe = /silence_start:\s*([\d.]+)/g
      const endRe   = /silence_end:\s*([\d.]+)/g

      const starts: number[] = []
      const ends:   number[] = []

      let m: RegExpExecArray | null
      while ((m = startRe.exec(stderr)) !== null) starts.push(parseFloat(m[1]))
      while ((m = endRe.exec(stderr))   !== null) ends.push(parseFloat(m[1]))

      for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
        silences.push({ start: starts[i], end: ends[i] })
      }
      // Handle clip that ends mid-silence (no silence_end emitted)
      if (starts.length > ends.length) {
        silences.push({ start: starts[starts.length - 1], end: Infinity })
      }

      resolve(silences)
    })

    proc.on('error', reject)
  })
}

/** Get video dimensions. */
export async function probeSize(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams',
    '-select_streams', 'v:0', filePath
  ])
  const info = JSON.parse(stdout) as { streams?: Array<{ width?: number; height?: number }> }
  const s = info.streams?.[0]
  return { width: s?.width ?? 1920, height: s?.height ?? 1080 }
}
