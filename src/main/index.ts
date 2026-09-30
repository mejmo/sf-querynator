import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, net, safeStorage, shell } from 'electron'
import { createWindowAuthorizer } from './auth/loginWindow'
import type { FetchFn } from './errors'
import { runSmoke } from './devSmoke'
import { registerIpc } from './ipc'
import { initLog, logError } from './log'
import { lockDownPermissions } from './permissions'
import { AppService } from './service'
import { HistoryStore } from './store/history'
import { MetaCache } from './store/metaCache'
import { SecretsStore } from './store/secrets'
import { SettingsStore } from './store/settings'

let mainWindow: BrowserWindow | null = null

/** Static files shipped next to the compiled code (out/main -> ../../resources, also inside app.asar). */
const RESOURCES = join(__dirname, '../../resources')
const APP_ICON = join(RESOURCES, 'icon.png')
/** The splash stays at least this long so it doesn't just flicker on fast machines. */
const SPLASH_MIN_MS = 1200

// Dev aid: QN_USER_DATA points the app at a throwaway profile.
if (!app.isPackaged && process.env.QN_USER_DATA) app.setPath('userData', process.env.QN_USER_DATA)
// Smoke runs must keep rendering even when another window covers them.
if (!app.isPackaged && process.env.QN_SMOKE) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 640,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    icon: APP_ICON,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, disableBlinkFeatures: 'Auxclick' }
  })
  splash.once('ready-to-show', () => splash.show())
  // Dev aid: QN_SPLASH_SHOT=out.png saves what the splash renders.
  const splashShot = !app.isPackaged ? process.env.QN_SPLASH_SHOT : undefined
  if (splashShot) {
    splash.webContents.once('did-finish-load', () =>
      setTimeout(async () => void writeFile(splashShot, (await splash.webContents.capturePage()).toPNG()), 500)
    )
  }
  void splash.loadFile(join(RESOURCES, 'splash.html'))
  return splash
}

function createWindow() {
  // Fresh launches show the splash until the main window has painted; macOS dock re-activation doesn't.
  const splash = BrowserWindow.getAllWindows().length === 0 && !process.env.QN_SMOKE ? createSplash() : null
  const shownAt = Date.now()

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Querynator',
    icon: APP_ICON,
    backgroundColor: '#17151f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Middle-click must not open links in new windows.
      disableBlinkFeatures: 'Auxclick'
    }
  })

  // Links never open inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', ({ level, message }) => {
      if (level === 'warning' || level === 'error') console.log(`[renderer:${level}] ${message}`)
    })
    // Dev aid: QN_SCREENSHOT=out.png saves a screenshot a few seconds after load, then quits.
    const shot = process.env.QN_SCREENSHOT
    if (shot) {
      mainWindow.webContents.once('did-finish-load', () =>
        setTimeout(async () => {
          const image = await mainWindow?.webContents.capturePage()
          if (image) await writeFile(shot, image.toPNG())
          app.quit()
        }, Number(process.env.QN_SCREENSHOT_DELAY ?? 3000))
      )
    }
  }

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  const win = mainWindow
  win.once('ready-to-show', () => {
    setTimeout(
      () => {
        if (!win.isDestroyed()) win.show()
        if (splash && !splash.isDestroyed()) splash.close()
      },
      splash ? Math.max(0, SPLASH_MIN_MS - (Date.now() - shownAt)) : 0
    )
  })
  win.on('closed', () => {
    if (splash && !splash.isDestroyed()) splash.close()
    mainWindow = null
  })
}

app.whenReady().then(() => {
  lockDownPermissions()
  const data = app.getPath('userData')
  const smokeDir = !app.isPackaged ? process.env.QN_SMOKE : undefined
  initLog(join(data, 'logs', 'main.log'))

  const service = new AppService({
    settings: new SettingsStore(join(data, 'settings.json')),
    secrets: new SecretsStore(join(data, 'secrets.bin'), safeStorage),
    history: new HistoryStore(join(data, 'history')),
    meta: new MetaCache(join(data, 'meta')),
    // net.fetch uses Chromium's network stack, so system proxy settings apply.
    fetchFn: ((url, init) => net.fetch(url, init)) as FetchFn,
    authorize: createWindowAuthorizer(() => mainWindow),
    openAiUrl: !app.isPackaged ? process.env.QN_OPENAI_URL : undefined
  })
  registerIpc(service, () => mainWindow)
  createWindow()
  if (smokeDir && mainWindow) {
    const win = mainWindow
    win.webContents.once('did-finish-load', () => void runSmoke(win, smokeDir))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (e) => logError('uncaughtException', e))
process.on('unhandledRejection', (e) => logError('unhandledRejection', e))
