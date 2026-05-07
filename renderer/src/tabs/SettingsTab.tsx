import { useEffect, useState } from 'react'
import { useStore } from '../store'
import type { AppSettings, LLMProvider, LLMStatus, OllamaModel } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

export function SettingsTab() {
  const { settings, setSettings, setSettingsLoaded } = useStore()

  const [apiKey, setApiKey] = useState('')
  const [apiKeyMasked, setApiKeyMasked] = useState(true)
  const [saved, setSaved] = useState(false)
  const [localSettings, setLocalSettings] = useState<AppSettings>(settings ?? DEFAULT_SETTINGS)

  const [llmStatus, setLlmStatus] = useState<LLMStatus | null>(null)
  const [checkingLLM, setCheckingLLM] = useState(false)
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([])
  const [oaiModels, setOaiModels] = useState<string[]>([])

  useEffect(() => {
    async function load() {
      const [key, s] = await Promise.all([window.api.getApiKey(), window.api.getSettings()])
      setApiKey(key ?? '')
      const merged = { ...DEFAULT_SETTINGS, ...(s as Partial<AppSettings>) }
      setLocalSettings(merged)
      setSettings(merged)
      setSettingsLoaded(true)
    }
    load()
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    await Promise.all([window.api.setApiKey(apiKey), window.api.setSettings(localSettings)])
    setSettings(localSettings)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function checkLLM(provider: LLMProvider) {
    setCheckingLLM(true)
    setLlmStatus(null)
    const arg =
      provider === 'anthropic'
        ? apiKey
        : provider === 'openai-compat'
        ? localSettings.openaiCompatEndpoint
        : localSettings.ollamaEndpoint
    const status = await window.api.llmCheck(provider, arg) as LLMStatus
    setLlmStatus(status)
    if (status.provider === 'ollama' && status.ok) {
      setAvailableModels(status.models)
    }
    if (status.provider === 'openai-compat' && status.ok) {
      setOaiModels(status.models.map((m) => m.name))
      // Auto-fill model if field is empty and we got models back
      if (!localSettings.openaiCompatModel && status.models.length > 0) {
        setLocalSettings((s) => ({ ...s, openaiCompatModel: status.models[0].name }))
      }
    }
    setCheckingLLM(false)
  }

  return (
    <div className="flex flex-col gap-8 p-8 max-w-xl overflow-y-auto h-full">
      <div>
        <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1">Configure your LLM provider and project defaults.</p>
      </div>

      <form onSubmit={handleSave} className="flex flex-col gap-6">

        {/* ── LLM Provider ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">LLM provider</h2>

          {/* Provider toggle */}
          <div className="flex gap-2 flex-wrap">
            {(
              [
                ['openai-compat', 'LM Studio (free, local)'],
                ['ollama', 'Ollama (free, local)'],
                ['anthropic', 'Anthropic Claude'],
              ] as [LLMProvider, string][]
            ).map(([p, label]) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setLocalSettings((s) => ({ ...s, llmProvider: p }))
                  setLlmStatus(null)
                }}
                className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                  localSettings.llmProvider === p
                    ? 'bg-blue-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* LM Studio / OpenAI-compat config */}
          {localSettings.llmProvider === 'openai-compat' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Server endpoint</span>
                <input
                  type="text"
                  value={localSettings.openaiCompatEndpoint}
                  onChange={(e) => setLocalSettings((s) => ({ ...s, openaiCompatEndpoint: e.target.value }))}
                  placeholder="http://localhost:1234/v1"
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Model name</span>
                <div className="flex gap-2">
                  {oaiModels.length > 0 ? (
                    <select
                      value={localSettings.openaiCompatModel}
                      onChange={(e) => setLocalSettings((s) => ({ ...s, openaiCompatModel: e.target.value }))}
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
                    >
                      {oaiModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={localSettings.openaiCompatModel}
                      onChange={(e) => setLocalSettings((s) => ({ ...s, openaiCompatModel: e.target.value }))}
                      placeholder="qwen/qwen3-5b"
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => checkLLM('openai-compat')}
                    disabled={checkingLLM}
                    className="px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
                  >
                    {checkingLLM ? 'Checking…' : 'Test'}
                  </button>
                </div>
                <span className="text-xs text-zinc-600">
                  Hit Test to auto-detect loaded models, or type the model ID shown in LM Studio.
                </span>
              </label>

              <LLMStatusBadge status={llmStatus} provider="openai-compat" />

              <div className="text-xs text-zinc-600 flex flex-col gap-1">
                <p>Download: <span className="text-zinc-400">lmstudio.ai</span></p>
                <p>In LM Studio: load a model → <span className="text-zinc-400 font-mono">Local Server → Start Server</span></p>
                <p className="text-zinc-700 mt-1">Default port is 1234. Works with any GGUF model loaded in LM Studio.</p>
              </div>
            </div>
          )}

          {/* Ollama config */}
          {localSettings.llmProvider === 'ollama' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Ollama endpoint</span>
                <input
                  type="text"
                  value={localSettings.ollamaEndpoint}
                  onChange={(e) => setLocalSettings((s) => ({ ...s, ollamaEndpoint: e.target.value }))}
                  className="bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">Model</span>
                <div className="flex gap-2">
                  {availableModels.length > 0 ? (
                    <select
                      value={localSettings.ollamaModel}
                      onChange={(e) => setLocalSettings((s) => ({ ...s, ollamaModel: e.target.value }))}
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
                    >
                      {availableModels.map((m) => (
                        <option key={m.name} value={m.name}>
                          {m.name} — {formatBytes(m.size)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={localSettings.ollamaModel}
                      onChange={(e) => setLocalSettings((s) => ({ ...s, ollamaModel: e.target.value }))}
                      placeholder="llama3.1:8b"
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => checkLLM('ollama')}
                    disabled={checkingLLM}
                    className="px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
                  >
                    {checkingLLM ? 'Checking…' : 'Test'}
                  </button>
                </div>
              </label>

              <LLMStatusBadge status={llmStatus} provider="ollama" />

              <div className="text-xs text-zinc-600 flex flex-col gap-1">
                <p>Install Ollama: <span className="text-zinc-400 font-mono">brew install ollama</span></p>
                <p>Start server: <span className="text-zinc-400 font-mono">ollama serve</span></p>
                <p>Pull a model: <span className="text-zinc-400 font-mono">ollama pull llama3.1:8b</span></p>
                <p className="text-zinc-700 mt-1">Recommended: llama3.1:8b (5 GB) or qwen2.5:7b (4.7 GB)</p>
              </div>
            </div>
          )}

          {/* Anthropic config */}
          {localSettings.llmProvider === 'anthropic' && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-zinc-400">API key</span>
                <div className="flex items-center gap-2">
                  <input
                    type={apiKeyMasked ? 'password' : 'text'}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-ant-..."
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 font-mono focus:outline-none focus:border-blue-500 placeholder-zinc-600"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setApiKeyMasked((v) => !v)}
                    className="px-2 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    {apiKeyMasked ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                  <button
                    type="button"
                    onClick={() => checkLLM('anthropic')}
                    disabled={checkingLLM || !apiKey}
                    className="px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
                  >
                    {checkingLLM ? 'Checking…' : 'Test'}
                  </button>
                </div>
              </label>
              <LLMStatusBadge status={llmStatus} provider="anthropic" />
              <p className="text-xs text-zinc-600">API key stored securely in macOS Keychain. Model is chosen at each AI call site.</p>
            </div>
          )}
        </section>

        {/* ── Project defaults ──────────────────────────────────────────── */}
        <section className="flex flex-col gap-4 p-5 rounded-lg bg-zinc-900 border border-zinc-800">
          <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500">Project defaults</h2>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Whisper model</span>
            <select
              value={localSettings.whisperModel}
              onChange={(e) => setLocalSettings((s) => ({ ...s, whisperModel: e.target.value }))}
              className="w-52 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
            >
              <option value="tiny.en">tiny.en — fastest, lower accuracy</option>
              <option value="base.en">base.en — recommended</option>
              <option value="small.en">small.en — better accuracy, slower</option>
              <option value="medium.en">medium.en — best accuracy, slow</option>
              <option value="large-v3">large-v3 — multilingual, slowest</option>
            </select>
            <span className="text-xs text-zinc-600">Downloaded once to ~/.cache/video-editor/whisper-models.</span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-xs text-zinc-400">Target video length</span>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={localSettings.targetDurationAuto}
                onChange={(e) => setLocalSettings((s) => ({ ...s, targetDurationAuto: e.target.checked }))}
                className="accent-blue-500"
              />
              <span className="text-xs text-zinc-300">Let AI decide</span>
            </label>
            {!localSettings.targetDurationAuto && (
              <div className="flex items-center gap-2">
                <input
                  type="number" min={1} max={60}
                  value={localSettings.targetDurationMinutes}
                  onChange={(e) => setLocalSettings((s) => ({ ...s, targetDurationMinutes: Number(e.target.value) }))}
                  className="w-24 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-blue-500"
                />
                <span className="text-xs text-zinc-500">minutes</span>
              </div>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Export folder</span>
            <div className="flex items-center gap-2">
              <input
                type="text" readOnly
                value={localSettings.exportFolder || 'Not set — defaults to ~/Desktop'}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-500 font-mono cursor-default"
              />
              <button
                type="button"
                onClick={async () => {
                  const picked = await window.api.pickFolder('aroll')
                  if (picked) setLocalSettings((s) => ({ ...s, exportFolder: picked }))
                }}
                className="px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors"
              >
                Browse
              </button>
            </div>
          </label>
        </section>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="px-5 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
          >
            Save settings
          </button>
          {saved && <span className="text-xs text-green-400">Saved ✓</span>}
        </div>
      </form>
    </div>
  )
}

function LLMStatusBadge({ status, provider }: { status: LLMStatus | null; provider: LLMProvider }) {
  if (!status || status.provider !== provider) return null
  if (status.ok) {
    const modelCount =
      (status.provider === 'ollama' || status.provider === 'openai-compat') && status.models.length > 0
        ? ` · ${status.models.length} model${status.models.length !== 1 ? 's' : ''} found`
        : ''
    return <p className="text-xs text-green-400">Connected{modelCount}</p>
  }
  return <p className="text-xs text-red-400 whitespace-pre-wrap">{status.error}</p>
}

function formatBytes(bytes: number): string {
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}
