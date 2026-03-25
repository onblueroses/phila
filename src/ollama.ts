import type { PhilaConfig } from './types.ts'

interface OllamaResponse {
  message: { content: string }
}

async function attempt(system: string, user: string, config: PhilaConfig): Promise<string> {
  const res = await fetch(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      options: { temperature: 0.1, num_predict: 64, top_p: 0.5 },
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ollama ${res.status}: ${body}`)
  }

  return ((await res.json()) as OllamaResponse).message.content
}

export async function chat(system: string, user: string, config: PhilaConfig): Promise<string> {
  try {
    return await attempt(system, user, config)
  } catch {
    await new Promise((r) => setTimeout(r, 2000))
    return attempt(system, user, config)
  }
}
