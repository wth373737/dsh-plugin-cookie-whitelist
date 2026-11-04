/**
 * Durable, non-secret state: the domain whitelist, authorization requests,
 * extension presence, and the pairing token.
 *
 * Cookie VALUES never enter this store and are never written to disk.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  atomicWriteJson,
  ensureDir,
  isoNow,
  normalizeDomain,
  randomId,
  randomToken,
  readJson,
  readText,
} from './util.mjs'

const STATE_VERSION = 1

function emptyState() {
  return {
    version: STATE_VERSION,
    whitelist: [],
    requests: [],
    extension: { lastSeen: 0, browser: '', version: '', error: '' },
    stats: { lastCookieSync: 0, totalAccepted: 0 },
    createdAt: isoNow(),
    updatedAt: isoNow(),
  }
}

function normalizeState(input) {
  if (!input || typeof input !== 'object' || input.version !== STATE_VERSION) return emptyState()
  const state = {
    ...emptyState(),
    ...input,
    whitelist: [],
    requests: [],
  }
  const seen = new Set()
  for (const item of Array.isArray(input.whitelist) ? input.whitelist : []) {
    const domain = normalizeDomain(item)
    if (domain === null || seen.has(domain)) continue
    seen.add(domain)
    state.whitelist.push(domain)
  }
  for (const item of Array.isArray(input.requests) ? input.requests : []) {
    if (!item || typeof item !== 'object') continue
    const domain = normalizeDomain(item.domain)
    if (domain === null) continue
    if (!['pending', 'approved', 'rejected', 'expired'].includes(item.status)) continue
    state.requests.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : randomId('req_'),
      domain,
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 500) : '',
      source: typeof item.source === 'string' ? item.source.slice(0, 80) : 'agent',
      sessionId: typeof item.sessionId === 'string' ? item.sessionId.slice(0, 160) : '',
      status: item.status,
      createdAt: Number(item.createdAt) || Date.now(),
      expiresAt: Number(item.expiresAt) || 0,
      decidedAt: Number(item.decidedAt) || 0,
      decidedBy: typeof item.decidedBy === 'string' ? item.decidedBy.slice(0, 80) : '',
    })
  }
  state.requests = state.requests.slice(-200)
  state.extension = {
    lastSeen: Number(input.extension?.lastSeen) || 0,
    browser: typeof input.extension?.browser === 'string' ? input.extension.browser.slice(0, 80) : '',
    version: typeof input.extension?.version === 'string' ? input.extension.version.slice(0, 40) : '',
    error: typeof input.extension?.error === 'string' ? input.extension.error.slice(0, 300) : '',
  }
  state.stats = {
    lastCookieSync: Number(input.stats?.lastCookieSync) || 0,
    totalAccepted: Number(input.stats?.totalAccepted) || 0,
  }
  return state
}

export class BridgeStore {
  constructor({ dataDir, config, log = console }) {
    this.dataDir = dataDir
    this.config = config
    this.log = log
    this.stateFile = path.join(dataDir, 'state.json')
    this.tokenFile = path.join(dataDir, 'pairing-token')
    this.state = emptyState()
    this.token = ''
    this.tasks = new Map()
    this.syncQueue = new Set()
    this.saveTimer = null
    this.saveDirty = false
    this.loaded = false
  }

  async load() {
    await ensureDir(this.dataDir)
    const raw = await readJson(this.stateFile, null)
    this.state = normalizeState(raw)
    if (raw === null) await this.saveNow()

    let token = (await readText(this.tokenFile, '')).trim()
    if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) {
      token = randomToken(24)
      await fs.writeFile(this.tokenFile, token, { encoding: 'utf8', mode: 0o600 })
    }
    this.token = token

    // A restart may have lost the in-memory sync queue. Asking the extension
    // to re-read the current whitelist is safe and keeps the vault warm.
    for (const domain of this.state.whitelist) this.syncQueue.add(domain)
    this.loaded = true
  }

  get tokenValue() {
    return this.token
  }

  listWhitelist() {
    return [...this.state.whitelist]
  }

  /** @returns {string | null} the whitelist entry that authorizes this host */
  matchWhitelist(host) {
    const normalized = normalizeDomain(host)
    if (normalized === null) return null
    for (const domain of this.state.whitelist) {
      if (normalized === domain || normalized.endsWith(`.${domain}`)) return domain
    }
    return null
  }

  isWhitelisted(host) {
    return this.matchWhitelist(host) !== null
  }

  addWhitelist(input, source = 'user') {
    const domain = normalizeDomain(input)
    if (domain === null) throw new Error('invalid domain')
    if (this.state.whitelist.includes(domain)) {
      this.enqueueSync([domain])
      return { domain, added: false }
    }
    this.state.whitelist.push(domain)
    this.state.whitelist.sort()
    this.state.updatedAt = isoNow()
    this.enqueueSync([domain])
    this.scheduleSave()
    this.log.info?.(`[cookie-whitelist] whitelist add ${domain} (${source})`)
    return { domain, added: true }
  }

  removeWhitelist(input) {
    const domain = normalizeDomain(input)
    if (domain === null) throw new Error('invalid domain')
    const before = this.state.whitelist.length
    this.state.whitelist = this.state.whitelist.filter((item) => item !== domain)
    if (this.state.whitelist.length !== before) {
      this.state.updatedAt = isoNow()
      this.scheduleSave()
      this.log.info?.(`[cookie-whitelist] whitelist remove ${domain}`)
      return { domain, removed: true }
    }
    return { domain, removed: false }
  }

  listRequests({ includeDecided = false } = {}) {
    this.expireRequests()
    const rows = this.state.requests.filter((item) => includeDecided || item.status === 'pending')
    return rows.map((item) => ({ ...item }))
  }

  pendingCount() {
    this.expireRequests()
    return this.state.requests.filter((item) => item.status === 'pending').length
  }

  createRequest({ domain: input, reason = '', sessionId = '', source = 'agent' }) {
    const domain = normalizeDomain(input)
    if (domain === null) throw new Error('invalid domain')
    if (this.isWhitelisted(domain)) return { request: null, already: true }
    this.expireRequests()
    const existing = this.state.requests.find((item) => item.domain === domain && item.status === 'pending')
    if (existing) return { request: { ...existing }, already: false }
    const ttlMs = Math.max(1, Number(this.config.security?.requestTtlMinutes ?? 10)) * 60_000
    const request = {
      id: randomId('req_'),
      domain,
      reason: String(reason ?? '').slice(0, 500),
      source: String(source ?? 'agent').slice(0, 80),
      sessionId: String(sessionId ?? '').slice(0, 160),
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      decidedAt: 0,
      decidedBy: '',
    }
    this.state.requests.push(request)
    if (this.state.requests.length > 200) this.state.requests = this.state.requests.slice(-200)
    this.state.updatedAt = isoNow()
    this.scheduleSave()
    this.log.info?.(`[cookie-whitelist] authorization requested for ${domain}`)
    return { request: { ...request }, already: false }
  }

  decideRequest(id, approve, by = 'user') {
    this.expireRequests()
    const request = this.state.requests.find((item) => item.id === id)
    if (!request) throw new Error('authorization request not found')
    if (request.status !== 'pending' && request.status !== 'expired') throw new Error(`authorization request is ${request.status}`)
    request.status = approve ? 'approved' : 'rejected'
    request.decidedAt = Date.now()
    request.decidedBy = String(by ?? 'user').slice(0, 80)
    if (approve) this.addWhitelist(request.domain, `request:${request.id}`)
    this.state.updatedAt = isoNow()
    this.scheduleSave()
    this.log.info?.(`[cookie-whitelist] authorization ${request.status} for ${request.domain}`)
    return { ...request }
  }

  expireRequests() {
    const now = Date.now()
    let changed = false
    for (const request of this.state.requests) {
      if (request.status === 'pending' && request.expiresAt > 0 && request.expiresAt < now) {
        request.status = 'expired'
        request.decidedAt = now
        request.decidedBy = 'timeout'
        changed = true
      }
    }
    if (changed) this.scheduleSave()
  }

  touchExtension(info = {}) {
    const next = {
      lastSeen: Date.now(),
      browser: typeof info.browser === 'string' ? info.browser.slice(0, 80) : this.state.extension.browser,
      version: typeof info.version === 'string' ? info.version.slice(0, 40) : this.state.extension.version,
      error: typeof info.error === 'string' ? info.error.slice(0, 300) : '',
    }
    this.state.extension = next
    this.state.updatedAt = isoNow()
    this.scheduleSave(4000)
  }

  getExtension() {
    return { ...this.state.extension }
  }

  getStats() {
    return { ...this.state.stats }
  }

  enqueueSync(domains) {
    let queued = 0
    for (const input of Array.isArray(domains) ? domains : [domains]) {
      const domain = normalizeDomain(input)
      if (domain === null) continue
      if (!this.isWhitelisted(domain)) continue
      this.syncQueue.add(domain)
      queued += 1
    }
    return queued
  }

  enqueueAll() {
    return this.enqueueSync(this.state.whitelist)
  }

  /** Pop one batch of approved domains for an extension poll. */
  takeTasks({ maxDomains = 40, ttlMs = 150_000 } = {}) {
    const now = Date.now()
    for (const [id, task] of this.tasks) {
      if (now - task.createdAt > ttlMs) {
        this.tasks.delete(id)
        for (const domain of task.domains) {
          if (this.isWhitelisted(domain)) this.syncQueue.add(domain)
        }
      }
    }
    const domains = []
    for (const domain of this.syncQueue) {
      if (domains.length >= maxDomains) break
      this.syncQueue.delete(domain)
      domains.push(domain)
    }
    if (domains.length === 0) return []
    const task = {
      id: randomId('task_'),
      domains,
      createdAt: now,
    }
    this.tasks.set(task.id, task)
    return [{ ...task }]
  }

  completeTask(taskId, { accepted = 0, browser = '', version = '' } = {}) {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false, reason: 'unknown-or-expired-task' }
    this.tasks.delete(taskId)
    this.state.stats.lastCookieSync = Date.now()
    this.state.stats.totalAccepted += Math.max(0, Number(accepted) || 0)
    this.touchExtension({ browser, version })
    this.state.updatedAt = isoNow()
    this.scheduleSave()
    return { ok: true, task }
  }

  failTask(taskId, error = '') {
    const task = this.tasks.get(taskId)
    if (!task) return { ok: false }
    this.tasks.delete(taskId)
    for (const domain of task.domains) {
      if (this.isWhitelisted(domain)) this.syncQueue.add(domain)
    }
    this.touchExtension({ error })
    return { ok: true }
  }

  status() {
    this.expireRequests()
    const extension = this.getExtension()
    return {
      whitelist: this.listWhitelist(),
      requests: this.listRequests(),
      pendingCount: this.pendingCount(),
      extension: {
        ...extension,
        connected: extension.lastSeen > 0 && Date.now() - extension.lastSeen < 90_000,
      },
      stats: this.getStats(),
    }
  }

  scheduleSave(delayMs = 250) {
    this.saveDirty = true
    if (this.saveTimer !== null) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (!this.saveDirty) return
      this.saveDirty = false
      void this.saveNow().catch((error) => {
        this.log.error?.(`[cookie-whitelist] state save failed: ${error?.message ?? error}`)
      })
    }, delayMs)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  async saveNow() {
    this.state.updatedAt = isoNow()
    await atomicWriteJson(this.stateFile, this.state)
  }

  async dispose() {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.saveNow()
  }
}

