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
import { delay, normalizeDomain, randomId, truncateText, urlHost } from './util.mjs'
import { FileTooLargeError, readFileFromUrl } from './file-reader.mjs'

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

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

async function askDownloadApproval(service, exec, { url, sizeBytes }) {
  const approval = typeof service.ctx.get === 'function' ? service.ctx.get('approval') : undefined
  if (!approval || !exec?.agent) return { approved: false, unavailable: true }
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
  const timer = setTimeout(() => controller.abort(new Error('file download approval timed out')), 10 * 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    const host = urlHost(url) || 'the whitelisted host'
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: 'cookie_browse',
      callId: exec.callId,
      reason: `read a ${formatBytes(sizeBytes)} file from ${host}`,
      displayReason: {
        en: `Allow the agent to download and read a ${formatBytes(sizeBytes)} file from ${host}? The temporary copy is deleted after reading unless you ask to keep it.`,
        zh: `允许智能体下载并读取来自 ${host} 的 ${formatBytes(sizeBytes)} 文件吗？读取后默认删除临时文件；如需保留请告知。`,
      },
      signal: controller.signal,
    })
    return { approved: outcome === 'allowed-once', outcome }
  } catch (error) {
    service.log.warn?.(`[cookie-whitelist] file approval unavailable: ${error?.message ?? error}`)
    return { approved: false, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
    if (parentSignal) parentSignal.removeEventListener('abort', onAbort)
  }
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
      'Drive a disposable, read-only browser. Approved domains receive the user\u2019s cookies; every other site is anonymous. Only GET/HEAD requests are allowed, form submission and popups are blocked, and there is no fill or write action. Actions: open (navigate), read (text+links), snapshot (interactive elements with refs), click (follow a link / expand UI), scroll, screenshot, files (list file candidates such as Course Planner, Schedule, syllabus, notes, PDF/Office), read_file (download one file and extract text; PDF text extraction), status, close. Course Planner/Schedule files often contain test dates that are absent from the page itself; inspect them.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['open', 'read', 'snapshot', 'click', 'scroll', 'screenshot', 'files', 'read_file', 'status', 'close'],
          description: 'Read-only browser action.',
        },
        url: { type: 'string', description: 'Required for open: an http(s) URL.' },
        ref: { type: 'string', description: 'Required for click: a ref from cookie_browse snapshot.' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction; default down.' },
        amount: { type: 'integer', minimum: 100, maximum: 10000, description: 'Scroll distance in CSS pixels; default 700.' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 500000, description: 'Text limit for read/read_file; default 60000 for read, 200000 for read_file.' },
        maxPages: { type: 'integer', minimum: 1, maximum: 30, description: 'read_file PDF page limit; default 10.' },
        maxBytes: { type: 'integer', minimum: 65536, maximum: 52428800, description: 'read_file inline byte limit before asking the user; default 8 MB.' },
        keep: { type: 'boolean', description: 'read_file: keep the downloaded file in the plugin data directory; default false (read in memory and do not keep).' },
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
      if (action === 'files') {
        const result = await browser.listFiles()
        return { ok: true, action, ...result }
      }
      if (action === 'read_file') {
        const url = typeof args?.url === 'string' && args.url !== '' ? args.url : browser.status.url
        if (!url) throw new Error('read_file requires a url or an open page')
        const maxBytes = Math.max(64 * 1024, Math.min(50 * 1024 * 1024, Number(args?.maxBytes) || Number(config.files?.maxBytes) || 8 * 1024 * 1024))
        const maxPages = Math.max(1, Math.min(30, Number(args?.maxPages) || Number(config.files?.maxPages) || 10))
        const maxChars = Math.max(1000, Math.min(500000, Number(args?.maxChars) || Number(config.files?.maxChars) || 200000))
        const keep = args?.keep === true
        let result
        try {
          result = await readFileFromUrl({
            url,
            vault,
            store,
            dataDir: service.dataDir,
            maxBytes,
            maxPages,
            maxChars,
            keep,
            signal: exec?.signal,
          })
        } catch (error) {
          if (error instanceof FileTooLargeError || error?.code === 'FILE_TOO_LARGE') {
            const size = Number(error.sizeBytes) || 0
            const decision = await askDownloadApproval(service, exec, { url, sizeBytes: size })
            if (!decision.approved) {
              return {
                ok: false,
                action,
                needsApproval: true,
                sizeBytes: size,
                maxBytes,
                approved: false,
                message: `The file is ${formatBytes(size)}, above the ${formatBytes(maxBytes)} inline limit. The user did not approve the download. Ask before retrying.`,
              }
            }
            const approvedMax = Math.min(50 * 1024 * 1024, Math.max(size + 1024 * 1024, maxBytes * 2))
            result = await readFileFromUrl({
              url,
              vault,
              store,
              dataDir: service.dataDir,
              maxBytes: approvedMax,
              maxPages,
              maxChars,
              keep,
              signal: exec?.signal,
            })
          } else {
            throw error
          }
        }
        return { ok: true, action, ...result }
      }      if (action === 'click') {
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





