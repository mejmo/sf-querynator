// Development-only UI smoke driver (never loaded in packaged builds). Run against scripts/mock-salesforce.mjs:
//   QN_SMOKE=<screenshot dir> QN_USER_DATA=<temp profile> QN_OPENAI_URL=http://127.0.0.1:8787/v1/chat/completions npx electron-vite preview
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, clipboard, type BrowserWindow } from 'electron'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const EDITOR_TEXT = `[...document.querySelectorAll('.editor-host .view-line')].sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)).map((l) => l.textContent).join(String.fromCharCode(10)).replaceAll(String.fromCharCode(160), ' ')`
const SUGGESTIONS = `[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map(r => r.getAttribute('aria-label')).join(' | ')`
// Regression check: app CSS once collapsed Monaco's suggestion rows (labels rendered below the row).
const SUGGESTION_LABEL_VISIBLE = `(() => {
  const r = document.querySelector('.suggest-widget .monaco-list-row')
  const l = r?.querySelector('.label-name')
  if (!r || !l) return false
  const rb = r.getBoundingClientRect(), lb = l.getBoundingClientRect()
  return lb.top >= rb.top && lb.bottom <= rb.bottom + 1
})()`

export async function runSmoke(win: BrowserWindow, dir: string) {
  const wc = win.webContents
  // An unfocused window gets throttled animation frames, so Monaco's DOM would lag behind its model.
  wc.setBackgroundThrottling(false)
  const js = <T>(code: string) => wc.executeJavaScript(code) as Promise<T>
  const log = (msg: string) => console.log(`[smoke] ${msg}`)

  const shot = async (name: string) => {
    // capturePage occasionally fails while the compositor is busy; retry briefly.
    for (let i = 0; ; i++) {
      try {
        return await writeFile(join(dir, `${name}.png`), (await wc.capturePage()).toPNG())
      } catch (e) {
        if (i >= 4) throw e
        await sleep(300)
      }
    }
  }
  const clickButton = (text: string) =>
    js<boolean>(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(${JSON.stringify(text)}) && !b.disabled); b?.click(); return !!b })()`
    )
  const waitFor = async (code: string, what: string, attempts = 50) => {
    for (let i = 0; i < attempts; i++) {
      if (await js<boolean>(code)) return
      await sleep(200)
    }
    throw new Error(`Timed out waiting for ${what}`)
  }
  const key = (keyCode: string, modifiers: ('control' | 'shift' | 'alt')[] = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }
  /** Replace the editor content via the clipboard (synthetic key-by-key typing drops characters). */
  const typeInEditor = async (text: string) => {
    // Focus can be lost after a child window (sign-in) or modal closes, so retry a few times.
    for (let attempt = 1; ; attempt++) {
      win.focus()
      await js(`(document.querySelector('.editor-host .native-edit-context') ?? document.querySelector('.editor-host textarea'))?.focus()`)
      await sleep(150)
      key('A', ['control'])
      clipboard.writeText(text)
      wc.paste()
      try {
        await waitFor(`${EDITOR_TEXT}.trim() === ${JSON.stringify(text.trim())}`, `editor text "${text}"`, 15)
        break
      } catch (e) {
        if (attempt >= 3) throw e
      }
    }
    key('Escape')
  }

  try {
    await sleep(1500)
    log(`login clicked: ${await clickButton('Login')}`)
    await waitFor(`!!document.querySelector('.usercard .name')`, 'user card')
    log(`user: ${await js<string>(`document.querySelector('.usercard .name').textContent`)}`)

    await typeInEditor('SELECT Id, Name, Owner.Name, (SELECT LastName FROM Contacts) FROM Account')
    key('Enter', ['control'])
    await waitFor(`!!document.querySelector('.results-bar .stats')`, 'results')
    log(`results: ${await js<string>(`document.querySelector('.results-bar .stats').textContent`)}`)
    await clickButton('Load more')
    await waitFor(`document.querySelector('.results-bar .stats').textContent.includes('1,000 loaded')`, 'load more')
    log(`after load more: ${await js<string>(`document.querySelector('.results-bar .stats').textContent`)}`)
    await shot('1-results')

    // Layout: drag the editor/results divider, resize a column, reorder columns by drag and drop.
    const rect = (selector: string) =>
      js<{ x: number; y: number; w: number; h: number }>(
        `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })()`
      )
    const drag = async (x: number, y: number, dx: number, dy: number) => {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
      for (let i = 1; i <= 5; i++) {
        wc.sendInputEvent({ type: 'mouseMove', x: Math.round(x + (dx * i) / 5), y: Math.round(y + (dy * i) / 5), button: 'left' })
        await sleep(30)
      }
      wc.sendInputEvent({ type: 'mouseUp', x: x + dx, y: y + dy, button: 'left', clickCount: 1 })
      await sleep(200)
    }
    const before = await rect('.editor-wrap')
    const splitter = await rect('.splitter')
    await drag(Math.round(splitter.x + splitter.w / 2), Math.round(splitter.y + splitter.h / 2), 0, 120)
    log(`editor height: ${Math.round(before.h)} -> ${Math.round((await rect('.editor-wrap')).h)}`)

    const headerNames = `[...document.querySelectorAll('.thead .th:not(.rownum) .th-label')].map((l) => l.textContent).join(' | ')`
    const nameHeader = `[...document.querySelectorAll('.thead .th')].find((h) => h.querySelector('.th-label')?.textContent === 'Name')`
    const nameWidth = () => js<number>(`Math.round(${nameHeader}.getBoundingClientRect().width)`)
    const widthBefore = await nameWidth()
    const resizer = await js<{ x: number; y: number }>(
      `(() => { const r = ${nameHeader}.querySelector('.col-resizer').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
    )
    await drag(resizer.x, resizer.y, 90, 0)
    log(`Name column width: ${widthBefore} -> ${await nameWidth()}`)

    log(`columns before reorder: ${await js<string>(headerNames)}`)
    // Live reorder with a real mouse drag: Owner.Name onto the left half of Id; the order must change mid-drag.
    const headerCenter = (name: string) =>
      js<{ x: number; y: number }>(
        `(() => { const r = [...document.querySelectorAll('.thead .th')].find((h) => h.querySelector('.th-label')?.textContent === ${JSON.stringify(name)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`
      )
    const src = await headerCenter('Owner.Name')
    const idHeader = await rect('.thead .th:not(.rownum)')
    const targetX = Math.round(idHeader.x + 8)
    wc.sendInputEvent({ type: 'mouseDown', x: src.x, y: src.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= 10; i++) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(src.x + ((targetX - src.x) * i) / 10), y: src.y, button: 'left' })
      await sleep(40)
    }
    log(`columns during drag (live): ${await js<string>(headerNames)}`)
    wc.sendInputEvent({ type: 'mouseUp', x: targetX, y: src.y, button: 'left', clickCount: 1 })
    await sleep(200)
    log(`columns after reorder: ${await js<string>(headerNames)}`)
    await shot('1b-layout')

    await clickButton('records')
    await waitFor(`!!document.querySelector('.subquery .tr')`, 'subquery popup')
    log(`subquery rows: ${await js<number>(`document.querySelectorAll('.subquery .tr').length`)}`)
    await shot('2-subquery')
    key('Escape')
    await sleep(200)

    await typeInEditor('SELECT Id, Name FROM Account WHERE Type = ')
    key('End')
    key('Space', ['control'])
    await sleep(1200)
    log(`picklist suggestions: ${await js<string>(SUGGESTIONS)}`)
    log(`suggestion row label visible: ${await js<boolean>(SUGGESTION_LABEL_VISIBLE)}`)
    await shot('3-picklist')
    key('Escape')

    await typeInEditor('SELECT Id, Owner. FROM Account')
    key('Home')
    for (let i = 0; i < 'SELECT Id, Owner.'.length; i++) {
      key('Right')
      await sleep(20)
    }
    key('Space', ['control'])
    await sleep(1200)
    log(`relationship suggestions: ${await js<string>(SUGGESTIONS)}`)
    await shot('4-relationship')
    key('Escape')

    await typeInEditor("select id, name from account where type = 'Customer' order by name limit 5")
    await clickButton('Beautify')
    await waitFor(`${EDITOR_TEXT}.includes('ORDER BY')`, 'beautify')
    log(`beautified: ${JSON.stringify(await js<string>(EDITOR_TEXT))}`)

    await typeInEditor('SELECT Id FRO Account')
    key('Enter', ['control'])
    await waitFor(`!!document.querySelector('.banner')`, 'error banner')
    await waitFor(`document.querySelectorAll('.editor-host .squiggly-error').length > 0`, 'error marker')
    log(`error banner: ${await js<string>(`document.querySelector('.banner .msg').textContent.replace(/\\s+/g, ' ')`)}`)
    await shot('5-error')
    log(`history entries: ${await js<number>(`document.querySelectorAll('.history li').length`)}`)

    // Store an OpenAI key, reload (tests silent reconnect with the stored refresh token), then use Fix with AI.
    await js(`window.api.setOpenAiKey('sk-mock')`)
    wc.reload()
    wc.setBackgroundThrottling(false)
    win.focus()
    await sleep(1500)
    await waitFor(`!!document.querySelector('.usercard .name')`, 'silent reconnect')
    log('reconnected after reload')
    await waitFor(`document.querySelectorAll('.editor-host .view-line').length > 0`, 'editor after reload')
    await sleep(500)
    await typeInEditor('SELECT Id FRO Account')
    key('Enter', ['control'])
    await waitFor(`!!document.querySelector('.banner')`, 'error banner')
    await clickButton('Fix with AI')
    await waitFor(`!!document.querySelector('.aidialog .diff-host .monaco-diff-editor')`, 'AI diff')
    await sleep(800)
    log(`AI explanation: ${await js<string>(`document.querySelector('.aidialog .explanation').textContent`)}`)
    await shot('6-ai')
    await clickButton('Accept')
    await waitFor(`${EDITOR_TEXT}.includes('FROM Account')`, 'accepted suggestion')
    log(`after accept: ${JSON.stringify(await js<string>(EDITOR_TEXT))}`)

    // Objects tab: browse Account, expand a picklist, build a query from ticked fields.
    await clickButton('Objects')
    await waitFor(`[...document.querySelectorAll('.explorer-objects li')].some((li) => li.title === 'Account')`, 'object list')
    await js(`[...document.querySelectorAll('.explorer-objects li')].find((li) => li.title === 'Account').click()`)
    await waitFor(`!!document.querySelector('.explorer-head .object-title')`, 'Account fields')
    log(`explorer: ${await js<string>(`document.querySelector('.explorer-head .api-name').textContent`)}`)
    log(`field types: ${await js<string>(`[...document.querySelector('table.fields tbody').children].filter((r) => !r.classList.contains('values-row')).slice(0, 12).map((r) => r.children[1].firstChild.textContent + ' ' + r.children[3].textContent.replace(/[▸▾].*/, '').trim() + (r.children[4].textContent ? ' [' + r.children[4].textContent + ']' : '')).join(' | ')`)}`)
    await clickButton('3 values')
    await waitFor(`!!document.querySelector('.values-row')`, 'picklist values')
    log(`picklist values: ${await js<string>(`document.querySelector('.values-row').textContent`)}`)
    await js(`(() => {
      const rows = [...document.querySelector('table.fields tbody').children]
      for (const name of ['Id', 'Name', 'Type']) rows.find((r) => r.children[1]?.firstChild?.textContent === name)?.querySelector('input').click()
    })()`)
    await sleep(200)
    await shot('8-objects')
    await clickButton('Query selected')
    await waitFor(`!document.querySelector('.tab-panel:not([hidden]) .explorer')`, 'switch to query tab')
    await waitFor(`${EDITOR_TEXT}.includes('FROM Account')`, 'generated query')
    log(`query from explorer: ${JSON.stringify(await js<string>(EDITOR_TEXT))}`)

    // Multiple users per environment: add a second user, switch back, log one out.
    const USER_NAME = `document.querySelector('.usercard .name')?.textContent`
    const USER_OPTIONS = `[...document.querySelectorAll('.user-select option')].map((o) => o.textContent).join(' | ')`
    const pickUser = (value: string) =>
      js(`(() => {
        const sel = document.querySelector('.user-select')
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)})
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      })()`)
    const firstName = await js<string>(USER_NAME)
    const firstId = await js<string>(`document.querySelector('.user-select').value`)
    await pickUser('__add__')
    await waitFor(`!!${USER_NAME} && ${USER_NAME} !== ${JSON.stringify(firstName)}`, 'second user')
    log(`after add user: ${await js<string>(USER_NAME)} · options: ${await js<string>(USER_OPTIONS)}`)
    await shot('7-users')
    await pickUser(firstId)
    await waitFor(`${USER_NAME} === ${JSON.stringify(firstName)}`, 'switch back to first user')
    log(`after switch: ${await js<string>(USER_NAME)}`)
    await clickButton('Logout')
    await waitFor(`!document.querySelector('.usercard .name')`, 'logout')
    log(`after logout: options: ${await js<string>(USER_OPTIONS)}`)
    log('DONE')
  } catch (e) {
    log(`FAILED: ${e instanceof Error ? e.message : String(e)}`)
    log(`editor text now: ${JSON.stringify(await js<string>(EDITOR_TEXT).catch((err: Error) => 'ERR ' + err.message))} codes: ${JSON.stringify(await js<number[]>('[...' + EDITOR_TEXT + '].slice(0, 12).map(c => c.charCodeAt(0))').catch(() => []))}`)
    await shot('failure').catch(() => undefined)
  } finally {
    app.quit()
  }
}
