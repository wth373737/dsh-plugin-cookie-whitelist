/**
 * Host service: state, receiver, vault, read-only browser, temporary login,
 * agent tools, and the same-origin settings API.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ReadOnlyBrowser } from './browser.mjs'
import { TempLoginManager } from './login.mjs'
import { ExtensionReceiver } from './receiver.mjs'
import { BridgeStore } from './store.mjs'
import { createTools } from './tools.mjs'
import { normalizeDomain } from './util.mjs'
import { CookieVault } from './vault.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '1.1.0'
const UI_HEADER = 'x-cookie-whitelist-ui'
const MAX_UI_BODY = 1024 * 1024

const SYSTEM_PROMPT = `Cookie whitelist (dsh-plugin-cookie-whitelist):
- The user's browser cookies are available ONLY for domains on the runtime whitelist. A new domain needs the user's explicit approval: use cookie_authorize; never assume or self-approve.
- Call cookie_whitelist_status first when a task depends on an existing login. Use cookie_sync after approval, then cookie_browse to read the page.
- cookie_browse is read-only: navigation and GET/HEAD/click/scroll/screenshot, with form submission and all non-GET methods blocked. Non-whitelisted sites are visited anonymously.
- Course pages often put test dates, schedules, rubrics and guidelines in files, not in page text. When a page has a Course Planner, Schedule, syllabus, lecture notes, or PDF/Office file, call cookie_browse action:'files' and then action:'read_file'. Do not skip a file just because it is a PDF.
- read_file uses only whitelist cookies. Files above the inline limit require the user's approval in chat; the default is to read in memory and keep nothing. Ask before keeping a downloaded file, and mention that temporary files are deleted by default.
- Never ask the user to paste cookie values, and never repeat a cookie value in a message.`

function isoMinutes(ms) {
  return Math.round(Number(ms) / 60_000)
}

export class CookieWhitelistService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.log = {
      info: (...args) => console.log(...args),
      warn: (...args) => console.warn(...args),
      error: (...args) => console.error(...args),
    }
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
    this.dataDir = path.resolve(config.dataDir && config.dataDir.trim() !== '' ? config.dataDir : path.join(home, 'cookie-whitelist'))
    this.config.dataDir = this.dataDir
    this.store = new BridgeStore({ dataDir: this.dataDir, config: this.config, log: this.log })
    this.vault = new CookieVault({
      ttlMs: Math.max(1, Number(this.config.security?.vaultTtlMinutes ?? 120)) * 60_000,
      maxCookiesPerDomain: this.config.security?.maxCookiesPerDomain,
      maxBytesPerDomain: this.config.security?.maxCookieBytesPerDomain,
      log: this.log,
    })
    this.browser = new ReadOnlyBrowser({ dataDir: this.dataDir, config: this.config, store: this.store, vault: this.vault, log: this.log })
    this.login = new TempLoginManager({ dataDir: this.dataDir, config: this.config, store: this.store, vault: this.vault, log: this.log })
    this.receiver = new ExtensionReceiver({ store: this.store, vault: this.vault, config: this.config, log: this.log, version: VERSION })
    this.tools = createTools(this)
    this.ready = null
    this.startError = null
    this.disposers = []
    this.pruneTimer = null
  }

  async start() {
    this.ready = this.startInternal().catch((error) => {
      this.startError = error
      this.log.error?.(`[cookie-whitelist] start failed: ${error?.message ?? error}`)
      throw error
    })
    return this.ready
  }

  async startInternal() {
    await fs.mkdir(this.dataDir, { recursive: true })
    await this.cleanupStaleProfiles()
    await this.store.load()

    const systemPrompt = typeof this.ctx.get === 'function' ? this.ctx.get('systemPrompt') : undefined
    if (systemPrompt) {
      try {
        this.disposers.push(systemPrompt.section({ name: 'cookie-whitelist', order: 60, text: SYSTEM_PROMPT }))
      } catch (error) {
        this.log.warn?.(`[cookie-whitelist] system prompt section unavailable: ${error?.message ?? error}`)
      }
    }

    await this.receiver.start()

    const webServer = typeof this.ctx.get === 'function' ? this.ctx.get('webServer') : undefined
    if (webServer) {
      try {
        this.disposers.push(
          webServer.register({
            kind: 'prefix',
            path: '/cookie-whitelist/api',
            handler: (req, res) => this.handleUiRequest(req, res, webServer),
          }),
        )
      } catch (error) {
        this.log.error?.(`[cookie-whitelist] could not register the settings API: ${error?.message ?? error}`)
      }
    }

    this.pruneTimer = setInterval(() => this.vault.prune(), 60_000)
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref()
    this.log.info?.(`[cookie-whitelist] ready; receiver=${this.receiver.url || 'disabled'}; data=${this.dataDir}`)
  }

  async cleanupStaleProfiles() {
    try {
      const entries = await fs.readdir(this.dataDir, { withFileTypes: true })
      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('cw-browser-')) {
          const target = path.join(this.dataDir, entry.name)
          const stat = await fs.stat(target).catch(() => null)
          if (stat && stat.mtimeMs < cutoff) await fs.rm(target, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
          continue
        }
        if (entry.name === 'login') {
          const loginRoot = path.join(this.dataDir, 'login')
          const sessions = await fs.readdir(loginRoot, { withFileTypes: true }).catch(() => [])
          for (const session of sessions) {
            if (!session.isDirectory()) continue
            const target = path.join(loginRoot, session.name)
            const stat = await fs.stat(target).catch(() => null)
            if (stat && stat.mtimeMs < cutoff) await fs.rm(target, { recursive: true, force: true, maxRetries: 2 }).catch(() => {})
          }
        }
      }
    } catch {
      // A missing data dir is created later.
    }
  }

  extensionConnected() {
    const extension = this.store.getExtension()
    return extension.lastSeen > 0 && Date.now() - extension.lastSeen < 90_000
  }

  statusForAgent() {
    const status = this.store.status()
    return {
      ok: true,
      version: VERSION,
      receiver: { running: this.receiver.port > 0, port: this.receiver.port },
      extension: status.extension,
      whitelist: status.whitelist,
      pendingRequests: status.requests.map((request) => ({
        id: request.id,
        domain: request.domain,
        reason: request.reason,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
      })),
      vault: {
        domains: this.vault.stats(),
        totalCookies: this.vault.totalCookies(),
      },
      browser: this.browser.status,
      loginSessions: this.login.list(),
      limits: {
        vaultTtlMinutes: isoMinutes(this.vault.ttlMs),
        requestTtlMinutes: Number(this.config.security?.requestTtlMinutes ?? 10),
        readOnlyMethods: ['GET', 'HEAD', 'OPTIONS'],
      },
      note: 'Cookie values are never returned by this tool.',
    }
  }

  uiStatus() {
    const status = this.store.status()
    return {
      ok: true,
      version: VERSION,
      dataDir: this.dataDir,
      receiver: {
        running: this.receiver.port > 0,
        port: this.receiver.port,
        url: this.receiver.url,
      },
      whitelist: status.whitelist,
      requests: status.requests,
      extension: status.extension,
      vault: {
        totalCookies: this.vault.totalCookies(),
        domains: this.vault.stats(),
      },
      browser: this.browser.status,
      loginSessions: this.login.list(),
      stats: status.stats,
      limits: {
        requestTtlMinutes: Number(this.config.security?.requestTtlMinutes ?? 10),
        vaultTtlMinutes: Number(this.config.security?.vaultTtlMinutes ?? 120),
        maxCookiesPerDomain: this.config.security?.maxCookiesPerDomain ?? 3000,
      },
    }
  }

  pairingInfo() {
    return {
      ok: true,
      receiverUrl: this.receiver.url,
      token: this.store.tokenValue,
      version: VERSION,
      extensions: {
        chromium: path.join(PACKAGE_ROOT, 'extension', 'chromium'),
        firefox: path.join(PACKAGE_ROOT, 'extension', 'firefox'),
      },
      steps: [
        'Open chrome://extensions (Chrome) or edge://extensions (Edge), enable Developer mode, and Load unpacked the chromium folder.',
        'Open the extension options page, paste the receiver URL and token, then save.',
        'For Firefox: about:debugging > This Firefox > Load Temporary Add-on > select extension/firefox/manifest.json.',
        'Return here; the extension should turn green within a few seconds.',
      ],
      stepsZh: [
        '打开 chrome://extensions（Chrome）或 edge://extensions（Edge），开启右上角「开发者模式」。',
        '点「加载已解压的扩展程序」，选择插件目录下的 extension/chromium。',
        '打开扩展「选项」，填入本页的接收地址和配对令牌，保存并点「测试连接」。',
        'Firefox：打开 about:debugging → 本 Firefox → 临时载入附加组件，选择 extension/firefox/manifest.json。',
        '回到本页，扩展状态应在几秒内变为「已连接」。',
      ],
    }
  }

  async handleUiRequest(req, res, webServer) {
    const send = (status, value) => {
      if (res.headersSent) return
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.end(JSON.stringify(value))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'POST' || url.pathname !== '/cookie-whitelist/api') {
        send(404, { ok: false, error: { message: 'not found' } })
        return
      }
      if (req.headers[UI_HEADER] !== '1') {
        send(403, { ok: false, error: { message: 'missing UI header' } })
        return
      }
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
      if (origin !== '') {
        let expected = ''
        try {
          expected = webServer.getOrigin()
        } catch {
          expected = ''
        }
        if (expected !== '' && origin !== expected) {
          send(403, { ok: false, error: { message: 'origin mismatch' } })
          return
        }
      }
      const body = await this.readUiBody(req)
      const method = typeof body?.method === 'string' ? body.method : ''
      const value = await this.dispatchUi(method, body)
      send(200, { ok: true, value })
    } catch (error) {
      send(200, { ok: false, error: { message: String(error?.message ?? error).slice(0, 500) } })
    }
  }

  async readUiBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_UI_BODY) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      throw new Error('invalid JSON body')
    }
  }

  async dispatchUi(method, body) {
    await this.ready
    switch (method) {
      case 'status':
        return this.uiStatus()
      case 'pairing':
        return this.pairingInfo()
      case 'whitelist.add': {
        const domain = normalizeDomain(body.domain)
        if (domain === null) throw new Error('invalid domain')
        const result = this.store.addWhitelist(domain, 'settings-ui')
        return { ...result, status: this.uiStatus() }
      }
      case 'whitelist.remove': {
        const domain = normalizeDomain(body.domain)
        if (domain === null) throw new Error('invalid domain')
        const result = this.store.removeWhitelist(domain)
        if (result.removed) this.vault.removeDomain(domain)
        return { ...result, status: this.uiStatus() }
      }
      case 'requests.approve': {
        const request = this.store.decideRequest(String(body.id ?? ''), true, 'settings-ui')
        this.store.enqueueSync([request.domain])
        return { request, status: this.uiStatus() }
      }
      case 'requests.reject': {
        const request = this.store.decideRequest(String(body.id ?? ''), false, 'settings-ui')
        return { request, status: this.uiStatus() }
      }
      case 'sync.all': {
        const queued = this.store.enqueueAll()
        return { queued, extensionConnected: this.extensionConnected(), status: this.uiStatus() }
      }
      case 'vault.clear': {
        this.vault.clear()
        return { cleared: true, status: this.uiStatus() }
      }
      case 'browser.close': {
        await this.browser.close()
        return { closed: true, status: this.uiStatus() }
      }
      case 'login.start': {
        const session = await this.login.start(body.domain)
        return { session, status: this.uiStatus() }
      }
      case 'login.finish': {
        const result = await this.login.finish(String(body.id ?? ''))
        return { result, status: this.uiStatus() }
      }
      case 'login.cancel': {
        const result = await this.login.cancel(String(body.id ?? ''))
        return { result, status: this.uiStatus() }
      }
      case 'login.list':
        return { sessions: this.login.list(), status: this.uiStatus() }
      case 'extension.reveal': {
        const kind = body.kind === 'firefox' ? 'firefox' : 'chromium'
        const target = path.join(PACKAGE_ROOT, 'extension', kind)
        await fs.access(target)
        this.revealFolder(target)
        return { path: target }
      }
      case 'request.create':
        throw new Error('authorization requests are created by the agent tool, not by the settings page')
      default:
        throw new Error(`unknown method: ${method}`)
    }
  }

  revealFolder(target) {
    try {
      if (process.platform === 'win32') execFile('explorer.exe', [target], { windowsHide: false })
      else if (process.platform === 'darwin') execFile('open', [target])
      else execFile('xdg-open', [target])
    } catch (error) {
      this.log.warn?.(`[cookie-whitelist] could not open folder: ${error?.message ?? error}`)
    }
  }

  async dispose() {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    for (const dispose of this.disposers.splice(0)) {
      try {
        await dispose()
      } catch {
        // ignore teardown errors
      }
    }
    await this.receiver.stop().catch(() => {})
    await this.login.dispose().catch(() => {})
    await this.browser.dispose().catch(() => {})
    this.vault.dispose()
    await this.store.dispose().catch(() => {})
  }
}






