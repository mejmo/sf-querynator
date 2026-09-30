import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

let logFile: string | null = null

export function initLog(file: string) {
  logFile = file
}

export function logError(context: string, e: unknown) {
  const detail = e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e)
  const line = `[${new Date().toISOString()}] ${context}: ${detail}\n`
  console.error(line)
  if (!logFile) return
  const file = logFile
  void mkdir(dirname(file), { recursive: true })
    .then(() => appendFile(file, line))
    .catch(() => undefined)
}
