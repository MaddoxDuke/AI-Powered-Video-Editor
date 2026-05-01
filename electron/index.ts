import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerFolderHandlers } from './ipc/folder'
import { registerSettingsHandlers } from './ipc/settings'
import { registerTranscribeHandlers } from './ipc/transcribe'
import { registerLLMHandlers } from './ipc/llm'
import { registerPlanEditHandlers } from './ipc/plan-edit'
import { registerRenderCutHandlers } from './ipc/render-cut'
import { registerBRollDescribeHandlers } from './ipc/broll-describe'
import { registerEDLFileHandlers } from './ipc/edl-file'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f0f0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.maddox.video-editor')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerFolderHandlers(ipcMain)
  registerSettingsHandlers(ipcMain)
  registerTranscribeHandlers(ipcMain)
  registerLLMHandlers(ipcMain)
  registerPlanEditHandlers(ipcMain)
  registerRenderCutHandlers(ipcMain)
  registerBRollDescribeHandlers(ipcMain)
  registerEDLFileHandlers(ipcMain)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
