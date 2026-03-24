import type { PhilaConfig } from './types.ts'

interface OllamaResponse {
  message: { content: string }
}

export async function chat(system: string, user: string, config: PhilaConfig): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      options: { temperature: 0.1, num_predict: 128, top_p: 0.5 },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ollama ${res.status}: ${body}`)
  }

  return ((await res.json()) as OllamaResponse).message.content
}
