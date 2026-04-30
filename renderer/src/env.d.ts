/// <reference types="vite/client" />

import type { ElectronAPI } from '@shared/types'

declare global {
  interface Window {
    api: ElectronAPI
    electron: {
      ipcRenderer: import('electron').IpcRenderer
    }
  }
}
