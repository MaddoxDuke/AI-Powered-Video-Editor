/**
 * Unified LLM client — wraps Anthropic SDK and Ollama REST API behind a
 * single interface. Callers pick a provider via AppSettings; the rest of the
 * pipeline doesn't need to know which one is active.
 *
 * Structured output strategy:
 *   Anthropic — tool_use with a JSON schema (most reliable)
 *   Ollama    — "format: 'json'" + schema description in prompt + validation
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AppSettings } from '@shared/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type Message = { role: 'user' | 'assistant'; content: string }

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; name: string; input: unknown }
  | { type: 'done' }

export type LLMTool = {
  name: string
  description: string
  schema: Record<string, unknown>   // JSON Schema object
}

export type LLMRequest = {
  system: string
  messages: Message[]
  tools?: LLMTool[]
  /** If set, force the model to call this tool (structured output) */
  forceTool?: string
  maxTokens?: number
}

export type LLMResponse = {
  text: string
  toolCalls: Array<{ name: string; input: unknown }>
}

// ── Anthropic client ──────────────────────────────────────────────────────────

let _anthropicClient: Anthropic | null = null

function getAnthropicClient(apiKey: string): Anthropic {
  if (!_anthropicClient || (_anthropicClient as unknown as { apiKey: string }).apiKey !== apiKey) {
    _anthropicClient = new Anthropic({ apiKey })
  }
  return _anthropicClient
}

async function callAnthropic(req: LLMRequest, apiKey: string): Promise<LLMResponse> {
  const client = getAnthropicClient(apiKey)

  const tools: Anthropic.Tool[] | undefined = req.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema as Anthropic.Tool['input_schema']
  }))

  const toolChoice: Anthropic.ToolChoiceAuto | Anthropic.ToolChoiceTool | undefined =
    req.forceTool
      ? { type: 'tool', name: req.forceTool }
      : tools
      ? { type: 'auto' }
      : undefined

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: req.maxTokens ?? 4096,
    system: [
      {
        type: 'text',
        text: req.system,
        // Prompt caching: system prompt is stable across revisions
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: req.messages.map((m, i) => ({
      role: m.role,
      content:
        // Cache the last user message (likely contains the long transcript)
        i === req.messages.length - 1 && m.role === 'user'
          ? [{ type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }]
          : m.content
    })),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {})
  })

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('')

  const toolCalls = response.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => {
      const tu = b as Anthropic.ToolUseBlock
      return { name: tu.name, input: tu.input }
    })

  return { text, toolCalls }
}

// ── Ollama client ─────────────────────────────────────────────────────────────

type OllamaChatMessage = { role: string; content: string }

type OllamaChatResponse = {
  message: { role: string; content: string }
  done: boolean
}

/** Node http/https request — used instead of fetch so timeouts work reliably in Electron main */
function nodeRequest(
  url: string,
  options: { method?: string; body?: string; timeoutMs?: number }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? require('https') : require('http')
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method ?? 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {}
    }
    const req = transport.request(reqOptions, (res: import('http').IncomingMessage) => {
      let data = ''
      res.on('data', (chunk: Buffer) => { data += chunk.toString() })
      res.on('end', () => {
        if ((res.statusCode ?? 0) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`))
        } else {
          resolve(data)
        }
      })
    })
    req.on('error', reject)
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`))
      })
    }
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * Streaming SSE request — calls onLine for each `data: <payload>` line.
 * Used to stream tokens from OpenAI-compatible endpoints.
 */
function nodeRequestStream(
  url: string,
  options: { method?: string; body?: string; timeoutMs?: number },
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? require('https') : require('http')
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      }
    }
    const req = transport.request(reqOptions, (res: import('http').IncomingMessage) => {
      if ((res.statusCode ?? 0) >= 400) {
        let errData = ''
        res.on('data', (c: Buffer) => { errData += c.toString() })
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errData.slice(0, 300)}`)))
        return
      }
      let buffer = ''
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        // Last element may be an incomplete line — keep it in the buffer
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed.startsWith('data: ')) {
            onLine(trimmed.slice(6))
          }
        }
      })
      res.on('end', () => {
        // Flush any remaining buffer
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data: ')) onLine(trimmed.slice(6))
        resolve()
      })
    })
    req.on('error', reject)
    if (options.timeoutMs) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${options.timeoutMs}ms`))
      })
    }
    if (options.body) req.write(options.body)
    req.end()
  })
}

