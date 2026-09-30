import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, IPC_PREFIX, type Api } from '../shared/api'

const api = Object.fromEntries(
  API_METHODS.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(IPC_PREFIX + name, ...args)])
) as unknown as Api

contextBridge.exposeInMainWorld('api', api)
