/**
 * Localhost-only HTTP receiver used by the browser extensions.
 *
 * Hard rules:
 *   - bind 127.0.0.1 only;
 *   - every /v1 request needs the pairing token;
 *   - a browser page origin (http/https) is rejected before auth so a random
 *     website cannot use the user's browser as a confused deputy;
 *   - request bodies are bounded and cookie values are never logged.
 */
import http from 'node:http'
import { safeEqualString } from './util.mjs'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const TOKEN_HEADER = 'x-cookie-whitelist-token'
const POLL_MS = 2000

function corsOrigin(origin) {
  if (!origin) return '*'
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return origin
  return null
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class ExtensionReceiver {
  constructor({ store, vault, config, log = console, version = '1.0.0' }) {
    this.store = store
    this.vault = vault
    this.config = config
    this.log = log
    this.version = version
    this.server = null
    this.port = 0
    this.sockets = new Set()
    this.rate = new Map()
  }

  get url() {
    return this.port > 0 ? `http://127.0.0.1:${this.port}` : ''
  }

  async start() {
    const preferred = Number(this.config.server?.port ?? 47821)
    const candidates = []
    if (Number.isInteger(preferred) && preferred >= 0 && preferred <= 65535) {
      candidates.push(preferred)
      if (preferred > 0) {
        for (let i = 1; i <= 9; i += 1) {
          if (preferred + i <= 65535) candidates.push(preferred + i)
        }
      }
    }
    candidates.push(0)
    let lastError = null
    for (const port of [...new Set(candidates)]) {
      try {
        await this.listen(port)
        this.log.info?.(`[cookie-whitelist] extension receiver listening on ${this.url}`)
        return this.url
      } catch (error) {
        lastError = error
        if (error?.code === 'EADDRINUSE' || error?.code === 'EACCES') continue
        throw error
      }
    }
    throw lastError ?? new Error('could not bind the extension receiver')
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handle(req, res).catch((error) => {
          this.log.error?.(`[cookie-whitelist] receiver handler failed: ${error?.message ?? error}`)
          this.sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'internal error' } })
        })
      })
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
      })
      const onError = (error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        this.server = server
        const address = server.address()
        this.port = typeof address === 'object' && address !== null ? address.port : 0
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  allowedOrigin(origin) {
    if (!origin) return true
    return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')
  }

  rateLimited(req) {
    const key = req.socket.remoteAddress ?? 'local'
    const now = Date.now()
    const row = this.rate.get(key)
    if (!row || now - row.window > 60_000) {
      this.rate.set(key, { window: now, count: 1 })
      return false
    }
    row.count += 1
    return row.count > 300
  }

  authenticate(req) {
    const header = req.headers[TOKEN_HEADER]
    const provided = Array.isArray(header) ? header[0] : header
    return typeof provided === 'string' && safeEqualString(provided, this.store.tokenValue)
  }

  async handle(req, res) {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (req.method === 'OPTIONS') {
      if (!this.allowedOrigin(origin)) {
        this.sendJson(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'origin not allowed' } })
        return
      }
      this.setCors(res, origin)
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': `content-type, ${TOKEN_HEADER}`,
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      })
      res.end()
      return
    }

    if (!this.allowedOrigin(origin)) {
      this.sendJson(res, 403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN', message: 'origin not allowed' } })
      return
    }
    if (this.rateLimited(req)) {
      this.sendJson(res, 429, { ok: false, error: { code: 'RATE_LIMITED', message: 'too many requests' } })
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/health') {
      this.sendJson(res, 200, { ok: true, name: 'dsh-plugin-cookie-whitelist', version: this.version, time: Date.now() })
      return
    }

    if (!url.pathname.startsWith('/v1/')) {
      this.sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
      return
    }
    if (!this.authenticate(req)) {
      this.sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid pairing token' } })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/tasks') {
      const tasks = this.store.takeTasks({ maxDomains: Math.max(1, Number(this.config.server?.maxDomainsPerTask ?? 40)) })
      this.sendJson(res, 200, { ok: true, tasks, pollMs: POLL_MS, serverTime: Date.now() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/status') {
      const body = await this.readJson(req)
      if (!isPlainObject(body)) throw new Error('invalid body')
      this.store.touchExtension({
        browser: typeof body.browser === 'string' ? body.browser : '',
        version: typeof body.version === 'string' ? body.version : '',
        error: typeof body.error === 'string' ? body.error : '',
      })
      this.sendJson(res, 200, { ok: true, serverTime: Date.now() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/ping') {
      this.sendJson(res, 200, { ok: true, serverTime: Date.now() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/error') {
      const body = await this.readJson(req)
      if (!isPlainObject(body)) throw new Error('invalid body')
      if (typeof body.taskId === 'string') this.store.failTask(body.taskId, typeof body.message === 'string' ? body.message : 'extension error')
      this.sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/cookies') {
      await this.acceptCookies(req, res)
      return
    }

    this.sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
  }

  async acceptCookies(req, res) {
    const body = await this.readJson(req)
    if (!isPlainObject(body)) {
      this.sendJson(res, 400, { ok: false, error: { code: 'BAD_BODY', message: 'invalid body' } })
      return
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId : ''
    if (taskId === '') {
      this.sendJson(res, 400, { ok: false, error: { code: 'BAD_TASK', message: 'missing task id' } })
      return
    }
    const task = this.store.tasks.get(taskId)
    if (!task) {
      this.sendJson(res, 409, { ok: false, error: { code: 'TASK_EXPIRED', message: 'task is unknown or expired' } })
      return
    }
    if (!isPlainObject(body.domains)) {
      this.sendJson(res, 400, { ok: false, error: { code: 'BAD_BODY', message: 'domains must be an object' } })
      return
    }
    let total = 0
    let totalDropped = 0
    const perDomain = []
    for (const [domain, cookies] of Object.entries(body.domains)) {
      const allowed = task.domains.includes(domain) || this.store.isWhitelisted(domain)
      if (!allowed) {
        perDomain.push({ domain, accepted: 0, dropped: 0, rejected: 'not-in-task' })
        continue
      }
      const result = this.vault.put(domain, cookies)
      total += result.accepted
      totalDropped += result.dropped
      perDomain.push({ domain: result.domain ?? domain, accepted: result.accepted, dropped: result.dropped })
    }
    this.store.completeTask(taskId, {
      accepted: total,
      browser: typeof body.browser === 'string' ? body.browser : '',
      version: typeof body.version === 'string' ? body.version : '',
    })
    this.log.info?.(`[cookie-whitelist] extension delivered ${total} cookie(s) across ${perDomain.length} domain(s)`)
    this.sendJson(res, 200, {
      ok: true,
      taskId,
      accepted: total,
      dropped: totalDropped,
      domains: perDomain,
      serverTime: Date.now(),
    })
  }

  async readJson(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return null
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('invalid JSON body')
    }
  }

  setCors(res, origin) {
    const value = corsOrigin(origin)
    if (value !== null) res.setHeader('Access-Control-Allow-Origin', value)
    res.setHeader('Vary', 'Origin')
  }

  sendJson(res, status, value) {
    if (res.headersSent) return
    this.setCors(res, typeof res.req?.headers?.origin === 'string' ? res.req.headers.origin : undefined)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(value))
  }

  async stop() {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(() => resolve())
      for (const socket of this.sockets) {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
      }
      this.sockets.clear()
      const timer = setTimeout(resolve, 1500)
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}