async function callOllama(req: LLMRequest, endpoint: string, model: string): Promise<LLMResponse> {
  const messages: OllamaChatMessage[] = [
    { role: 'system', content: buildOllamaSystem(req) },
    ...req.messages.map((m) => ({ role: m.role, content: m.content }))
  ]

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    options: {
      num_ctx: 24576,          // 24K — fits a full transcript prompt with room for output
      num_predict: req.maxTokens ?? 4096
    }
  }

  // Don't use format:'json' — it forces the model to constrain every token
  // against the schema simultaneously, which spikes memory and causes crashes.
  // We instruct via prompt and extract JSON from prose output instead.

  const raw = await nodeRequest(`${endpoint}/api/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 300_000
  })

  const data = JSON.parse(raw) as OllamaChatResponse
  const content = data.message?.content ?? ''

  const toolCalls: Array<{ name: string; input: unknown }> = []
  if (req.tools?.length) {
    try {
      const parsed = JSON.parse(extractJson(content))
      const matchedTool = req.forceTool
        ? req.tools.find((t) => t.name === req.forceTool)
        : req.tools[0]
      if (matchedTool) toolCalls.push({ name: matchedTool.name, input: parsed })
    } catch {
      // JSON parse failed — caller will see empty toolCalls
    }
  }

  return { text: toolCalls.length ? '' : content, toolCalls }
}

/** Inject tool schema descriptions into the system prompt for Ollama */
function buildOllamaSystem(req: LLMRequest): string {
  if (!req.tools?.length) return req.system

  const toolDesc = req.tools
    .map(
      (t) =>
        `Tool: ${t.name}\n${t.description}\nReturn valid JSON matching this schema:\n${JSON.stringify(t.schema, null, 2)}`
    )
    .join('\n\n')

  const forceNote = req.forceTool
    ? `\nYou MUST respond with valid JSON only — no prose, no markdown fences. The JSON must match the schema for tool "${req.forceTool}".`
    : ''

  return `${req.system}\n\n---\n${toolDesc}${forceNote}`
}

/** Pull the first JSON object/array out of a string that may contain prose */
function extractJson(text: string): string {
  const start = text.indexOf('{') !== -1 ? text.indexOf('{') : text.indexOf('[')
  if (start === -1) return text
  // Find matching close bracket
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return text.slice(start)
}

// ── OpenAI-compatible client (LM Studio, mlx-lm, etc.) ───────────────────────

type OAIMessage = { role: string; content: string }
type OAIResponse = { choices: Array<{ message: { content: string } }> }

async function callOpenAICompat(
  req: LLMRequest,
  endpoint: string,
  model: string,
  onProgress?: (charsReceived: number) => void
): Promise<LLMResponse> {
  const messages: OAIMessage[] = [
    { role: 'system', content: buildOllamaSystem(req) },  // reuse same prompt builder
    ...req.messages.map((m) => ({ role: m.role, content: m.content }))
  ]

  // Use SSE streaming when a progress callback is provided
  if (onProgress) {
    const body = {
      model: model || 'local-model',
      messages,
      max_tokens: req.maxTokens ?? 4096,
      temperature: 0.3,
      stream: true
    }

    let fullContent = ''
    type StreamChunkOAI = { choices: Array<{ delta: { content?: string }; finish_reason?: string }> }

    await nodeRequestStream(
      `${endpoint}/chat/completions`,
      { method: 'POST', body: JSON.stringify(body), timeoutMs: 300_000 },
      (line) => {
        if (line === '[DONE]') return
        try {
          const chunk = JSON.parse(line) as StreamChunkOAI
          const delta = chunk.choices?.[0]?.delta?.content ?? ''
          if (delta) {
            fullContent += delta
            onProgress(fullContent.length)
          }
        } catch { /* ignore malformed SSE chunks */ }
      }
    )

    const toolCalls: Array<{ name: string; input: unknown }> = []
    if (req.tools?.length) {
      try {
        const parsed = JSON.parse(extractJson(fullContent))
        const matchedTool = req.forceTool
          ? req.tools.find((t) => t.name === req.forceTool)
          : req.tools[0]
        if (matchedTool) toolCalls.push({ name: matchedTool.name, input: parsed })
      } catch { /* JSON parse failed */ }
    }

    return { text: toolCalls.length ? '' : fullContent, toolCalls }
  }

  // Non-streaming fallback
  const body = {
    model: model || 'local-model',
    messages,
    max_tokens: req.maxTokens ?? 4096,
    temperature: 0.3
  }

  const raw = await nodeRequest(`${endpoint}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 300_000
  })

  const data = JSON.parse(raw) as OAIResponse
  const content = data.choices?.[0]?.message?.content ?? ''

  const toolCalls: Array<{ name: string; input: unknown }> = []
  if (req.tools?.length) {
    try {
      const parsed = JSON.parse(extractJson(content))
      const matchedTool = req.forceTool
        ? req.tools.find((t) => t.name === req.forceTool)
        : req.tools[0]
      if (matchedTool) toolCalls.push({ name: matchedTool.name, input: parsed })
    } catch { /* JSON parse failed */ }
  }

  return { text: toolCalls.length ? '' : content, toolCalls }
}

export async function checkOpenAICompat(endpoint: string): Promise<{ models: string[] }> {
  const raw = await nodeRequest(`${endpoint}/models`, { timeoutMs: 5000 })
  const data = JSON.parse(raw) as { data?: Array<{ id: string }> }
  return { models: data.data?.map((m) => m.id) ?? [] }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function llmCall(
  req: LLMRequest,
  settings: AppSettings,
  apiKey: string,
  onProgress?: (charsReceived: number) => void
): Promise<LLMResponse> {
  if (settings.llmProvider === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key not set. Add it in Settings.')
    return callAnthropic(req, apiKey)
  }

  if (settings.llmProvider === 'openai-compat') {
    return callOpenAICompat(req, settings.openaiCompatEndpoint, settings.openaiCompatModel, onProgress)
  }

  return callOllama(req, settings.ollamaEndpoint, settings.ollamaModel)
}

// ── Ollama health / model listing ─────────────────────────────────────────────

export type OllamaModelInfo = { name: string; size: number; modified_at: string }

export async function listOllamaModels(endpoint: string): Promise<OllamaModelInfo[]> {
  const raw = await nodeRequest(`${endpoint}/api/tags`, { timeoutMs: 5000 })
  const data = JSON.parse(raw) as { models?: OllamaModelInfo[] }
  return data.models ?? []
}

export async function checkAnthropic(apiKey: string): Promise<void> {
  if (!apiKey) throw new Error('No API key provided')
  // Minimal call to validate the key
  const client = getAnthropicClient(apiKey)
  await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'hi' }]
  })
}
