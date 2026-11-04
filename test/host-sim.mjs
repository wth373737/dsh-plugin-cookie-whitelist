import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const dir = path.join(ROOT, `.tmp-host-${process.pid}-${Date.now()}`)
await fs.mkdir(dir, { recursive: true })
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = dir

const tools = new Map()
const routes = []
const sections = []
const cleanups = []

const ctx = {
  get(name) {
    if (name === 'systemPrompt') {
      return {
        section(section) {
          sections.push(section)
          return () => {}
        },
      }
    }
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {}
        },
        getOrigin() {
          return 'http://127.0.0.1:61135'
        },
      }
    }
    return undefined
  },
  tools: {
    register(definition) {
      assert.equal(tools.has(definition.name), false, `duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(fn) {
    const cleanup = fn()
    cleanups.push(cleanup)
    return cleanup
  },
}

try {
  apply(ctx, {
    dataDir: dir,
    server: { port: 0 },
    security: { requestTtlMinutes: 10, vaultTtlMinutes: 120 },
    browser: { idleTimeoutMin: 0 },
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && (tools.size < 4 || routes.length === 0)) await sleep(50)
  assert.deepEqual([...tools.keys()].sort(), ['cookie_authorize', 'cookie_browse', 'cookie_sync', 'cookie_whitelist_status'])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/cookie-whitelist/api')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'cookie-whitelist')
  assert.match(sections[0].text, /cookie_authorize/)
  console.log('host-sim: ok')
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup()
    } catch {
      // ignore
    }
  }
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await sleep(100)
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
