/**
 * Minimal Chrome DevTools Protocol client and Chromium launcher.
 *
 * No Playwright/Puppeteer dependency: Node 22+ ships a WebSocket, and Chrome
 * exposes a loopback debugging endpoint. The browser runs on a disposable
 * profile with --incognito, so cookie state is memory-only even at the
 * browser layer.
 */
import { execFile, spawn as nodeSpawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { delay, randomId } from './util.mjs'

const execFileAsync = promisify(execFile)
const PROFILE_PREFIX = 'cw-browser-'

export class CdpConnection {
  constructor(wsUrl, { log = console, label = 'CDP' } = {}) {
    const WS = globalThis.WebSocket
    if (typeof WS !== 'function') throw new Error('this Node runtime has no global WebSocket')
    this.wsUrl = wsUrl
    this.label = label
    this.log = log
    this.ws = new WS(wsUrl)
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.closed = false
    this.closeReason = null
  }

  async open(timeoutMs = 10_000) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.label}: websocket open timed out`)), timeoutMs)
      const onOpen = () => {
        clearTimeout(timer)
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
        resolve()
      }
      const onError = () => {
        clearTimeout(timer)
        this.ws.removeEventListener('open', onOpen)
        this.ws.removeEventListener('error', onError)
        reject(new Error(`${this.label}: websocket connection failed`))
      }
      this.ws.addEventListener('open', onOpen, { once: true })
      this.ws.addEventListener('error', onError, { once: true })
    })
    this.ws.addEventListener('message', (event) => this.onMessage(event))
    this.ws.addEventListener('close', (event) => this.onClose(event?.reason || 'socket closed'))
    this.ws.addEventListener('error', () => this.onClose('socket error'))
    return this
  }

  onMessage(event) {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const row = this.pending.get(message.id)
      if (!row) return
      this.pending.delete(message.id)
      clearTimeout(row.timer)
      if (message.error) row.reject(new Error(`${row.method}: ${message.error.message ?? 'CDP error'}`))
      else row.resolve(message.result ?? {})
      return
    }
    if (typeof message.method === 'string') {
      const handlers = this.listeners.get(message.method)
      if (handlers) {
        for (const handler of [...handlers]) {
          try {
            handler(message.params ?? {}, message)
          } catch (error) {
            this.log.error?.(`[cookie-whitelist] CDP listener failed for ${message.method}: ${error?.message ?? error}`)
          }
        }
      }
    }
  }

  on(method, handler) {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  once(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      let timer = null
      const off = this.on(method, (params) => {
        if (timer) clearTimeout(timer)
        off()
        resolve(params)
      })
      timer = setTimeout(() => {
        off()
        reject(new Error(`${method}: event timed out`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error(`${this.label}: connection closed (${this.closeReason ?? 'unknown'})`))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: CDP command timed out`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  onClose(reason) {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const [id, row] of this.pending) {
      clearTimeout(row.timer)
      row.reject(new Error(`${row.method}: CDP connection closed (${reason})`))
      this.pending.delete(id)
    }
  }

  close() {
    try {
      this.ws.close()
    } catch {
      // ignore
    }
    this.onClose('client close')
  }
}

function windowsCandidates() {
  const env = process.env
  const roots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean)
  const out = []
  for (const root of roots) {
    out.push({ kind: 'chrome', executable: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })
    out.push({ kind: 'edge', executable: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })
  }
  return out
}

