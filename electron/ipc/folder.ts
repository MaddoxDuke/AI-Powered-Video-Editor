import { dialog, IpcMain, app } from 'electron'
import { readdirSync, existsSync, accessSync, constants as fsConstants } from 'fs'
import { join, extname, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ClipMeta } from '@shared/types'

const execFileAsync = promisify(execFile)

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.mkv'])

function getFfprobePath(): string {
  // In packaged app, binary lives in extraResources; in dev it's in node_modules.
  const candidates: string[] = []

  // Packaged: <Resources>/ffprobe-static/bin/darwin/arm64/ffprobe
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  candidates.push(join(process.resourcesPath, 'ffprobe-static', 'bin', 'darwin', arch, 'ffprobe'))

  // Dev: find node_modules relative to the compiled main file
  candidates.push(join(dirname(app.getAppPath()), 'node_modules', 'ffprobe-static', 'bin', 'darwin', arch, 'ffprobe'))
  candidates.push(join(app.getAppPath(), 'node_modules', 'ffprobe-static', 'bin', 'darwin', arch, 'ffprobe'))

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        accessSync(p, fsConstants.X_OK)
        return p
      } catch {
        // not executable, try next
      }
    }
  }

  // Last resort: require() — works in dev when externalizeDepsPlugin is active
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ffprobe-static').path as string
  } catch {
    return 'ffprobe'
  }
}

const FFPROBE_PATH = getFfprobePath()

function collectVideos(dir: string): string[] {
  const results: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip macOS resource fork sidecars (._filename) and other hidden metadata
      if (entry.name.startsWith('._') || entry.name.startsWith('.')) continue

      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...collectVideos(full))
      } else if (VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
        results.push(full)
      }
    }
  } catch {
    // skip unreadable dirs
  }
  return results
}

async function probeClip(
  filePath: string,
  roll: 'a' | 'b'
): Promise<ClipMeta> {
  try {
    const { stdout, stderr } = await execFileAsync(FFPROBE_PATH, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ], { maxBuffer: 10 * 1024 * 1024 })

    let info: Record<string, unknown>
    try {
      info = JSON.parse(stdout)
    } catch {
      const hint = stderr?.trim() || stdout?.trim().slice(0, 200)
      return { path: filePath, duration: 0, hasVoice: false, expectedRoll: roll,
        warning: `ffprobe output unparseable: ${hint}` }
    }

    const duration = parseFloat((info.format as Record<string, string>)?.duration ?? '0')
    return { path: filePath, duration, hasVoice: false, expectedRoll: roll }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // Capture stderr from execFile errors (they attach it to err.stderr)
    const stderr = (err as { stderr?: string }).stderr?.trim()
    const detail = stderr ? `${msg} — ${stderr.slice(0, 300)}` : msg
    return {
      path: filePath,
      duration: 0,
      hasVoice: false,
      expectedRoll: roll,
      warning: `ffprobe: ${detail}`
    }
  }
}

export function registerFolderHandlers(ipcMain: IpcMain): void {
  console.log('[folder] ffprobe path:', FFPROBE_PATH)

  ipcMain.handle('folder:pick', async (_event, _label: string) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle(
    'folder:scan',
    async (_event, folderPath: string, roll: 'a' | 'b') => {
      const paths = collectVideos(folderPath)
      const clips: ClipMeta[] = await Promise.all(
        paths.map((p) => probeClip(p, roll))
      )
      return clips
    }
  )
}
