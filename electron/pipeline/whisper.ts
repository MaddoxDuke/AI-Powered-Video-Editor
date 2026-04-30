import { spawn } from 'child_process'
import { statSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { app } from 'electron'
import type { WordSegment } from '@shared/types'

export type TranscribeProgress = { progress: number }
export type TranscribeResult = { segments: WordSegment[] }

// ── Python discovery ──────────────────────────────────────────────────────────

const home = process.env['HOME'] ?? ''

// All plausible Python locations. Pyenv shims come first since that's the
// user's explicitly chosen version. System Python (/usr/bin/python3) is last
// because Apple ships it without pip packages.
const PYTHON_CANDIDATES = [
  `${home}/.pyenv/shims/python3`,
  `${home}/.pyenv/shims/python`,
  `${home}/miniconda3/bin/python3`,
  `${home}/anaconda3/bin/python3`,
  `${home}/.conda/envs/base/bin/python3`,
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
  'python3',
  'python',
]

let _pythonPath: string | null = null

export function resetPythonCache(): void { _pythonPath = null }

// Try to find the Python that actually has faster_whisper installed.
// Falls back to first working Python if none have it.
export async function findPython(): Promise<string> {
  if (_pythonPath) return _pythonPath

  // Also ask interactive zsh for its python — picks up pyenv/conda inits in .zshrc
  const shellCandidates: string[] = []
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      const out = await runOnce(shell, ['-i', '-c', 'command -v python3 2>/dev/null || command -v python 2>/dev/null'])
      const p = out.trim().split('\n').filter(Boolean).pop()
      if (p && !shellCandidates.includes(p)) shellCandidates.push(p)
    } catch { /* shell unavailable */ }
  }

  const allCandidates = [...new Set([...shellCandidates, ...PYTHON_CANDIDATES])]

  let firstWorkingPython: string | null = null

  for (const candidate of allCandidates) {
    try {
      await runOnce(candidate, ['--version'])
    } catch {
      continue // not a working python, skip
    }

    if (!firstWorkingPython) firstWorkingPython = candidate

    // Prefer the Python that already has faster_whisper
    try {
      await runOnce(candidate, ['-c', 'import faster_whisper'])
      _pythonPath = candidate
      return candidate
    } catch {
      // faster_whisper not in this Python — keep searching
    }
  }

  // No Python has faster_whisper yet. Return the first working one so the
  // check handler can show the correct pip install command.
  if (firstWorkingPython) {
    _pythonPath = firstWorkingPython
    return firstWorkingPython
  }

  throw new Error(
    'Python 3 not found.\n' +
    'Install via Homebrew:  brew install python3\n' +
    'Or verify pyenv is configured:  pyenv versions'
  )
}

function runOnce(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const proc = spawn(cmd, args, { timeout: 8000 })
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)))
    proc.on('error', reject)
  })
}

// ── Script path ───────────────────────────────────────────────────────────────

function getScriptPath(): string {
  // Dev: script lives next to this compiled file in electron/pipeline/
  // Prod: copied into app resources via electron-builder extraResources
  const candidates = [
    join(dirname(__dirname), 'pipeline', 'transcribe.py'),          // out/main/../pipeline
    join(app.getAppPath(), 'electron', 'pipeline', 'transcribe.py'), // asar root
    join(process.resourcesPath, 'transcribe.py'),                    // extraResources
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  // Fallback: resolve from source tree during dev
  return join(__dirname, '..', '..', 'electron', 'pipeline', 'transcribe.py')
}

// ── Cache ─────────────────────────────────────────────────────────────────────

function getCacheDir(): string {
  const dir = join(app.getPath('userData'), 'transcript-cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function cacheKey(filePath: string): string {
  const s = statSync(filePath)
  // mtime + size is fast and reliable for local files
  return Buffer.from(`${filePath}:${s.mtimeMs}:${s.size}`).toString('base64url')
}

function readCache(filePath: string): TranscribeResult | null {
  const key = cacheKey(filePath)
  const p = join(getCacheDir(), `${key}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as TranscribeResult
  } catch {
    return null
  }
}

function writeCache(filePath: string, result: TranscribeResult): void {
  const key = cacheKey(filePath)
  writeFileSync(join(getCacheDir(), `${key}.json`), JSON.stringify(result))
}

// ── Main transcribe call ──────────────────────────────────────────────────────

export async function transcribeClip(
  filePath: string,
  clipId: string,
  model: string,
  onProgress: (p: number) => void
): Promise<WordSegment[]> {
  // Cache hit
  const cached = readCache(filePath)
  if (cached) {
    onProgress(1)
    return cached.segments.map((s) => ({ ...s, clipId }))
  }

  const python = await findPython()
  const script = getScriptPath()

  const args = [script, filePath, '--model', model]

  return new Promise((resolve, reject) => {
    const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })

    proc.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      // Parse progress lines — each is a separate JSON object
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const msg = JSON.parse(trimmed) as { progress?: number }
          if (typeof msg.progress === 'number') onProgress(msg.progress)
        } catch {
          // non-JSON stderr (e.g. Python warnings) — ignore
        }
      }
    })

    proc.on('error', (err) => reject(new Error(`Failed to spawn Python: ${err.message}`)))

    proc.on('close', (code) => {
      const trimmed = stdout.trim()
      if (!trimmed) {
        const hint = stderr.trim().slice(0, 500)
        return reject(new Error(`Transcription produced no output. stderr:\n${hint}`))
      }

      // The last non-empty line is the result JSON
      const resultLine = trimmed.split('\n').filter(Boolean).pop()!
      let parsed: { segments?: WordSegment[]; error?: string }
      try {
        parsed = JSON.parse(resultLine)
      } catch {
        return reject(new Error(`Could not parse transcription output: ${resultLine.slice(0, 300)}`))
      }

      if (parsed.error) return reject(new Error(parsed.error))
      if (!parsed.segments) return reject(new Error('Transcription returned no segments'))

      if (code !== 0) {
        // Script exited non-zero but gave us an error message above
        return reject(new Error(parsed.error ?? `Script exited ${code}`))
      }

      const result: TranscribeResult = { segments: parsed.segments }
      writeCache(filePath, result)

      resolve(result.segments.map((s) => ({ ...s, clipId })))
    })
  })
}
