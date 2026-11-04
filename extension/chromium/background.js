/**
 * DSH Cookie Whitelist Bridge — browser side.
 *
 * The extension is the only place where cookie values are read. It asks the
 * local receiver for a task (approved domains only), reads cookies for those
 * domains with the browser cookies API, filters a second time before leaving
 * the browser, and POSTs the result to 127.0.0.1. It never talks to any other
 * origin and never logs cookie values.
 */
const VERSION = '1.0.0'
const DEFAULT_RECEIVER = 'http://127.0.0.1:47821'
const TOKEN_HEADER = 'x-cookie-whitelist-token'
const isFirefox = typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime?.id
const api = isFirefox ? globalThis.browser : globalThis.chrome

const DEFAULTS = {
  receiverUrl: DEFAULT_RECEIVER,
  token: '',
  label: isFirefox ? 'Firefox' : 'Chrome/Edge',
}

let polling = false
let fastTimer = null
let lastStatusAt = 0

function normalizeReceiver(value) {
  const raw = String(value ?? '').trim()
  if (raw === '') throw new Error('receiver URL is empty')
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('receiver URL is invalid')
  }
  if (url.protocol !== 'http:') throw new Error('receiver must use http://127.0.0.1')
  if (url.hostname !== '127.0.0.1') throw new Error('receiver must be 127.0.0.1 (not localhost or a remote host)')
  if (url.port === '') throw new Error('receiver URL must include the port, for example http://127.0.0.1:47821')
  return url.origin
}

function storageGet(keys) {
  if (isFirefox) return api.storage.local.get(keys)
  return new Promise((resolve, reject) => {
    try {
      api.storage.local.get(keys, (value) => {
        if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message))
        else resolve(value || {})
      })
    } catch (error) {
      reject(error)
    }
  })
}

function storageSet(values) {
  if (isFirefox) return api.storage.local.set(values)
  return new Promise((resolve, reject) => {
    try {
      api.storage.local.set(values, () => {
        if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message))
        else resolve()
      })
    } catch (error) {
      reject(error)
    }
  })
}

function cookiesGetAll(details) {
  if (isFirefox) return api.cookies.getAll(details)
  return new Promise((resolve, reject) => {
    try {
      api.cookies.getAll(details, (value) => {
        if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message))
        else resolve(value || [])
      })
    } catch (error) {
      reject(error)
    }
  })
}

async function getConfig() {
  const stored = await storageGet(Object.keys(DEFAULTS))
  return {
    receiverUrl: typeof stored.receiverUrl === 'string' && stored.receiverUrl !== '' ? normalizeReceiver(stored.receiverUrl) : DEFAULT_RECEIVER,
    token: typeof stored.token === 'string' ? stored.token.trim() : '',
    label: typeof stored.label === 'string' && stored.label !== '' ? stored.label.slice(0, 80) : DEFAULTS.label,
  }
}

async function fetchJson(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: controller.signal })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text === '' ? null : JSON.parse(text)
    } catch {
      parsed = null
    }
    if (!response.ok) {
      const message = parsed && parsed.error && parsed.error.message ? parsed.error.message : `HTTP ${response.status}`
      throw new Error(message)
    }
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

function requestHeaders(token) {
  return {
    'content-type': 'application/json',
    [TOKEN_HEADER]: token,
  }
}

function isCookieForDomain(cookieDomain, requestedDomain) {
  const cd = String(cookieDomain ?? '').replace(/^\.+/, '').toLowerCase()
  const rd = String(requestedDomain ?? '').toLowerCase()
  if (cd === '' || rd === '') return false
  return rd === cd || rd.endsWith(`.${cd}`)
}

