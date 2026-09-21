/** Isolated Chromium dispatch fixture: the OS opener is a receipt spy, never shell.openExternal. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, protocol, session } from 'electron'

const [root, expectedVersion] = process.argv.slice(2)
assert.ok(root, 'The parent must allocate a private fixture directory')
assert.equal(process.versions.electron, expectedVersion)
assert.equal(app.isPackaged, false, 'Only development Electron may run this fixture')
app.setPath('userData', join(root, 'user-data'))
app.setPath('sessionData', join(root, 'session-data'))
app.setPath('logs', join(root, 'logs'))
app.setPath('crashDumps', join(root, 'crash-dumps'))
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-domain-reliability')
app.commandLine.appendSwitch('no-proxy-server')
protocol.registerSchemesAsPrivileged([
  { scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'navigation-forbidden', privileges: { standard: true, secure: true } },
])

const receipt = {
  timedOut: false,
  stage: 'starting',
  electronVersion: process.versions.electron,
  packaged: app.isPackaged,
  cases: [],
  createdWindows: 0,
  blockedRequests: [],
  openFailures: 0,
  recoveries: [],
}
let window
let active
let documentSequence = 0
// This deadline reports failure; only explicit events/renderer replies advance cases.
const deadline = setTimeout(() => {
  receipt.timedOut = true
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
  app.exit(2)
}, 45_000)
app.on('window-all-closed', () => { /* The fixture writes its receipt before quitting. */ })

async function run() {
  const { installDesktopWindowNavigation } = await import(pathToFileURL(join(root, 'window-navigation.mjs')).href)
  receipt.stage = 'app readiness'
  await app.whenReady()
  receipt.stage = 'window creation'
  const isolatedSession = session.fromPartition(`navigation-${process.pid}`)
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const owned = new URL(details.url).protocol === 'dsh-app:'
    if (!owned) receipt.blockedRequests.push(details.url)
    callback({ cancel: !owned })
  })
  await isolatedSession.protocol.handle('dsh-app', () => new Response(`<!doctype html>
    <html data-fixture-document="${++documentSequence}"><head><title>Navigation fixture</title></head><body>
    <a id="chat-https" href="https://example.invalid/chat" target="_blank" rel="noopener noreferrer">Chat HTTPS</a>
    <a id="chat-http" href="http://example.invalid/chat" target="_blank" rel="noopener noreferrer">Chat HTTP</a>
    <a id="oauth-https" href="https://example.invalid/device" target="_self">OAuth HTTPS</a>
    <a id="oauth-http" href="http://example.invalid/device" target="_self">OAuth HTTP</a>
    <a id="blocked-self" href="navigation-forbidden://navigation-test/blocked" target="_self">Non-app document</a>
    <a id="owned" href="dsh-app://navigation-test/next.html" target="_self">Owned document</a>
    </body></html>`, {
    headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'" },
  }))
  // Keep a rejected custom scheme entirely in-process even if production cancellation regresses.
  isolatedSession.protocol.handle('navigation-forbidden', () => new Response('Not an application document'))
  window = new BrowserWindow({
    show: false,
    webPreferences: { session: isolatedSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const contents = window.webContents
  contents.on('did-create-window', (popup) => {
    receipt.createdWindows++
    // A regressed policy must not leave even an unexpected fixture popup alive.
    popup.destroy()
  })
  installDesktopWindowNavigation(contents, {
    async openExternal(url) {
      assert.ok(active, 'Unexpected OS-open request outside an active case')
      active.externalUrls.push(url)
      active.opened()
    },
    openFailed() { receipt.openFailures++ },
    recover(url) { receipt.recoveries.push(url.href) },
  })
  // Observe Electron's event after the production listener, without cancelling it ourselves.
  contents.on('will-navigate', (event, url) => {
    if (active) {
      active.navigationEvents.push({ url, prevented: event.defaultPrevented })
      active.navigated()
    }
  })
  await window.loadURL('dsh-app://navigation-test/index.html')
  const preferences = contents.getLastWebPreferences()
  receipt.preferences = {
    sandbox: preferences.sandbox,
    contextIsolation: preferences.contextIsolation,
    nodeIntegration: preferences.nodeIntegration,
  }
  const observeDocument = () => contents.executeJavaScript(`({
    url: location.href,
    documentId: document.documentElement.dataset.fixtureDocument,
    nodeAvailable: typeof process !== 'undefined' || typeof require !== 'undefined'
  })`)
  receipt.initialDocument = await observeDocument()

  async function attempt(name, script, completion) {
    receipt.stage = name
    let opened
    let navigated
    const open = new Promise(resolve => { opened = resolve })
    const navigate = new Promise(resolve => { navigated = resolve })
    active = { name, externalUrls: [], navigationEvents: [], opened, navigated }
    // DOM activation with a user gesture exercises Chromium/Electron dispatch, not a hand-emitted event.
    const rendererResult = await contents.executeJavaScript(script, true)
    if (completion === 'open') await open
    if (completion === 'navigate') await navigate
    // A second renderer round-trip observes the document after dispatch and the OS-spy callback.
    const document = await observeDocument()
    receipt.cases.push({
      name,
      externalUrls: active.externalUrls,
      navigationEvents: active.navigationEvents,
      rendererResult,
      document,
      windowCount: BrowserWindow.getAllWindows().length,
    })
  }

  for (const id of ['chat-https', 'chat-http', 'oauth-https', 'oauth-http']) {
    await attempt(id, `document.getElementById(${JSON.stringify(id)}).click(); null`, 'open')
  }
  await attempt('window-open-https', "window.open('https://example.invalid/script', '_blank') === null", 'open')
  await attempt('window-open-http', "window.open('http://example.invalid/script', '_blank') === null", 'open')
  await attempt('popup-about', "window.open('about:blank', '_blank') === null", 'renderer')
  await attempt('popup-data', "window.open('data:text/html,<h1>not an app document</h1>', '_blank') === null", 'renderer')
  await attempt('blocked-self', "document.getElementById('blocked-self').click(); null", 'navigate')

  active = undefined
  const loaded = once(contents, 'did-finish-load')
  await contents.executeJavaScript("document.getElementById('owned').click(); null", true)
  await loaded
  receipt.ownedDocument = await observeDocument()
  active = undefined
}

async function main() {
  try {
    await run()
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (window && !window.isDestroyed()) {
      const closed = once(window, 'closed')
      window.destroy()
      await closed
    }
    receipt.remainingWindows = BrowserWindow.getAllWindows().length
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 })
    clearTimeout(deadline)
    process.exitCode = receipt.error ? 1 : 0
    app.quit()
  }
}

// Electron must finish evaluating its ESM entry before app.whenReady() can settle.
void main()
