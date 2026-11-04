/**
 * The in-memory cookie vault.
 *
 * Invariants:
 *   - Values live only in this process memory and are never logged, returned
 *     by status tools, or written to disk.
 *   - A bucket is keyed by the requested whitelist domain. A cookie is only
 *     accepted when its own Domain attribute applies to that requested domain.
 *   - `getForUrl` refuses non-whitelisted hosts; the caller also clears the
 *     browser jar before every anonymous navigation.
 */
import {
  byteLength,
  cookieBelongsToDomain,
  cookieMatchesHost,
  domainMatches,
  normalizeCookieDomain,
  normalizeDomain,
  parseWebUrl,
  urlHost,
} from './util.mjs'

const MAX_NAME = 256
const MAX_VALUE = 16384
const MAX_PATH = 1024
const MAX_COOKIE_BYTES = 20 * 1024

function hasControlChars(value) {
  return /[\u0000-\u001f\u007f]/.test(value)
}

function normalizeSameSite(value) {
  const text = String(value ?? '').toLowerCase()
  if (text === 'strict') return 'strict'
  if (text === 'lax') return 'lax'
  if (text === 'none' || text === 'no_restriction') return 'none'
  return 'unspecified'
}

function cdpSameSite(value) {
  if (value === 'strict') return 'Strict'
  if (value === 'lax') return 'Lax'
  if (value === 'none') return 'None'
  return undefined
}

function zeroizeCookie(cookie) {
  try {
    if (typeof cookie.value === 'string' && cookie.value.length > 0) {
      cookie.value = '0'.repeat(cookie.value.length)
    }
    cookie.value = ''
  } catch {
    // Best effort only; JavaScript strings are immutable.
  }
}

