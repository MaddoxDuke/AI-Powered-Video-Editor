import { create } from 'zustand'
import type { ClipMeta, AppSettings, EDL, Transcript, AnimationPlan } from '@shared/types'

type Tab = 'edit' | 'animate' | 'settings'

type ProjectState = {
  projectId: string | null
  aRollFolder: string | null
  bRollFolder: string | null
  aRollClips: ClipMeta[]
  bRollClips: ClipMeta[]
  transcript: Transcript | null
  edl: EDL | null
  combinedVideoPath: string | null
  animationPlan: AnimationPlan | null
  finalVideoPath: string | null
}

type UIState = {
  activeTab: Tab
  isScanning: boolean
  scanProgress: { current: number; total: number } | null
  settings: AppSettings | null
  settingsLoaded: boolean
}

type Actions = {
  setActiveTab: (tab: Tab) => void
  setARollFolder: (path: string | null) => void
  setBRollFolder: (path: string | null) => void
  setARollClips: (clips: ClipMeta[]) => void
  setBRollClips: (clips: ClipMeta[]) => void
  setScanning: (scanning: boolean) => void
  setScanProgress: (p: { current: number; total: number } | null) => void
  setEDL: (edl: EDL) => void
  setTranscript: (t: Transcript) => void
  setCombinedVideo: (path: string) => void
  setAnimationPlan: (plan: AnimationPlan) => void
  setFinalVideo: (path: string) => void
  setSettings: (s: AppSettings) => void
  setSettingsLoaded: (v: boolean) => void
  reset: () => void
}

const initialProject: ProjectState = {
  projectId: null,
  aRollFolder: null,
  bRollFolder: null,
  aRollClips: [],
  bRollClips: [],
  transcript: null,
  edl: null,
  combinedVideoPath: null,
  animationPlan: null,
  finalVideoPath: null
}

const initialUI: UIState = {
  activeTab: 'edit',
  isScanning: false,
  scanProgress: null,
  settings: null,
  settingsLoaded: false
}

export const useStore = create<ProjectState & UIState & Actions>((set) => ({
  ...initialProject,
  ...initialUI,

  setActiveTab: (tab) => set({ activeTab: tab }),
  setARollFolder: (path) => set({ aRollFolder: path }),
  setBRollFolder: (path) => set({ bRollFolder: path }),
  setARollClips: (clips) => set({ aRollClips: clips }),
  setBRollClips: (clips) => set({ bRollClips: clips }),
  setScanning: (scanning) => set({ isScanning: scanning }),
  setScanProgress: (p) => set({ scanProgress: p }),
  setEDL: (edl) => set({ edl }),
  setTranscript: (transcript) => set({ transcript }),
  setCombinedVideo: (path) => set({ combinedVideoPath: path }),
  setAnimationPlan: (plan) => set({ animationPlan: plan }),
  setFinalVideo: (path) => set({ finalVideoPath: path }),
  setSettings: (settings) => set({ settings }),
  setSettingsLoaded: (v) => set({ settingsLoaded: v }),
  reset: () => set({ ...initialProject })
}))
