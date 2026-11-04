/**
 * Small, dependency-free helpers shared by the Host half.
 *
 * The security-sensitive helpers here are deliberately boring: normalize a
 * hostname once, compare domains by label boundary, and compare bearer tokens
 * in constant time. Cookie VALUES never pass through this module.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mergeDeep(base, override) {
  if (!isPlainObject(override)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDeep(out[key], value)
    else out[key] = value
  }
  return out
}

/**
 * Normalize a hostname or URL to a bare ASCII hostname.
 * Returns null for anything that is not a plausible http(s) host.
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string') return null
  let raw = input.trim()
  if (raw === '') return null
  if (raw.length > 2048) return null
  let url
  try {
    url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  let host = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (host.startsWith('.')) host = host.replace(/^\.+/, '')
  if (host === '' || host.length > 253) return null
  if (host === 'localhost') return host
  if (host.includes(':') || host.includes('/') || host.includes('*')) return null
  const labels = host.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null
  }
  return host
}

/** Normalize a cookie `Domain` attribute (a leading dot is legal and ignored). */
export function normalizeCookieDomain(input) {
  if (typeof input !== 'string') return null
  return normalizeDomain(input.trim().replace(/^\.+/, ''))
}

/** True when `host` is `allowed` or a subdomain of it, never a lookalike suffix. */
export function domainMatches(host, allowed) {
  const h = String(host ?? '').toLowerCase().replace(/\.+$/, '')
  const a = String(allowed ?? '').toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (h === '' || a === '') return false
  return h === a || h.endsWith(`.${a}`)
}

/** True when a cookie scoped to `cookieDomain` would be sent to `host`. */
/**
 * True when a cookie scoped to `cookieDomain` belongs to the authorized
 * domain subtree (the domain itself, a subdomain cookie, or a parent cookie
 * that applies to it). This is the COLLECTION rule; injection still uses
 * {@link cookieMatchesHost} because a subdomain cookie must not be sent to
 * the parent origin.
 */
export function cookieBelongsToDomain(cookieDomain, requestedDomain) {
  const cd = normalizeCookieDomain(cookieDomain)
  const rd = normalizeDomain(requestedDomain)
  if (cd === null || rd === null) return false
  return cd === rd || cd.endsWith(`.${rd}`) || rd.endsWith(`.${cd}`)
}
export function cookieMatchesHost(cookieDomain, host) {
  const cd = normalizeCookieDomain(cookieDomain)
  const h = normalizeDomain(host)
  if (cd === null || h === null) return false
  return cookieMatchesHostNormalized(cd, h)
}

function cookieMatchesHostNormalized(cd, h) {
  return h === cd || h.endsWith(`.${cd}`)
}

/** Parse an http(s) URL and reject credentials, non-web schemes, and empty hosts. */
export function parseWebUrl(input) {
  if (typeof input !== 'string') return null
  let url
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (!url.hostname) return null
  return url
}

export function urlHost(input) {
  const url = parseWebUrl(input)
  return url === null ? null : url.hostname.toLowerCase().replace(/\.+$/, '')
}

export function urlScheme(input) {
  const url = parseWebUrl(input)
  return url === null ? null : url.protocol.replace(':', '')
}

export function safeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8')
  const right = Buffer.from(String(b ?? ''), 'utf8')
  if (left.length === 0 || right.length === 0) return false
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function randomToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

export function randomId(prefix = '') {
  return `${prefix}${randomBytes(9).toString('hex')}`
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function readJson(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function atomicWriteJson(file, value) {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomId()}.tmp`)
  const text = JSON.stringify(value, null, 2)
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    // Windows can refuse a rename over a file held open by another process.
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM')) {
      await fs.rm(file, { force: true })
      await fs.rename(tmp, file)
      return
    }
    await fs.rm(tmp, { force: true })
    throw error
  }
}

export async function readText(file, fallback = '') {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout(promise, ms, message = 'operation timed out') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function truncateText(text, maxChars) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

export function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8')
}

export function assertInside(parent, child) {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  return c === p || c.startsWith(p + path.sep)
}

export function isoNow() {
  return new Date().toISOString()
}

