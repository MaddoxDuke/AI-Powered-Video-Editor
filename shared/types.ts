// ──────────────────────────────────────────────
// Source clip metadata (post ffprobe + VAD)
// ──────────────────────────────────────────────
export type ClipMeta = {
  path: string
  duration: number
  hasVoice: boolean
  expectedRoll: 'a' | 'b'
  warning?: string
}

// ──────────────────────────────────────────────
// Transcript (whisper word-level output)
// ──────────────────────────────────────────────
export type WordSegment = {
  clipId: string
  start: number   // seconds in source clip
  end: number
  text: string
  confidence: number
}

export type Transcript = {
  segments: WordSegment[]
}

// ──────────────────────────────────────────────
// Edit Decision List
// ──────────────────────────────────────────────
export type EDLEntry =
  | {
      type: 'a-roll'
      clipId: string
      sourceStart: number
      sourceEnd: number
      transcriptText: string
    }
  | {
      type: 'b-roll'
      clipId: string
      sourceStart: number
      sourceEnd: number
      overUnderlying?: {
        aRollClipId: string
        aRollStart: number
        aRollEnd: number
      }
      reason: string
    }

export type EDL = {
  entries: EDLEntry[]
  totalDuration: number
  rationale: string
}

// ──────────────────────────────────────────────
// Animation plan (Stage 2)
// ──────────────────────────────────────────────
export type AnimationKind =
  | 'lower-third'
  | 'callout'
  | 'kinetic-text'
  | 'data-card'
  | 'transition'

export type AnimationCue = {
  id: string
  startInFinal: number
  duration: number
  kind: AnimationKind
  triggerText: string
  hyperframesProjectPath: string
  reason: string
}

export type AnimationPlan = {
  cues: AnimationCue[]
  rationale: string
}

// ──────────────────────────────────────────────
// App settings (persisted to userData)
// ──────────────────────────────────────────────
export type LLMProvider = 'anthropic' | 'ollama' | 'openai-compat'

export type AppSettings = {
  targetDurationMinutes: number
  targetDurationAuto: boolean
  exportFolder: string
  whisperModel: string
  llmProvider: LLMProvider
  ollamaEndpoint: string
  ollamaModel: string
  openaiCompatEndpoint: string  // e.g. http://localhost:1234/v1 for LM Studio
  openaiCompatModel: string     // model name as shown in LM Studio
}

export const DEFAULT_SETTINGS: AppSettings = {
  targetDurationMinutes: 10,
  targetDurationAuto: true,
  exportFolder: '',
  whisperModel: 'base.en',
  llmProvider: 'openai-compat',
  ollamaEndpoint: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  openaiCompatEndpoint: 'http://127.0.0.1:1234/v1',
  openaiCompatModel: ''
}

// ──────────────────────────────────────────────
// LLM types
// ──────────────────────────────────────────────
export type OllamaModel = {
  name: string
  size: number       // bytes
  modified_at: string
}

export type LLMStatus =
  | { provider: 'anthropic'; ok: boolean; error?: string }
  | { provider: 'ollama'; ok: boolean; models: OllamaModel[]; error?: string }
  | { provider: 'openai-compat'; ok: boolean; models: OllamaModel[]; error?: string }

// ──────────────────────────────────────────────
// IPC API surface (mirrors preload/index.ts)
// ──────────────────────────────────────────────
export interface ElectronAPI {
  pickFolder: (label: 'aroll' | 'broll') => Promise<string | null>
  scanFolder: (folderPath: string, roll: 'a' | 'b') => Promise<ClipMeta[]>
  getApiKey: () => Promise<string>
  setApiKey: (key: string) => Promise<void>
  getSettings: () => Promise<AppSettings>
  setSettings: (settings: Partial<AppSettings>) => Promise<void>
  llmCheck: (provider: LLMProvider, endpoint?: string) => Promise<LLMStatus>
  planEdit: (transcript: Transcript, aRoll: ClipMeta[], bRoll: ClipMeta[], settings: AppSettings, apiKey: string) => Promise<{ ok: boolean; edl?: EDL; error?: string }>
  reviseEdit: (edl: EDL, transcript: Transcript, aRoll: ClipMeta[], bRoll: ClipMeta[], request: string, settings: AppSettings, apiKey: string) => Promise<{ ok: boolean; edl?: EDL; error?: string }>
  renderCut: (edl: EDL, aRoll: ClipMeta[], bRoll: ClipMeta[], transcript: Transcript, exportFolder: string) => Promise<{ ok: boolean; outputPath?: string; transcriptPath?: string; error?: string }>
  transcribeCheck: () => Promise<{ ok: boolean; python?: string; error?: string }>
  transcribeAll: (
    clips: Array<{ path: string }>,
    model: string
  ) => Promise<{ ok: boolean; transcript: Transcript; errors: Array<{ path: string; error: string }> }>
  on: (channel: string, fn: (...args: unknown[]) => void) => () => void
}
