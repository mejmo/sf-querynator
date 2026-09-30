import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Only added to production builds: the dev server needs inline scripts for React Refresh.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'"
].join('; ')

function cspPlugin(): Plugin {
  return {
    name: 'querynator-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }
    ]
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), cspPlugin()]
  }
})
