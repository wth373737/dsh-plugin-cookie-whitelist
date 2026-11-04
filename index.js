/**
 * dsh-plugin-cookie-whitelist — Host entry.
 *
 * A browser extension reads cookies inside the browser, filters them to the
 * domains this Host has approved, and posts them to a token-gated 127.0.0.1
 * receiver. The agent then drives a disposable read-only Chromium whose
 * cookie jar is rebuilt per navigation from an in-memory vault.
 */
import { CookieWhitelistService } from './lib/service.mjs'
import { mergeDeep } from './lib/util.mjs'

export const name = 'cookie-whitelist'
export const inject = ['tools']
export const version = '1.1.0'

const DEFAULTS = {
  dataDir: '',
  server: {
    port: 47821,
    maxDomainsPerTask: 40,
  },
  security: {
    requestTtlMinutes: 10,
    vaultTtlMinutes: 120,
    maxCookiesPerDomain: 3000,
    maxCookieBytesPerDomain: 2 * 1024 * 1024,
  },
  browser: {
    executable: '',
    idleTimeoutMin: 15,
    readTimeoutMs: 30000,
  },
  syncWaitMs: 8000,
  files: {
    maxBytes: 8 * 1024 * 1024,
    maxPages: 10,
    maxChars: 200000,
  },
}

export function apply(ctx, config = {}) {
  const resolved = mergeDeep(DEFAULTS, config)
  const service = new CookieWhitelistService(ctx, resolved)

  ctx.effect(() => {
    void service.start().catch(() => {})
    return () => {
      void service.dispose()
    }
  })

  for (const tool of service.tools) {
    ctx.effect(() => ctx.tools.register(tool))
  }
}



