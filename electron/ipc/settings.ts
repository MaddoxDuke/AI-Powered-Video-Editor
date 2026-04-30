import { IpcMain, app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const SERVICE = 'video-editor'
const ACCOUNT = 'anthropic-api-key'

function getKeytarSafe() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('keytar')
  } catch {
    return null
  }
}

function getSettingsPath(): string {
  const dir = join(app.getPath('userData'), 'settings')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

function readSettings(): Record<string, unknown> {
  const p = getSettingsPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch {
    return {}
  }
}

function writeSettings(data: Record<string, unknown>): void {
  writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2))
}

export function registerSettingsHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('settings:getApiKey', async () => {
    const keytar = getKeytarSafe()
    if (!keytar) return readSettings()['apiKey'] ?? ''
    return (await keytar.getPassword(SERVICE, ACCOUNT)) ?? ''
  })

  ipcMain.handle('settings:setApiKey', async (_event, key: string) => {
    const keytar = getKeytarSafe()
    if (!keytar) {
      const s = readSettings()
      s['apiKey'] = key
      writeSettings(s)
      return
    }
    await keytar.setPassword(SERVICE, ACCOUNT, key)
  })

  ipcMain.handle('settings:get', () => readSettings())

  ipcMain.handle('settings:set', (_event, settings: Record<string, unknown>) => {
    const current = readSettings()
    writeSettings({ ...current, ...settings })
  })
}
