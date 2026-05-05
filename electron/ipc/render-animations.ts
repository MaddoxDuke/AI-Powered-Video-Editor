import { IpcMain, IpcMainInvokeEvent } from 'electron'
import { join, dirname } from 'path'
import { mkdirSync } from 'fs'
import { renderCue, compositeAnimations } from '../pipeline/hyperframes'
import type { AnimationPlan, AnimationCue } from '@shared/types'

export function registerRenderAnimationsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'animate:render',
    async (
      event: IpcMainInvokeEvent,
      plan: AnimationPlan,
      combinedVideoPath: string,
      exportFolder: string
    ) => {
      try {
        const timestamp = Date.now()
        const outputPath = join(exportFolder, `final_${timestamp}.mp4`)
        const tmpDir = join(dirname(combinedVideoPath), '.animate-tmp')
        mkdirSync(tmpDir, { recursive: true })
        mkdirSync(exportFolder, { recursive: true })

        const cues: AnimationCue[] = plan.cues
        const cuePaths = new Map<string, string>()
        const total = cues.length

        // Render each cue template with Hyperframes
        for (let i = 0; i < cues.length; i++) {
          const cue = cues[i]
          const percent = Math.round((i / total) * 70)
          event.sender.send('animate:progress', {
            stage: `Rendering cue ${i + 1}/${total}: ${cue.kind}`,
            percent
          })

          try {
            const movPath = await renderCue(cue, tmpDir)
            cuePaths.set(cue.id, movPath)
          } catch (cueErr: unknown) {
            // Log and skip failed cues — don't abort the whole render
            console.error(`[render-animations] Cue "${cue.id}" failed:`, (cueErr as Error).message)
          }
        }

        event.sender.send('animate:progress', {
          stage: 'Compositing animations over video…',
          percent: 75
        })

        await compositeAnimations(
          combinedVideoPath,
          cues,
          cuePaths,
          outputPath,
          (p) => { event.sender.send('animate:progress', p) }
        )

        event.sender.send('animate:progress', { stage: 'Done', percent: 100 })

        return { ok: true, finalPath: outputPath }
      } catch (err: unknown) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )
}