export class CookieVault {
  constructor({ ttlMs, maxCookiesPerDomain, maxBytesPerDomain, log = console }) {
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 7_200_000)
    this.maxCookiesPerDomain = Math.max(1, Number(maxCookiesPerDomain) || 3000)
    this.maxBytesPerDomain = Math.max(1024, Number(maxBytesPerDomain) || 2 * 1024 * 1024)
    this.log = log
    this.buckets = new Map()
  }

  /**
   * Accept cookies for one requested whitelist domain.
   * @param {string} requestedDomain
   * @param {unknown[]} rawCookies
   * @returns {{accepted:number,dropped:number,domain:string|null}}
   */
  put(requestedDomain, rawCookies) {
    const domain = normalizeDomain(requestedDomain)
    if (domain === null) return { accepted: 0, dropped: 0, domain: null }
    const now = Date.now()
    const accepted = []
    let dropped = 0
    let bytes = 0
    const seen = new Set()
    const input = Array.isArray(rawCookies) ? rawCookies : []
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') {
        dropped += 1
        continue
      }
      const name = typeof raw.name === 'string' ? raw.name : ''
      const value = typeof raw.value === 'string' ? raw.value : ''
      if (name === '' || name.length > MAX_NAME || value.length > MAX_VALUE) {
        dropped += 1
        continue
      }
      if (hasControlChars(name) || hasControlChars(value)) {
        dropped += 1
        continue
      }
      const cookieDomain = normalizeCookieDomain(raw.domain)
      if (cookieDomain === null || !cookieBelongsToDomain(cookieDomain, domain)) {
        dropped += 1
        continue
      }
      const cookiePath = typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path.slice(0, MAX_PATH) : '/'
      const expirationSeconds = Number(raw.expirationDate)
      const hasExpiry = Number.isFinite(expirationSeconds) && expirationSeconds > 0
      if (hasExpiry && expirationSeconds * 1000 <= now + 60_000) {
        dropped += 1
        continue
      }
      const hostOnly = raw.hostOnly === true
      const sameSite = normalizeSameSite(raw.sameSite)
      const key = `${cookieDomain}\u0000${cookiePath}\u0000${name}`
      if (seen.has(key)) continue
      const size = byteLength(name) + byteLength(value) + byteLength(cookieDomain) + byteLength(cookiePath)
      if (size > MAX_COOKIE_BYTES) {
        dropped += 1
        continue
      }
      if (accepted.length >= this.maxCookiesPerDomain || bytes + size > this.maxBytesPerDomain) {
        dropped += input.length - accepted.length
        break
      }
      seen.add(key)
      bytes += size
      const vaultExpiry = hasExpiry
        ? Math.min(now + this.ttlMs, expirationSeconds * 1000)
        : now + this.ttlMs
      accepted.push({
        name,
        value,
        domain: cookieDomain,
        path: cookiePath,
        secure: raw.secure === true,
        httpOnly: raw.httpOnly === true,
        sameSite,
        hostOnly,
        expirationDate: hasExpiry ? expirationSeconds : 0,
        expiresAt: vaultExpiry,
        bytes: size,
      })
    }

    const previous = this.buckets.get(domain)
    if (previous) for (const cookie of previous.cookies) zeroizeCookie(cookie)
    this.buckets.set(domain, {
      domain,
      cookies: accepted,
      receivedAt: now,
      expiresAt: now + this.ttlMs,
      bytes,
    })
    if (accepted.length > 0) {
      this.log.info?.(`[cookie-whitelist] vault accepted ${accepted.length} cookie(s) for ${domain}`)
    }
    return { accepted: accepted.length, dropped, domain }
  }

  /**
   * Cookies to inject for a URL, or [] when the host is not whitelisted.
   * @param {string} url
   * @param {string[]} whitelist
   */
  getForUrl(url, whitelist) {
    const host = urlHost(url)
    const parsed = parseWebUrl(url)
    if (host === null || parsed === null) return []
    if (!Array.isArray(whitelist) || !whitelist.some((domain) => domainMatches(host, domain))) return []
    const now = Date.now()
    const secureContext = parsed.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1'
    const out = []
    const seen = new Set()
    for (const bucket of this.buckets.values()) {
      if (!domainMatches(host, bucket.domain)) continue
      for (const cookie of bucket.cookies) {
        if (cookie.expiresAt <= now) continue
        if (cookie.secure && !secureContext) continue
        if (!cookieMatchesHost(cookie.domain, host)) continue
        const key = `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
        if (seen.has(key)) continue
        seen.add(key)
        const networkCookie = {
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cdpSameSite(cookie.sameSite),
          expires: cookie.expirationDate > 0 ? cookie.expirationDate : undefined,
        }
        if (cookie.hostOnly) {
          networkCookie.url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`
        } else {
          networkCookie.domain = cookie.domain
        }
        out.push(networkCookie)
      }
    }
    return out
  }

  /** Counts and ages only; never names or values. */
  stats() {
    const now = Date.now()
    const rows = []
    for (const bucket of this.buckets.values()) {
      let live = 0
      for (const cookie of bucket.cookies) if (cookie.expiresAt > now) live += 1
      rows.push({
        domain: bucket.domain,
        cookies: live,
        bytes: bucket.bytes,
        receivedAt: bucket.receivedAt,
        expiresAt: bucket.expiresAt,
      })
    }
    rows.sort((a, b) => a.domain.localeCompare(b.domain))
    return rows
  }

  totalCookies() {
    const now = Date.now()
    let total = 0
    for (const bucket of this.buckets.values()) {
      for (const cookie of bucket.cookies) if (cookie.expiresAt > now) total += 1
    }
    return total
  }

  removeDomain(input) {
    const domain = normalizeDomain(input)
    if (domain === null) return false
    const bucket = this.buckets.get(domain)
    if (!bucket) return false
    for (const cookie of bucket.cookies) zeroizeCookie(cookie)
    this.buckets.delete(domain)
    return true
  }
  prune() {
    const now = Date.now()
    for (const [domain, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) {
        for (const cookie of bucket.cookies) zeroizeCookie(cookie)
        this.buckets.delete(domain)
        continue
      }
      bucket.cookies = bucket.cookies.filter((cookie) => {
        if (cookie.expiresAt <= now) {
          zeroizeCookie(cookie)
          return false
        }
        return true
      })
    }
  }

  clear() {
    for (const bucket of this.buckets.values()) {
      for (const cookie of bucket.cookies) zeroizeCookie(cookie)
    }
    this.buckets.clear()
  }

  dispose() {
    this.clear()
  }
}



