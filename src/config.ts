import type { PhilaConfig } from './types.ts'

const defaults: PhilaConfig = {
  model: 'llama3.2',
  ollamaUrl: 'http://localhost:11434',
  batchWindowMs: 3000,
  memoryWindowSize: 50,
  dbPath: 'phila.db',
}

export const config: Readonly<PhilaConfig> = Object.freeze({
  model: process.env['PHILA_MODEL'] ?? defaults.model,
  ollamaUrl: process.env['PHILA_OLLAMA_URL'] ?? defaults.ollamaUrl,
  batchWindowMs: Number(process.env['PHILA_BATCH_WINDOW']) || defaults.batchWindowMs,
  memoryWindowSize: Number(process.env['PHILA_MEMORY_WINDOW']) || defaults.memoryWindowSize,
  dbPath: process.env['PHILA_DB_PATH'] ?? defaults.dbPath,
})
