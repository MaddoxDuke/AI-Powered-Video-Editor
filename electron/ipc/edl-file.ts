/**
 * EDL file persistence — save and load EDL JSON files.
 *
 * Auto-save: writes to workspace/projects/last-edl.json on every plan/revise.
 * Named save: opens a save dialog so the user can keep multiple EDLs.
 * Load: opens a file dialog to restore any saved EDL.
 */

import { IpcMain, dialog, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import type { EDL } from '@shared/types'

const SAVE_VERSION = 1

type EDLFile = {
  version: number
  savedAt: string
  edl: EDL
}

function projectsDir(): string {
  const dir = join(app.getAppPath(), 'workspace', 'projects')
  mkdirSync(dir, { recursive: true })
  return dir
}

function autoSavePath(): string {
  return join(projectsDir(), 'last-edl.json')
}

function writeEDLFile(path: string, edl: EDL): void {
  const file: EDLFile = { version: SAVE_VERSION, savedAt: new Date().toISOString(), edl }
  writeFileSync(path, JSON.stringify(file, null, 2))
}

function readEDLFile(path: string): EDL {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as EDLFile
  if (!raw.edl || !Array.isArray(raw.edl.entries)) {
    throw new Error('Invalid EDL file format')
  }
  return raw.edl
}

export function registerEDLFileHandlers(ipcMain: IpcMain): void {

  /** Auto-save — called whenever the EDL is updated in the renderer */
  ipcMain.handle('edl-file:auto-save', (_event, edl: EDL) => {
    try {
      writeEDLFile(autoSavePath(), edl)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Load the last auto-saved EDL on startup (if it exists) */
  ipcMain.handle('edl-file:load-last', () => {
    const p = autoSavePath()
    if (!existsSync(p)) return { ok: true, edl: null }
    try {
      return { ok: true, edl: readEDLFile(p) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Named save — opens a save dialog */
  ipcMain.handle('edl-file:save-as', async (_event, edl: EDL) => {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Save EDL',
      defaultPath: join(projectsDir(), `edit-${new Date().toISOString().slice(0, 10)}.edl.json`),
      filters: [{ name: 'EDL Files', extensions: ['edl.json', 'json'] }]
    })
    if (canceled || !filePath) return { ok: true, canceled: true }
    try {
      writeEDLFile(filePath, edl)
      return { ok: true, filePath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  /** Load — opens a file open dialog */
  ipcMain.handle('edl-file:load', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: 'Load EDL',
      defaultPath: projectsDir(),
      filters: [{ name: 'EDL Files', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (canceled || !filePaths.length) return { ok: true, canceled: true }
    try {
      const edl = readEDLFile(filePaths[0])
      return { ok: true, edl, filePath: filePaths[0] }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
