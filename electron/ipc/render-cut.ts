import { IpcMain, BrowserWindow, app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { applyEDL, writeChaptersFile } from '../pipeline/edl'
import type { EDL, ClipMeta, Transcript } from '@shared/types'

function send(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload)
}

export function registerRenderCutHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'render-cut:render',
    async (
      _event,
      edl: EDL,
      aRollClips: ClipMeta[],
      bRollClips: ClipMeta[],
      transcript: Transcript,
      exportFolder: string,
      draft = false
    ) => {
      const outDir = exportFolder || join(app.getPath('desktop'), 'VideoEditor')
      mkdirSync(outDir, { recursive: true })

      const projectId = Date.now().toString()
      const suffix = draft ? `draft_${projectId}` : `combined_${projectId}`
      const outputPath = join(outDir, `${suffix}.mp4`)

      // Write adjusted transcript alongside the video
      const transcriptPath = join(outDir, `transcript_${projectId}.json`)
      const { writeFileSync } = await import('fs')
      writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2))

      try {
        await applyEDL(edl, aRollClips, bRollClips, outputPath, (progress) => {
          send('render-cut:progress', progress)
        }, draft)
        const chaptersPath = !draft ? writeChaptersFile(edl, outputPath) : null
        return { ok: true, outputPath, transcriptPath, chaptersPath: chaptersPath ?? undefined }
      } catch (err: unknown) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
