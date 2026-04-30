import { IpcMain, BrowserWindow } from 'electron'
import { transcribeClip, findPython, resetPythonCache } from '../pipeline/whisper'
import type { WordSegment, Transcript } from '@shared/types'
import { basename, extname } from 'path'

function sender(): Electron.WebContents | null {
  return BrowserWindow.getAllWindows()[0]?.webContents ?? null
}

function send(channel: string, payload: unknown): void {
  sender()?.send(channel, payload)
}

export function registerTranscribeHandlers(ipcMain: IpcMain): void {
  // Check that Python + faster-whisper are available
  ipcMain.handle('transcribe:check', async () => {
    // Always re-probe so the user doesn't need to restart after pip install
    resetPythonCache()
    let python = '(not found)'
    try {
      python = await findPython()

      // Verify faster-whisper is importable in that specific Python
      const result = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        const { spawn } = require('child_process') as typeof import('child_process')
        const proc = spawn(python, ['-c', 'import faster_whisper; print("ok")'], { timeout: 10000 })
        let out = ''
        let err = ''
        proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
        proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
        proc.on('close', (code: number) => resolve({ ok: code === 0 && out.includes('ok'), stderr: err }))
        proc.on('error', (e: Error) => resolve({ ok: false, stderr: e.message }))
      })

      if (!result.ok) {
        return {
          ok: false,
          python,
          error:
            `faster-whisper not found in ${python}\n\n` +
            `Run this exact command to install it:\n  ${python} -m pip install faster-whisper\n\n` +
            (result.stderr ? `Detail: ${result.stderr.trim().slice(0, 300)}` : '')
        }
      }

      return { ok: true, python }
    } catch (err: unknown) {
      return { ok: false, python, error: (err as Error).message }
    }
  })

  // Transcribe a single clip — streams progress via 'transcribe:progress' events
  ipcMain.handle(
    'transcribe:clip',
    async (_event, filePath: string, model: string) => {
      const clipId = basename(filePath, extname(filePath))
      try {
        const segments = await transcribeClip(filePath, clipId, model, (progress) => {
          send('transcribe:progress', { clipId, progress })
        })
        return { ok: true, clipId, segments }
      } catch (err: unknown) {
        return { ok: false, clipId, error: (err as Error).message }
      }
    }
  )

  // Transcribe all A-roll clips in sequence, building a full Transcript
  ipcMain.handle(
    'transcribe:all',
    async (_event, clips: Array<{ path: string }>, model: string) => {
      const allSegments: WordSegment[] = []
      const errors: Array<{ path: string; error: string }> = []

      for (let i = 0; i < clips.length; i++) {
        const { path: filePath } = clips[i]
        const clipId = basename(filePath, extname(filePath))

        send('transcribe:clip-start', { clipId, index: i, total: clips.length })

        try {
          const segments = await transcribeClip(filePath, clipId, model, (progress) => {
            send('transcribe:progress', {
              clipId,
              index: i,
              total: clips.length,
              clipProgress: progress,
              // Overall progress: completed clips + current clip fraction
              overallProgress: (i + progress) / clips.length,
            })
          })
          allSegments.push(...segments)
        } catch (err: unknown) {
          errors.push({ path: filePath, error: (err as Error).message })
          send('transcribe:clip-error', { clipId, error: (err as Error).message })
        }

        send('transcribe:clip-done', { clipId, index: i, total: clips.length })
      }

      const transcript: Transcript = { segments: allSegments }
      return { ok: true, transcript, errors }
    }
  )
}
