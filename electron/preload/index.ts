import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  // Folder scanning
  pickFolder: (label: 'aroll' | 'broll') =>
    ipcRenderer.invoke('folder:pick', label),
  scanFolder: (folderPath: string, roll: 'a' | 'b') =>
    ipcRenderer.invoke('folder:scan', folderPath, roll),

  // Settings / API key
  getApiKey: () => ipcRenderer.invoke('settings:getApiKey'),
  setApiKey: (key: string) => ipcRenderer.invoke('settings:setApiKey', key),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (settings: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:set', settings),

  // LLM
  llmCheck: (provider: string, endpointOrKey: string) =>
    ipcRenderer.invoke('llm:check', provider, endpointOrKey),

  // Edit planning
  planEdit: (transcript: unknown, aRoll: unknown, bRoll: unknown, settings: unknown, apiKey: string) =>
    ipcRenderer.invoke('plan-edit:plan', transcript, aRoll, bRoll, settings, apiKey),
  reviseEdit: (edl: unknown, transcript: unknown, aRoll: unknown, bRoll: unknown, request: string, settings: unknown, apiKey: string) =>
    ipcRenderer.invoke('plan-edit:revise', edl, transcript, aRoll, bRoll, request, settings, apiKey),

  // Render
  renderCut: (edl: unknown, aRoll: unknown, bRoll: unknown, transcript: unknown, exportFolder: string) =>
    ipcRenderer.invoke('render-cut:render', edl, aRoll, bRoll, transcript, exportFolder),

  // Transcription
  transcribeCheck: () => ipcRenderer.invoke('transcribe:check'),
  transcribeAll: (clips: Array<{ path: string }>, model: string) =>
    ipcRenderer.invoke('transcribe:all', clips, model),

  // Push events from main → renderer
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => fn(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