function posixCandidates() {
  const out = []
  if (process.platform === 'darwin') {
    out.push({ kind: 'chrome', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
    out.push({ kind: 'edge', executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' })
  } else {
    for (const executable of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']) {
      out.push({ kind: executable.includes('edge') ? 'edge' : 'chrome', executable })
    }
  }
  return out
}

export async function discoverChromiumBrowsers() {
  const candidates = process.platform === 'win32' ? windowsCandidates() : posixCandidates()
  const seen = new Set()
  const found = []
  for (const candidate of candidates) {
    const key = candidate.executable.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    try {
      await fs.access(candidate.executable)
      found.push(candidate)
    } catch {
      // not installed
    }
  }
  found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'chrome' ? -1 : 1))
  return found
}

export async function resolveBrowser(config = {}) {
  const explicit = typeof config.browser?.executable === 'string' ? config.browser.executable.trim() : ''
  if (explicit !== '') {
    try {
      await fs.access(explicit)
      return { kind: explicit.toLowerCase().includes('edge') ? 'edge' : 'chrome', executable: explicit, explicit: true }
    } catch {
      throw new Error(`configured browser executable does not exist: ${explicit}`)
    }
  }
  const found = await discoverChromiumBrowsers()
  if (found.length === 0) throw new Error('no Chrome/Edge executable found; install Chrome or Edge, or set browser.executable')
  return { ...found[0], explicit: false }
}

function buildArgs({ profileDir, headless, url }) {
  const args = [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-features=Translate,OptimizationHints,MediaRouter,PrivacySandboxSettings4,AutofillServerCommunication',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--metrics-recording-only',
    '--mute-audio',
    '--window-size=1280,900',
    '--incognito',
  ]
  if (headless) {
    args.push('--headless=new')
    args.push('--disable-gpu')
    args.push('--hide-scrollbars')
  }
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage')
  args.push(url || 'about:blank')
  return args
}

function spawnBrowser(executable, args, { visible = false } = {}) {
  const child = nodeSpawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: !visible,
    detached: false,
  })
  const handle = {
    child,
    pid: child.pid,
    exitCode: null,
    signal: null,
    stderr: '',
    exited: null,
  }
  handle.exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      handle.exitCode = code
      handle.signal = signal
      resolve({ code, signal })
    })
  })
  child.on('error', (error) => {
    handle.stderr = `${handle.stderr}\n${error?.message ?? error}`.slice(-16_384)
  })
  child.stderr?.on('data', (chunk) => {
    handle.stderr = `${handle.stderr}${chunk.toString('utf8')}`.slice(-16_384)
  })
  return handle
}

export async function killBrowserHandle(handle, { log = console } = {}) {
  if (!handle) return
  try {
    handle.child.kill()
  } catch {
    // ignore
  }
  await Promise.race([handle.exited, delay(1800)])
  if (handle.exitCode === null) {
    try {
      if (process.platform === 'win32') {
        await execFileAsync('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { timeout: 8000 })
      } else {
        process.kill(handle.pid, 'SIGKILL')
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/not found|no process|not running/i.test(message)) log.warn?.(`[cookie-whitelist] browser kill fallback failed: ${message}`)
    }
    await Promise.race([handle.exited, delay(2500)])
  }
}

async function readDevToolsActivePort(profileDir) {
  try {
    const text = await fs.readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')
    const lines = text.trim().split(/\r?\n/)
    const port = Number(lines[0])
    if (!Number.isInteger(port) || port <= 0) return null
    return { port, browserPath: lines[1] ?? '' }
  } catch {
    return null
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

export async function findPageTarget(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`)
      const page = Array.isArray(list) ? list.find((item) => item && item.type === 'page' && typeof item.webSocketDebuggerUrl === 'string') : null
      if (page) return page
    } catch (error) {
      lastError = error
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
      if (response.ok) {
        const page = await response.json()
        if (page && typeof page.webSocketDebuggerUrl === 'string') return page
      }
    } catch (error) {
      lastError = error
    }
    await delay(120)
  }
  throw new Error(`could not find a page target on CDP port ${port}${lastError ? `: ${lastError.message}` : ''}`)
}

/**
 * Launch one Chromium on a disposable profile and attach to its page target.
 */
export async function launchChromium({
  executable,
  headless = true,
  visible = false,
  url = 'about:blank',
  dataDir,
  log = console,
  timeoutMs = 20_000,
} = {}) {
  if (!executable) throw new Error('missing browser executable')
  const profileDir = path.join(dataDir, `${PROFILE_PREFIX}${process.pid}-${randomId()}`)
  await fs.mkdir(profileDir, { recursive: true })
  const args = buildArgs({ profileDir, headless, url })
  const handle = spawnBrowser(executable, args, { visible })
  try {
    const deadline = Date.now() + timeoutMs
    let portInfo = null
    while (Date.now() < deadline) {
      if (handle.exitCode !== null) {
        throw new Error(`browser exited before CDP was ready (code ${handle.exitCode}): ${handle.stderr.trim().slice(-1200)}`)
      }
      portInfo = await readDevToolsActivePort(profileDir)
      if (portInfo) break
      await delay(120)
    }
    if (!portInfo) throw new Error('browser did not write DevToolsActivePort in time')
    const page = await findPageTarget(portInfo.port, Math.max(3000, deadline - Date.now()))
    const cdp = new CdpConnection(page.webSocketDebuggerUrl, { log, label: 'page' })
    await cdp.open(10_000)
    return { handle, port: portInfo.port, cdp, profileDir, executable, page }
  } catch (error) {
    await killBrowserHandle(handle, { log })
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {})
    throw error
  }
}

export async function cleanupProfile(profileDir, log = console) {
  if (!profileDir) return
  try {
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
  } catch (error) {
    log.warn?.(`[cookie-whitelist] could not remove browser profile: ${error?.message ?? error}`)
  }
}


