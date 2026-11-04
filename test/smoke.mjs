import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cookieMatchesHost,
  domainMatches,
  normalizeDomain,
  parseWebUrl,
} from '../lib/util.mjs'
import { BridgeStore } from '../lib/store.mjs'
import { CookieVault } from '../lib/vault.mjs'
import { ExtensionReceiver } from '../lib/receiver.mjs'
import { createTools } from '../lib/tools.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const silent = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeTemp() {
  const dir = path.join(ROOT, `.tmp-test-${process.pid}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function baseConfig(port = 0) {
  return {
    server: { port, maxDomainsPerTask: 40 },
    security: {
      requestTtlMinutes: 10,
      vaultTtlMinutes: 120,
      maxCookiesPerDomain: 3000,
      maxCookieBytesPerDomain: 2 * 1024 * 1024,
    },
    browser: { idleTimeoutMin: 15, readTimeoutMs: 30000 },
    syncWaitMs: 2000,
  }
}

async function testUtil() {
  assert.equal(normalizeDomain('Example.COM'), 'example.com')
  assert.equal(normalizeDomain('https://Sub.Example.com/path?q=1'), 'sub.example.com')
  assert.equal(normalizeDomain('.example.com'), 'example.com')
  assert.equal(normalizeDomain('example.com:8443'), 'example.com')
  assert.equal(normalizeDomain('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeDomain('localhost'), 'localhost')
  assert.equal(normalizeDomain('not a domain'), null)
  assert.equal(normalizeDomain('https://user:pass@example.com/'), null)
  assert.equal(normalizeDomain('*.example.com'), null)
  assert.equal(normalizeDomain('example'), null)
  assert.equal(domainMatches('mail.example.com', 'example.com'), true)
  assert.equal(domainMatches('notexample.com', 'example.com'), false)
  assert.equal(domainMatches('example.com.evil.com', 'example.com'), false)
  assert.equal(cookieMatchesHost('.example.com', 'mail.example.com'), true)
  assert.equal(cookieMatchesHost('mail.example.com', 'example.com'), false)
  assert.equal(parseWebUrl('javascript:alert(1)'), null)
  assert.equal(parseWebUrl('https://example.com/').hostname, 'example.com')
}

async function testStoreAndVault() {
  const dir = await makeTemp()
  const config = baseConfig()
  const store = new BridgeStore({ dataDir: dir, config, log: silent })
  await store.load()
  assert.match(store.tokenValue, /^[A-Za-z0-9_-]{20,}$/)
  const token = store.tokenValue

  assert.equal(store.isWhitelisted('example.com'), false)
  store.addWhitelist('example.com', 'test')
  assert.equal(store.isWhitelisted('sub.example.com'), true)
  assert.equal(store.isWhitelisted('notexample.com'), false)

  const created = store.createRequest({ domain: 'other.example.net', reason: 'test', source: 'test' })
  assert.equal(created.request.status, 'pending')
  assert.equal(store.pendingCount(), 1)
  const decided = store.decideRequest(created.request.id, true, 'test')
  assert.equal(decided.status, 'approved')
  assert.equal(store.isWhitelisted('other.example.net'), true)
  assert.equal(store.pendingCount(), 0)

  const vault = new CookieVault({ ttlMs: 60_000, maxCookiesPerDomain: 10, log: silent })
  const good = vault.put('example.com', [
    {
      name: 'sid',
      value: 'super-secret-value',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      hostOnly: false,
    },
    {
      name: 'scoped',
      value: 'host-only-secret',
      domain: 'example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      hostOnly: true,
    },
  ])
  assert.equal(good.accepted, 2)
  assert.equal(vault.totalCookies(), 2)
  const statsText = JSON.stringify(vault.stats())
  assert.equal(statsText.includes('super-secret-value'), false)
  assert.equal(statsText.includes('host-only-secret'), false)
  assert.equal(statsText.includes('sid'), false)

  const forUrl = vault.getForUrl('https://mail.example.com/inbox', ['example.com'])
  assert.equal(forUrl.length, 2)
  assert.equal(vault.getForUrl('https://example.com/', []).length, 0)
  assert.equal(vault.getForUrl('https://evil.com/', ['example.com']).length, 0)

  const rejected = vault.put('example.com', [
    { name: 'bad', value: 'x', domain: 'evil.com', path: '/', secure: true, httpOnly: false },
    { name: 'bad2', value: 'x', domain: 'notexample.com', path: '/', secure: true, httpOnly: false },
    { name: 'too-long', value: 'x'.repeat(20000), domain: 'example.com', path: '/', secure: true, httpOnly: false },
  ])
  assert.equal(rejected.accepted, 0)
  assert.ok(rejected.dropped >= 3)

  await store.dispose()
  const reloaded = new BridgeStore({ dataDir: dir, config, log: silent })
  await reloaded.load()
  assert.equal(reloaded.tokenValue, token)
  assert.equal(reloaded.isWhitelisted('example.com'), true)
  await reloaded.dispose()
  vault.dispose()
  await fs.rm(dir, { recursive: true, force: true })
}

async function testReceiver() {
  const dir = await makeTemp()
  const config = baseConfig(0)
  const store = new BridgeStore({ dataDir: dir, config, log: silent })
  await store.load()
  store.addWhitelist('example.com', 'test')
  store.enqueueSync(['example.com'])
  const vault = new CookieVault({ ttlMs: 60_000, log: silent })
  const receiver = new ExtensionReceiver({ store, vault, config, log: silent })
  const url = await receiver.start()
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
  try {
    const health = await fetch(`${url}/health`).then((r) => r.json())
    assert.equal(health.ok, true)
    assert.equal(health.name, 'dsh-plugin-cookie-whitelist')

    const unauthorized = await fetch(`${url}/v1/tasks`)
    assert.equal(unauthorized.status, 401)

    const evil = await fetch(`${url}/v1/tasks`, {
      headers: { origin: 'http://evil.example', 'x-cookie-whitelist-token': store.tokenValue },
    })
    assert.equal(evil.status, 403)

    const headers = { origin: 'chrome-extension://abcdefghijklmnop', 'x-cookie-whitelist-token': store.tokenValue }
    const tasks = await fetch(`${url}/v1/tasks`, { headers }).then((r) => r.json())
    assert.equal(tasks.ok, true)
    assert.equal(tasks.tasks.length, 1)
    assert.deepEqual(tasks.tasks[0].domains, ['example.com'])
    const taskId = tasks.tasks[0].id

    const delivered = await fetch(`${url}/v1/cookies`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        browser: 'test',
        version: '1.0.0',
        domains: {
          'example.com': [
            { name: 'sid', value: 'secret-value', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
          ],
        },
      }),
    }).then((r) => r.json())
    assert.equal(delivered.ok, true)
    assert.equal(delivered.accepted, 1)
    assert.equal(vault.totalCookies(), 1)
    assert.equal(JSON.stringify(delivered).includes('secret-value'), false)

    const status = await fetch(`${url}/v1/status`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ browser: 'test', version: '1.0.0' }),
    }).then((r) => r.json())
    assert.equal(status.ok, true)
    await sleep(20)
    assert.equal(store.getExtension().browser, 'test')
    assert.equal(store.getExtension().lastSeen > 0, true)
  } finally {
    await receiver.stop()
    vault.dispose()
    await store.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function testTools() {
  const dir = await makeTemp()
  const config = baseConfig(0)
  const store = new BridgeStore({ dataDir: dir, config, log: silent })
  await store.load()
  const vault = new CookieVault({ ttlMs: 60_000, log: silent })
  const service = {
    ctx: { get: () => undefined },
    store,
    vault,
    config,
    dataDir: dir,
    log: silent,
    ready: Promise.resolve(),
    extensionConnected: () => false,
    statusForAgent() {
      return { ok: true, whitelist: store.listWhitelist(), vault: { domains: vault.stats(), totalCookies: vault.totalCookies() } }
    },
    browser: {
      status: { running: false },
      navigate: async () => ({ url: 'https://example.com/', title: 'Example' }),
      read: async () => ({ text: 'hello', links: [] }),
      snapshot: async () => ({ elements: [] }),
      click: async () => ({ ok: true }),
      scroll: async () => ({ ok: true }),
      screenshot: async () => ({ base64: Buffer.from('x').toString('base64'), url: '', title: '' }),
      close: async () => {},
    },
  }
  const tools = Object.fromEntries(createTools(service).map((tool) => [tool.name, tool]))
  assert.deepEqual(Object.keys(tools).sort(), ['cookie_authorize', 'cookie_browse', 'cookie_sync', 'cookie_whitelist_status'])
  assert.equal((await tools.cookie_whitelist_status.execute({}, {})).ok, true)
  const pending = await tools.cookie_authorize.execute({ domain: 'example.com', reason: 'test' }, { agent: undefined })
  assert.equal(pending.pending, true)
  assert.equal(store.pendingCount(), 1)
  await tools.cookie_sync.execute({}, {})
  const browse = await tools.cookie_browse.execute({ action: 'open', url: 'https://example.com/' }, {})
  assert.equal(browse.ok, true)
  vault.dispose()
  await store.dispose()
  await fs.rm(dir, { recursive: true, force: true })
}

await testUtil()
await testStoreAndVault()
await testReceiver()
await testTools()
console.log('smoke: ok')


