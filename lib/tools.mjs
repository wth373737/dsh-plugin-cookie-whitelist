/**
 * Agent-facing tools.
 *
 * The tool surface is deliberately small and read-only:
 *   - status: see what is authorized, never a cookie value;
 *   - authorize: ask the user to add one domain (user approval is the grant);
 *   - sync: ask the installed extension to re-read approved domains;
 *   - browse: navigate/read/snapshot/click/scroll/screenshot in a disposable
 *     browser that blocks every non-GET method.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { delay, normalizeDomain, randomId, truncateText } from './util.mjs'

function textRender(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function jsonOutput(render = textRender) {
  return {
    schema: { type: 'object', additionalProperties: true },
    render(_args, value) {
      return render(value)
    },
  }
}

function normalizeReason(value) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : ''
}

export function createTools(service) {
  const { ctx, store, vault, browser, config } = service

  const status = {
    name: 'cookie_whitelist_status',
    description:
      'Show the cookie whitelist, pending domain-authorization requests, whether the browser extension is connected, and how many cookies are held in memory for each approved domain. Cookie values are never returned.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: jsonOutput(),
    async execute() {
      await service.ready
      return service.statusForAgent()
    },
  }

  const authorize = {
    name: 'cookie_authorize',
    description:
      'Request permission to use the user\u2019s cookies for one domain. This ALWAYS asks the user; approval adds the domain to the whitelist. If no interactive approval is available, the request stays pending in Settings > Cookie Whitelist. Never ask the user to paste cookie values.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Registrable domain or hostname, for example example.com or mail.example.com.' },
        reason: { type: 'string', description: 'Short reason shown to the user, for example "read the user\u2019s course list".' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args, exec) {
      await service.ready
      const domain = normalizeDomain(args?.domain)
      if (domain === null) throw new Error('invalid domain; provide a hostname such as example.com')
      if (store.isWhitelisted(domain)) {
        return { ok: true, approved: true, already: true, domain, message: `${domain} is already whitelisted.` }
      }
      const created = store.createRequest({
        domain,
        reason: normalizeReason(args?.reason),
        sessionId: exec?.agent?.id ?? '',
        source: 'agent',
      })
      if (created.already) {
        return { ok: true, approved: true, already: true, domain, message: `${domain} is already whitelisted.` }
      }
      const request = created.request
      let outcome = 'unavailable'
      const approval = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
      if (approval && exec?.agent) {
        const controller = new AbortController()
        const parentSignal = exec.signal
        const onAbort = () => {
          try {
            controller.abort(parentSignal?.reason)
          } catch {
            controller.abort()
          }
        }
        if (parentSignal) {
          if (parentSignal.aborted) onAbort()
          else parentSignal.addEventListener('abort', onAbort, { once: true })
        }
        const ttlMs = Math.max(30_000, Math.min(10 * 60_000, Number(config.security?.requestTtlMinutes ?? 10) * 60_000))
        const timer = setTimeout(() => controller.abort(new Error('authorization approval timed out')), ttlMs)
        if (typeof timer.unref === 'function') timer.unref()
        try {
          outcome = await approval.request({
            agent: exec.agent,
            toolName: 'cookie_authorize',
            callId: exec.callId,
            reason: `domain authorization: ${domain}`,
            displayReason: {
              en: `Allow the agent to use your cookies for ${domain}? Approval adds this domain to the cookie whitelist.`,
              zh: `允许智能体使用你在 ${domain} 的登录态吗？批准后该域名会加入 Cookie 白名单。`,
            },
            signal: controller.signal,
          })
        } catch (error) {
          service.log.warn?.(`[cookie-whitelist] inline approval unavailable: ${error?.message ?? error}`)
          outcome = 'unavailable'
        } finally {
          clearTimeout(timer)
          if (parentSignal) parentSignal.removeEventListener('abort', onAbort)
        }
      }
      if (outcome === 'allowed-once') {
        try {
          store.decideRequest(request.id, true, 'chat-approval')
        } catch (error) {
          // The user approved a card whose request expired while it was open.
          service.log.warn?.(`[cookie-whitelist] request was ${error?.message ?? 'expired'}; granting the approval anyway`)
          store.addWhitelist(domain, 'chat-approval')
        }
        store.enqueueSync([domain])
        const connected = service.extensionConnected()
        return {
          ok: true,
          approved: true,
          domain,
          requestId: request.id,
          extensionConnected: connected,
          message: connected
            ? `${domain} was approved. The extension has been asked to read its cookies; call cookie_sync to confirm.`
            : `${domain} was approved. The extension is not connected; install it from Settings > Cookie Whitelist, or use the temporary login window there.`,
        }
      }
      if (outcome === 'rejected') {
        store.decideRequest(request.id, false, 'chat-approval')
        return { ok: true, approved: false, rejected: true, domain, requestId: request.id, message: `The user rejected ${domain}. Visit it anonymously or ask again later.` }
      }
      return {
        ok: true,
        approved: false,
        pending: true,
        domain,
        requestId: request.id,
        expiresAt: request.expiresAt,
        extensionConnected: service.extensionConnected(),
        message: `Authorization for ${domain} is pending. The user can approve it in Settings > Cookie Whitelist; do not retry in a loop.`,
      }
    },
  }

  const sync = {
    name: 'cookie_sync',
    description:
      'Ask the installed Chrome/Edge/Firefox extension to re-read cookies for already-whitelisted domains. Returns counts only. Non-whitelisted domains are ignored; use cookie_authorize first.',
    parameters: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of whitelisted domains. Omit to refresh all whitelisted domains.',
        },
      },
      additionalProperties: false,
    },
    output: jsonOutput(),
    async execute(args) {
      await service.ready
      const requested = Array.isArray(args?.domains) ? args.domains : null
      const ignored = []
      let queued = 0
      if (requested === null) {
        queued = store.enqueueAll()
      } else {
        const allowed = []
        for (const input of requested) {
          const domain = normalizeDomain(input)
          if (domain === null) {
            ignored.push(String(input))
            continue
          }
          if (!store.isWhitelisted(domain)) {
            ignored.push(domain)
            continue
          }
          allowed.push(domain)
        }
        queued = store.enqueueSync(allowed)
      }
      const before = store.getStats().lastCookieSync
      const connected = service.extensionConnected()
      if (!connected) {
        return {
          ok: true,
          queued,
          ignored,
          extensionConnected: false,
          vault: vault.stats(),
          message: 'No extension has checked in recently. Install the extension from Settings > Cookie Whitelist, or use the temporary login window there.',
        }
      }
      const deadline = Date.now() + Math.max(3000, Number(config.syncWaitMs ?? 8000))
      while (Date.now() < deadline) {
        if (store.getStats().lastCookieSync > before) break
        await delay(250)
      }
      vault.prune()
      const completed = store.getStats().lastCookieSync > before
      return {
        ok: true,
        queued,
        ignored,
        extensionConnected: true,
        completed,
        vault: vault.stats(),
        message: completed ? 'The extension delivered fresh cookies.' : 'The extension has not replied yet; it may be asleep. Try again or check Settings.',
      }
    },
  }

  const browse = {
    name: 'cookie_browse',
    description:
      'Drive a disposable, read-only browser. Approved domains receive the user\u2019s cookies; every other site is anonymous. Only GET/HEAD requests are allowed, form submission and popups are blocked, and there is no fill or write action. Actions: open (navigate), read (text+links), snapshot (interactive elements with refs), click (follow a link / expand UI), scroll, screenshot, status, close.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'read', 'snapshot', 'click', 'scroll', 'screenshot', 'status', 'close'],
          description: 'Read-only browser action.',
        },
        url: { type: 'string', description: 'Required for open: an http(s) URL.' },
        ref: { type: 'string', description: 'Required for click: a ref from cookie_browse snapshot.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction; default down.' },
        amount: { type: 'integer', minimum: 100, maximum: 10000, description: 'Scroll distance in CSS pixels; default 700.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Read limit; default 60000.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: jsonOutput((value) => {
      const blocks = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      if (value && value.attachment && typeof value.attachment === 'object' && value.attachment.attachmentId) {
        blocks.push({ type: 'image', attachment: value.attachment })
      }
      return blocks
    }),
    async execute(args, exec) {
      await service.ready
      const action = args?.action
      if (action === 'open') {
        if (typeof args?.url !== 'string' || args.url === '') throw new Error('open requires a url')
        const result = await browser.navigate(args.url)
        const preview = await browser.read({ maxChars: 4000 }).catch(() => null)
        return {
          ok: true,
          action,
          ...result,
          preview: preview ? { text: truncateText(preview.text, 4000), links: preview.links.slice(0, 30) } : null,
        }
      }
      if (action === 'read') {
        const result = await browser.read({ maxChars: args?.maxChars })
        return { ok: true, action, ...result }
      }
      if (action === 'snapshot') {
        const result = await browser.snapshot()
        return { ok: true, action, ...result }
      }
      if (action === 'click') {
        if (typeof args?.ref !== 'string' || args.ref === '') throw new Error('click requires a ref from cookie_browse snapshot')
        const result = await browser.click(args.ref)
        return { ok: result.ok === true, action, ...result }
      }
      if (action === 'scroll') {
        const direction = args?.direction === 'up' ? 'up' : 'down'
        const amount = Math.max(100, Math.min(10000, Number(args?.amount) || 700))
        const result = await browser.scroll(direction === 'up' ? -amount : amount)
        return { ok: true, action, direction, ...result }
      }
      if (action === 'screenshot') {
        const shot = await browser.screenshot()
        const buffer = Buffer.from(shot.base64, 'base64')
        let attachment = null
        const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
        if (attachments) {
          try {
            attachment = await attachments.saveImage({ data: buffer, mediaType: 'image/png', name: 'cookie-whitelist.png' })
          } catch (error) {
            service.log.warn?.(`[cookie-whitelist] screenshot attachment failed: ${error?.message ?? error}`)
          }
        }
        let filePath = ''
        if (!attachment) {
          const dir = path.join(service.dataDir, 'shots')
          await fs.mkdir(dir, { recursive: true })
          filePath = path.join(dir, `${randomId('shot_')}.png`)
          await fs.writeFile(filePath, buffer)
        }
        const result = {
          ok: true,
          action,
          url: shot.url,
          title: shot.title,
          bytes: buffer.length,
        }
        if (attachment) result.attachment = attachment
        if (filePath) result.path = filePath
        if (!attachment) result.note = 'Attachment service unavailable; the PNG was written to the path above.'
        return result
      }
      if (action === 'status') {
        return { ok: true, action, ...browser.status }
      }
      if (action === 'close') {
        await browser.close()
        return { ok: true, action, closed: true }
      }
      throw new Error(`unknown action: ${String(action)}`)
    },
  }

  return [status, authorize, sync, browse]
}


