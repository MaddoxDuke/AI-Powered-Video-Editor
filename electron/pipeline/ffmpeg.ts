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
