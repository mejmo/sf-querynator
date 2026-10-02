import { readFile, writeFile } from 'node:fs/promises'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { API_METHODS, IPC_PREFIX, type DialogMethods, type ServiceApi } from '../shared/api'
import type { Result } from '../shared/types'
import { toAppError } from './errors'
import type { AppService } from './service'
import { logError } from './log'

async function wrap<T>(name: string, fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    const error = toAppError(e)
    if (error.kind === 'unknown') logError(`ipc ${name}`, e)
    return { ok: false, error }
  }
}

const DIALOG_METHODS: readonly string[] = ['saveFile', 'openTextFile'] satisfies DialogMethods[]

export function registerIpc(service: AppService, getWindow: () => BrowserWindow | null) {
  const showSave = (options: Electron.SaveDialogOptions) => {
    const win = getWindow()
    return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
  }
  const showOpen = (options: Electron.OpenDialogOptions) => {
    const win = getWindow()
    return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
  }

  for (const name of API_METHODS) {
    if (DIALOG_METHODS.includes(name)) continue
    ipcMain.handle(IPC_PREFIX + name, (_event, ...args: unknown[]) =>
      wrap(name, () => (service[name as keyof ServiceApi] as (...a: unknown[]) => Promise<unknown>).apply(service, args))
    )
  }

  ipcMain.handle(IPC_PREFIX + 'saveFile', (_event, defaultName: string, content: string) =>
    wrap('saveFile', async () => {
      const ext = defaultName.split('.').pop() ?? 'txt'
      const { canceled, filePath } = await showSave({ defaultPath: defaultName, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
      if (canceled || !filePath) return false
      await writeFile(filePath, content, 'utf8')
      return true
    })
  )

  ipcMain.handle(IPC_PREFIX + 'openTextFile', (_event, filterName: string, extensions: string[]) =>
    wrap('openTextFile', async () => {
      const { canceled, filePaths } = await showOpen({ properties: ['openFile'], filters: [{ name: filterName, extensions }] })
      if (canceled || !filePaths[0]) return null
      return readFile(filePaths[0], 'utf8')
    })
  )
}
