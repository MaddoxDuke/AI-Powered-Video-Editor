import { IpcMain } from 'electron'
import { listOllamaModels, checkAnthropic, checkOpenAICompat } from '../claude/client'
import type { LLMProvider, LLMStatus } from '@shared/types'

export function registerLLMHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    'llm:check',
    async (_event, provider: LLMProvider, endpointOrKey: string): Promise<LLMStatus> => {
      if (provider === 'ollama') {
        const endpoint = endpointOrKey || 'http://localhost:11434'
        try {
          const models = await listOllamaModels(endpoint)
          return { provider: 'ollama', ok: true, models }
        } catch (err: unknown) {
          const msg = (err as Error).message
          const friendly = msg.includes('ECONNREFUSED') || msg.includes('connect')
            ? 'Ollama is not running. Start it with:  ollama serve'
            : msg
          return { provider: 'ollama', ok: false, models: [], error: friendly }
        }
      }

      if (provider === 'openai-compat') {
        const endpoint = endpointOrKey || 'http://127.0.0.1:1234/v1'
        try {
          const { models } = await checkOpenAICompat(endpoint)
          return { provider: 'openai-compat' as const, ok: true, models: models.map((id) => ({ name: id, size: 0, modified_at: '' })) }
        } catch (err: unknown) {
          const msg = (err as Error).message
          const friendly = msg.includes('ECONNREFUSED') || msg.includes('connect')
            ? 'LM Studio server is not running.\nIn LM Studio: Local Server → Start Server'
            : msg
          return { provider: 'openai-compat' as const, ok: false, models: [], error: friendly }
        }
      }

      // Anthropic
      try {
        await checkAnthropic(endpointOrKey)
        return { provider: 'anthropic', ok: true }
      } catch (err: unknown) {
        return { provider: 'anthropic', ok: false, error: (err as Error).message }
      }
    }
  )
}
