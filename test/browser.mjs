import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverChromiumBrowsers } from '../lib/cdp.mjs'
import { ReadOnlyBrowser } from '../lib/browser.mjs'
import { BridgeStore } from '../lib/store.mjs'
import { CookieVault } from '../lib/vault.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const silent = { info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pageHtml(title, body, request) {
  const cookie = String(request.headers.cookie || '')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${body}
<div id="cookie">${cookie.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
<a href="/page2">Page two</a>
<form method="post" action="/submit"><button type="submit">Send</button></form>
<button type="button" onclick="fetch('/api',{method:'POST',body:'x'}).then(r=>r.text()).then(t=>{document.getElementById('js-result').textContent=t}).catch(()=>{document.getElementById('js-result').textContent='blocked'})">Post</button>
<div id="js-result"></div>
</body></html>`
}

async function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('posted')
      return
    }
    if (req.url === '/submit' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('submitted')
      return
    }
    const isPage2 = req.url === '/page2'
    const title = isPage2 ? 'Page Two' : 'Cookie Test'
    const body = isPage2 ? '<p>second page body</p>' : '<p>first page body</p>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(pageHtml(title, body, req))
  })
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
  const port = server.address().port
  return { server, port, close: () => new Promise((resolve) => server.close(resolve)) }
}

const browsers = await discoverChromiumBrowsers()
if (browsers.length === 0) {
  console.log('browser: skipped (no Chrome/Edge executable)')
  process.exit(0)
}

const dir = path.join(ROOT, `.tmp-browser-${process.pid}-${Date.now()}`)
await fs.mkdir(dir, { recursive: true })
const config = { browser: { idleTimeoutMin: 1, readTimeoutMs: 30000 }, dataDir: dir }
const store = new BridgeStore({ dataDir: dir, config, log: silent })
await store.load()
store.addWhitelist('127.0.0.1', 'test')
const vault = new CookieVault({ ttlMs: 60_000, log: silent })
vault.put('127.0.0.1', [
  {
    name: 'sid',
    value: 'test-value',
    domain: '127.0.0.1',
    path: '/',
    secure: false,
    httpOnly: true,
    sameSite: 'lax',
    hostOnly: true,
  },
])

const { port, close } = await startServer()
const browser = new ReadOnlyBrowser({ dataDir: dir, config, store, vault, log: silent })
try {
  const nav = await browser.navigate(`http://127.0.0.1:${port}/`)
  assert.equal(nav.authenticated, true)
  assert.ok(nav.injectedCookies >= 1, `expected injected cookies, got ${nav.injectedCookies}`)
  assert.equal(nav.title, 'Cookie Test')
  const read = await browser.read({ maxChars: 60000 })
  assert.equal(read.authenticated, true)
  assert.ok(read.text.includes('first page body'))
  assert.ok(read.text.includes('sid=test-value'), 'server should receive the injected cookie')

  const snapshot = await browser.snapshot()
  const link = snapshot.elements.find((item) => item.text.includes('Page two'))
  assert.ok(link, 'snapshot should contain the Page two link')
  const clicked = await browser.click(link.ref)
  assert.equal(clicked.ok, true)
  assert.ok(clicked.url.endsWith('/page2'), `expected page2, got ${clicked.url}`)
  const page2 = await browser.read({})
  assert.ok(page2.text.includes('second page body'))

  await browser.navigate(`http://127.0.0.1:${port}/`)
  const snapshot2 = await browser.snapshot()
  const submit = snapshot2.elements.find((item) => item.text === 'Send')
  assert.ok(submit, 'snapshot should contain the submit button')
  const blocked = await browser.click(submit.ref)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error, 'form-submit-blocked')

  await browser.navigate(`http://127.0.0.1:${port}/`)
  const before = browser.status.blockedRequests
  const snapshot3 = await browser.snapshot()
  const poster = snapshot3.elements.find((item) => item.text === 'Post')
  assert.ok(poster, 'snapshot should contain the POST button')
  await browser.click(poster.ref)
  await sleep(700)
  assert.ok(browser.status.blockedRequests > before, 'fetch POST should be intercepted')

  const shot = await browser.screenshot()
  assert.ok(shot.base64.length > 100)
  assert.equal(shot.title, 'Cookie Test')

  const anon = await browser.navigate(`http://127.0.0.2:${port}/`)
  assert.equal(anon.authenticated, false)
  const anonRead = await browser.read({})
  assert.equal(anonRead.authenticated, false)
  assert.equal(anonRead.text.includes('sid=test-value'), false, 'anonymous page must not receive the cookie')

  await browser.close()
  const leftovers = (await fs.readdir(dir)).filter((name) => name.startsWith('cw-browser-'))
  assert.deepEqual(leftovers, [])
  console.log('browser: ok')
} finally {
  await browser.close().catch(() => {})
  vault.dispose()
  await store.dispose().catch(() => {})
  await close()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
