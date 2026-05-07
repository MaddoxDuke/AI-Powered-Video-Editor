import type { AppSettings } from '@shared/types'

type Props = {
  settings: AppSettings | null
  value: string
  onChange: (model: string) => void
}

const ANTHROPIC_MODELS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 · fastest · ~$0.02/call' },
  { value: 'claude-sonnet-4-5',         label: 'Sonnet 4.5 · recommended · ~$0.09/call' },
  { value: 'claude-opus-4-5',           label: 'Opus 4.5 · best quality · ~$0.45/call' },
]

export function ModelSelector({ settings, value, onChange }: Props) {
  if (!settings) return null

  if (settings.llmProvider === 'anthropic') {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-blue-500 h-[34px]"
      >
        {ANTHROPIC_MODELS.map((m) => (
          <option key={m.value} value={m.value}>{m.label}</option>
        ))}
      </select>
    )
  }

  // Ollama or openai-compat: show non-interactive model name
  const modelName =
    settings.llmProvider === 'openai-compat'
      ? (settings.openaiCompatModel || 'local-model')
      : settings.ollamaModel

  return (
    <span className="text-xs text-zinc-500 font-mono px-2 py-1.5 bg-zinc-800/50 border border-zinc-800 rounded">
      {modelName}
    </span>
  )
}