async function readCookiesForDomain(domain) {
  const seen = new Map()
  for (const url of [`https://${domain}/`, `http://${domain}/`]) {
    let list = []
    try {
      list = await cookiesGetAll({ url })
    } catch {
      continue
    }
    for (const cookie of list) {
      if (!cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') continue
      if (!isCookieForDomain(cookie.domain, domain)) continue
      const key = `${cookie.storeId || ''}\u0000${cookie.domain || ''}\u0000${cookie.path || ''}\u0000${cookie.name}`
      if (seen.has(key)) continue
      seen.set(key, {
        name: cookie.name.slice(0, 256),
        value: cookie.value.slice(0, 16384),
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true,
        sameSite: cookie.sameSite || 'unspecified',
        expirationDate: cookie.expirationDate,
        hostOnly: cookie.hostOnly === true,
        session: cookie.session === true,
      })
    }
  }
  return [...seen.values()]
}

async function postStatus(config, error) {
  const now = Date.now()
  if (!error && now - lastStatusAt < 20_000) return
  lastStatusAt = now
  try {
    await fetchJson(
      `${config.receiverUrl}/v1/status`,
      {
        method: 'POST',
        headers: requestHeaders(config.token),
        body: JSON.stringify({ browser: config.label, version: VERSION, error: error || '' }),
      },
      6000,
    )
  } catch {
    // The receiver may be stopped; the next poll retries.
  }
}

async function poll(options = {}) {
  if (polling) return { ok: false, reason: 'busy' }
  polling = true
  try {
    const config = await getConfig()
    if (config.token === '') {
      return { ok: false, reason: 'not-configured' }
    }
    await fetchJson(`${config.receiverUrl}/health`, {}, 4000)
    const tasksResponse = await fetchJson(
      `${config.receiverUrl}/v1/tasks`,
      { headers: { [TOKEN_HEADER]: config.token } },
      8000,
    )
    const tasks = Array.isArray(tasksResponse?.tasks) ? tasksResponse.tasks : []
    let delivered = 0
    for (const task of tasks) {
      if (!task || typeof task.id !== 'string' || !Array.isArray(task.domains)) continue
      const domains = {}
      for (const domain of task.domains) {
        if (typeof domain !== 'string') continue
        domains[domain] = await readCookiesForDomain(domain)
      }
      const response = await fetchJson(
        `${config.receiverUrl}/v1/cookies`,
        {
          method: 'POST',
          headers: requestHeaders(config.token),
          body: JSON.stringify({ taskId: task.id, browser: config.label, version: VERSION, domains }),
        },
        20_000,
      )
      delivered += Number(response?.accepted) || 0
    }
    await postStatus(config)
    await storageSet({ lastPollAt: Date.now(), lastError: '', lastDelivered: delivered })
    return { ok: true, tasks: tasks.length, delivered }
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 300)
    try {
      const config = await getConfig()
      await postStatus(config, message)
    } catch {
      // ignore
    }
    await storageSet({ lastPollAt: Date.now(), lastError: message }).catch(() => {})
    return { ok: false, error: message }
  } finally {
    polling = false
  }
}

function scheduleFastPoll() {
  if (fastTimer !== null) return
  fastTimer = setInterval(() => {
    void poll()
  }, 2000)
}

function ensureAlarm() {
  try {
    api.alarms.create('cookie-whitelist-poll', { periodInMinutes: 0.5 })
  } catch {
    // Older Firefox may not have alarms; the options page can sync manually.
  }
}

api.runtime.onInstalled.addListener(() => {
  ensureAlarm()
  scheduleFastPoll()
  void poll()
})

api.runtime.onStartup.addListener(() => {
  ensureAlarm()
  scheduleFastPoll()
  void poll()
})

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cookie-whitelist-poll') void poll()
})

async function handleMessage(message) {
  if (!message || typeof message !== 'object') return undefined
  if (message.type === 'cookie-whitelist.test') {
    try {
      const config = await getConfig()
      if (config.token === '') throw new Error('pairing token is empty; save the token first')
      const health = await fetchJson(`${config.receiverUrl}/health`, {}, 4000)
      const ping = await fetchJson(
        `${config.receiverUrl}/v1/ping`,
        { method: 'POST', headers: requestHeaders(config.token), body: JSON.stringify({}) },
        4000,
      )
      return { ok: true, health, ping }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  if (message.type === 'cookie-whitelist.sync') {
    return poll({ manual: true })
  }
  return undefined
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const known = message && (message.type === 'cookie-whitelist.test' || message.type === 'cookie-whitelist.sync')
  if (!known) return false
  if (isFirefox) return handleMessage(message)
  void handleMessage(message).then((response) => sendResponse(response))
  return true
})

ensureAlarm()
scheduleFastPoll()
void poll()

