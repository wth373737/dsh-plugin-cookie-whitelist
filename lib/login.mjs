/**
 * Temporary interactive login fallback.
 *
 * For browsers without a supported extension (or when a site refuses the
 * exported cookie), the plugin opens a disposable incognito Chrome/Edge
 * window on the whitelisted domain. The user logs in by hand, then clicks
 * "finish": cookies for that domain are copied into the memory vault and the
 * window/profile are destroyed. Nothing is persisted.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { cleanupProfile, killBrowserHandle, launchChromium, resolveBrowser } from './cdp.mjs'
import { cookieBelongsToDomain, normalizeDomain, randomId } from './util.mjs'

export class TempLoginManager {
  constructor({ dataDir, config, store, vault, log = console }) {
    this.dataDir = dataDir
    this.config = config
    this.store = store
    this.vault = vault
    this.log = log
    this.sessions = new Map()
  }

  list() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      domain: session.domain,
      startedAt: session.startedAt,
      running: session.launch.handle.exitCode === null,
      url: session.url,
    }))
  }

  async start(input) {
    const domain = normalizeDomain(input)
    if (domain === null) throw new Error('invalid domain')
    if (!this.store.isWhitelisted(domain)) throw new Error('domain must be whitelisted before a temporary login')
    for (const existing of [...this.sessions.values()]) {
      if (existing.domain === domain) await this.cancel(existing.id)
    }
    const browser = await resolveBrowser(this.config)
    const id = randomId('login_')
    const root = path.join(this.dataDir, 'login', id)
    await fs.mkdir(root, { recursive: true })
    const url = `https://${domain}/`
    const launched = await launchChromium({
      executable: browser.executable,
      headless: false,
      visible: true,
      url,
      dataDir: root,
      log: this.log,
      timeoutMs: 25_000,
    })
    const session = {
      id,
      domain,
      url,
      startedAt: Date.now(),
      root,
      launch: launched,
      cdp: launched.cdp,
    }
    this.sessions.set(id, session)
    this.log.info?.(`[cookie-whitelist] temporary login window opened for ${domain}`)
    return { id, domain, url, browser: browser.kind }
  }

  async finish(id) {
    const session = this.sessions.get(id)
    if (!session) throw new Error('temporary login session not found')
    if (session.launch.handle.exitCode !== null) {
      await this.cleanup(session)
      throw new Error('the login window is already closed; start a new temporary login')
    }
    let cookies = []
    try {
      const result = await session.cdp.send('Network.getAllCookies', {}, 10_000)
      cookies = Array.isArray(result?.cookies) ? result.cookies : []
    } catch {
      const result = await session.cdp.send('Storage.getCookies', {}, 10_000).catch(() => null)
      cookies = Array.isArray(result?.cookies) ? result.cookies : []
    }
    const scoped = cookies.filter((cookie) => cookie && cookieBelongsToDomain(cookie.domain, session.domain))
    const stored = this.vault.put(session.domain, scoped)
    await this.cleanup(session)
    this.log.info?.(`[cookie-whitelist] temporary login captured ${stored.accepted} cookie(s) for ${session.domain}`)
    return {
      domain: session.domain,
      accepted: stored.accepted,
      dropped: stored.dropped,
      extracted: scoped.length,
    }
  }

  async cancel(id) {
    const session = this.sessions.get(id)
    if (!session) return { cancelled: false }
    await this.cleanup(session)
    return { cancelled: true }
  }

  async cleanup(session) {
    this.sessions.delete(session.id)
    try {
      await session.cdp.send('Network.clearBrowserCookies', {}, 2500)
    } catch {
      // window may already be closed
    }
    session.cdp.close()
    await killBrowserHandle(session.launch.handle, { log: this.log })
    await cleanupProfile(session.launch.profileDir, this.log)
    await fs.rm(session.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }).catch(() => {})
  }

  async dispose() {
    for (const session of [...this.sessions.values()]) {
      await this.cleanup(session).catch(() => {})
    }
  }
}

