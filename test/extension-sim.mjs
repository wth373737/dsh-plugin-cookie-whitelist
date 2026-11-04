import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { BridgeStore } from '../lib/store.mjs'
import { CookieVault } from '../lib/vault.mjs'
import { ExtensionReceiver } from '../lib/receiver.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const silent = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const dir = path.join(ROOT, `.tmp-ext-${process.pid}-${Date.now()}`)
await fs.mkdir(dir, { recursive: true })
const config = { server: { port: 0, maxDomainsPerTask: 40 }, security: { requestTtlMinutes: 10, vaultTtlMinutes: 120 } }
const store = new BridgeStore({ dataDir: dir, config, log: silent })
await store.load()
store.addWhitelist('example.com', 'test')
store.enqueueSync(['example.com'])
const vault = new CookieVault({ ttlMs: 60_000, log: silent })
const receiver = new ExtensionReceiver({ store, vault, config, log: silent })
const receiverUrl = await receiver.start()

const stored = {
  receiverUrl,
  token: store.tokenValue,
  label: 'Chrome/Edge',
  lastPollAt: 0,
  lastError: '',
}
const listeners = { installed: [], startup: [], alarm: [], message: [] }
const chrome = {
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: (fn) => listeners.startup.push(fn) },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    sendMessage: () => {},
  },
  storage: {
    local: {
      get(keys, cb) {
        const out = {}
        for (const key of Array.isArray(keys) ? keys : Object.keys(stored)) {
          if (key in stored) out[key] = stored[key]
        }
        queueMicrotask(() => cb(out))
      },
      set(values, cb) {
        Object.assign(stored, values)
        queueMicrotask(() => cb())
      },
    },
  },
  cookies: {
    getAll(details, cb) {
      const url = String(details.url || '')
      const cookies = url.includes('example.com')
        ? [
            {
              name: 'sid',
              value: 'extension-secret',
              domain: '.example.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'lax',
              hostOnly: false,
              session: false,
              expirationDate: Date.now() / 1000 + 3600,
            },
          ]
        : []
      queueMicrotask(() => cb(cookies))
    },
  },
  alarms: {
    create() {},
    onAlarm: { addListener: (fn) => listeners.alarm.push(fn) },
  },
}

const source = await fs.readFile(path.join(ROOT, 'extension-src', 'background.js'), 'utf8')
const context = {
  chrome,
  browser: undefined,
  fetch,
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
  setInterval: () => 1,
  clearInterval: () => {},
  console: silent,
  Promise,
  queueMicrotask,
}
vm.createContext(context)
try {
  vm.runInContext(source, context, { filename: 'background.js' })
  const deadline = Date.now() + 6000
  while (Date.now() < deadline && vault.totalCookies() === 0) await sleep(100)
  assert.equal(vault.totalCookies(), 1, 'extension should deliver one cookie')
  assert.equal(vault.stats()[0].domain, 'example.com')
  assert.equal(JSON.stringify(vault.stats()).includes('extension-secret'), false)
  assert.equal(store.getExtension().browser, 'Chrome/Edge')
  assert.ok(store.getExtension().lastSeen > 0)
  console.log('extension-sim: ok')
} finally {
  await receiver.stop()
  vault.dispose()
  await store.dispose()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
