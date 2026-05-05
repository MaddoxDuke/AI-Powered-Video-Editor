import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { spawn } from 'child_process'
import { runFFmpeg, probeDuration, probeSize } from './ffmpeg'
import type { AnimationCue } from '@shared/types'

export type AnimateProgress = { stage: string; percent: number }

function getTemplatesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'hyperframes')
    : join(app.getAppPath(), 'resources', 'hyperframes')
}

function getHyperframesBin(): string {
  const appRoot = app.isPackaged ? join(process.resourcesPath, 'app') : app.getAppPath()
  const bin = join(appRoot, 'node_modules', '.bin', 'hyperframes')
  return existsSync(bin) ? bin : 'npx'
}

/** Render one cue's Hyperframes template to a transparent MOV */
export async function renderCue(
  cue: AnimationCue,
  outputDir: string
): Promise<string> {
  const templateDir = join(getTemplatesDir(), cue.kind)
  if (!existsSync(join(templateDir, 'index.html'))) {
    throw new Error(`No template for kind "${cue.kind}" at ${templateDir}`)
  }

  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(outputDir, `${cue.id}.mov`)

  // Variables must include duration (as string for template)
  const vars = { ...cue.variables, duration: String(cue.duration) }

  const bin = getHyperframesBin()
  const baseArgs = [
    'render',
    '--format', 'mov',
    '--fps', '30',
    '--non-interactive',
    '--quiet',
    '--output', outputPath,
    '--variables', JSON.stringify(vars)
  ]
  const args = bin === 'npx' ? ['hyperframes', ...baseArgs] : baseArgs

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: 'pipe',
      cwd: templateDir  // run from template project directory
    })
    let errOut = ''
    proc.stderr?.on('data', (d: Buffer) => { errOut += d.toString() })
    proc.stdout?.on('data', (d: Buffer) => { errOut += d.toString() })
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`Hyperframes render failed (exit ${code}): ${errOut.slice(-600)}`))
      else resolve()
    })
    proc.on('error', reject)
  })

  return outputPath
}

/** Composite all cue MOVs over combined.mp4 → final.mp4 */
export async function compositeAnimations(
  combinedPath: string,
  cues: AnimationCue[],
  cuePaths: Map<string, string>,  // cueId → .mov path
  outputPath: string,
  onProgress: (p: AnimateProgress) => void
): Promise<void> {
  onProgress({ stage: 'Compositing animations', percent: 80 })

  if (cuePaths.size === 0) {
    // No cues — copy combined as final
    await runFFmpeg(['-i', combinedPath, '-c', 'copy', outputPath])
    return
  }

  const { width, height } = await probeSize(combinedPath)
  const baseDuration = await probeDuration(combinedPath)

  const inputs: string[] = ['-i', combinedPath]
  const validCues: AnimationCue[] = []

  for (const cue of cues) {
    const p = cuePaths.get(cue.id)
    if (!p || !existsSync(p)) continue
    inputs.push('-i', p)
    validCues.push(cue)
  }

  if (!validCues.length) {
    await runFFmpeg(['-i', combinedPath, '-c', 'copy', outputPath])
    return
  }

  const filters: string[] = []
  // Scale each overlay to match base video dimensions
  for (let i = 0; i < validCues.length; i++) {
    filters.push(`[${i + 1}:v]scale=${width}:${height},format=rgba[ov${i}]`)
  }

  let prev = '[0:v]'
  for (let i = 0; i < validCues.length; i++) {
    const cue = validCues[i]
    const start = Math.max(0, cue.startInFinal).toFixed(3)
    const end = Math.min(cue.startInFinal + cue.duration, baseDuration).toFixed(3)
    const out = i === validCues.length - 1 ? '[vout]' : `[v${i}]`
    filters.push(`${prev}[ov${i}]overlay=format=auto:enable='between(t,${start},${end})'${out}`)
    prev = `[v${i}]`
  }

  await runFFmpeg([
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-c:a', 'copy',
    '-t', baseDuration.toFixed(3),
    outputPath
  ])
}
