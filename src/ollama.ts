import type { PhilaConfig } from './types.ts'

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface OllamaResponse {
  message: { role: string; content: string }
  done: boolean
}

export async function chat(
  messages: OllamaMessage[],
  config: PhilaConfig,
): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: false,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ollama ${res.status}: ${body}`)
  }

  const data = (await res.json()) as OllamaResponse
  return data.message.content
}
