/**
 * One disposable, read-only headless Chromium.
 *
 * The page is driven through CDP. There is no click-to-submit, no fill, and
 * no arbitrary JS tool. Fetch interception aborts every method except
 * GET/HEAD/OPTIONS, and strips the Cookie header whenever the top-level page
 * is not a whitelisted domain.
 */
import { cleanupProfile, killBrowserHandle, launchChromium, resolveBrowser } from './cdp.mjs'
import { delay, parseWebUrl, truncateText, urlHost } from './util.mjs'

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const INIT_SCRIPT = `(() => {
  if (window.__cwInstalled) return;
  window.__cwInstalled = true;
  const bump = (name) => { window[name] = (window[name] || 0) + 1; };
  window.addEventListener('submit', (event) => {
    bump('__cwBlockedSubmit');
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  const htmlForm = window.HTMLFormElement && window.HTMLFormElement.prototype;
  if (htmlForm) {
    for (const name of ['submit', 'requestSubmit']) {
      if (typeof htmlForm[name] === 'function') {
        htmlForm[name] = function () { bump('__cwBlockedSubmit'); return undefined; };
      }
    }
  }
  if (typeof window.open === 'function') {
    window.open = function () { bump('__cwBlockedPopup'); return null; };
  }
  if (navigator && typeof navigator.sendBeacon === 'function') {
    navigator.sendBeacon = function () { bump('__cwBlockedBeacon'); return false; };
  }
})()`

const READ_EXPRESSION = `(() => {
  const root = document.body || document.documentElement;
  if (!root) return { title: document.title || '', url: location.href, text: '', links: [] };
  const clone = root.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,svg,canvas,iframe,template').forEach((node) => node.remove());
  let text = '';
  if (typeof clone.innerText === 'string' && clone.innerText !== '') text = clone.innerText;
  else text = clone.textContent || '';
  text = text.replace(/\\r/g, '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (links.length >= 300) break;
    const href = String(anchor.href || '');
    if (!/^https?:/i.test(href)) continue;
    links.push({ text: String(anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 200), href });
  }
  return { title: document.title || '', url: location.href, text, links };
})()`

const SNAPSHOT_EXPRESSION = (() => {
  const source = `(() => {
    const seq = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const nodes = document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]');
    const rows = [];
    let index = 0;
    for (const el of nodes) {
      if (rows.length >= 300) break;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width < 2 || rect.height < 2) continue;
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      const ref = seq + '-' + String(index);
      index += 1;
      el.setAttribute('data-cw-ref', ref);
      let text = '';
      try { text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim(); } catch {}
      rows.push({
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        role: el.getAttribute('role') || '',
        name: el.getAttribute('name') || '',
        href: el.href || '',
        text: String(text).slice(0, 240),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        inForm: !!el.closest('form'),
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
    }
    return { url: location.href, title: document.title || '', elements: rows, scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight };
  })()`
  return source
})()

const FILES_EXPRESSION = `(() => {
  const extOf = (href) => {
    try {
      const name = new URL(href).pathname.split('/').pop() || '';
      const m = name.match(/\\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : '';
    } catch { return ''; }
  };
  const fileExt = new Set(['pdf','doc','docx','xls','xlsx','ppt','pptx','csv','txt','md','zip','rar','7z','odt','ods','odp']);
  const keyword = /course\\s*planner|planner|schedule|syllabus|guideline|rubric|lecture|notes?|lab|assignment|test|exam|revision|past\\s*year/i;
  const rows = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    const text = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
    const ext = extOf(href);
    const resource = /\\/mod\\/resource\\//i.test(href);
    const folder = /\\/mod\\/folder\\//i.test(href);
    const pluginfile = /\\/pluginfile\\.php/i.test(href);
    const looksLikeFile = resource || folder || pluginfile || fileExt.has(ext);
    if (!looksLikeFile && !keyword.test(text)) continue;
    seen.add(href);
    let score = 0;
    if (keyword.test(text)) score += 3;
    if (resource) score += 2;
    if (pluginfile) score += 1;
    if (fileExt.has(ext)) score += 1;
    rows.push({ text, href, ext: ext || '', kind: resource ? 'resource' : folder ? 'folder' : pluginfile ? 'file' : (ext || 'link'), score });
    if (rows.length >= 150) break;
  }
  rows.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  return { url: location.href, title: document.title || '', files: rows.slice(0, 100) };
})()`
function clickExpression(ref) {
  return `(() => {
    const ref = ${JSON.stringify(String(ref))};
    const el = document.querySelector('[data-cw-ref="' + (window.CSS && CSS.escape ? CSS.escape(ref) : ref) + '"]');
    if (!el) return { ok: false, error: 'ref-not-found' };
    const form = el.closest('form');
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (form && (tag === 'button' || (tag === 'input' && (type === 'submit' || type === 'image' || type === 'button')))) {
      window.__cwBlockedSubmit = (window.__cwBlockedSubmit || 0) + 1;
      return { ok: false, error: 'form-submit-blocked', tag };
    }
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return {
      ok: true,
      tag,
      text: String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 200),
      href: el.href || ''
    };
  })()`
}

export class ReadOnlyBrowser {
  constructor({ dataDir, config, store, vault, log = console }) {
    this.dataDir = dataDir
    this.config = config
    this.store = store
    this.vault = vault
    this.log = log
    this.launch = null
    this.cdp = null
    this.browserInfo = null
    this.ready = false
    this.starting = null
    this.mainFrameId = ''
    this.currentUrl = ''
    this.navigationHost = ''
    this.injectedCount = 0
    this.blockedMethods = 0
    this.blockedSubmit = 0
    this.idleTimer = null
    this.queue = Promise.resolve()
    this.offs = []
    this.scriptId = ''
  }

  get status() {
    return {
      running: this.ready && this.cdp !== null && !this.cdp.closed,
      browser: this.browserInfo?.kind ?? '',
      executable: this.browserInfo?.executable ?? '',
      port: this.launch?.port ?? 0,
      url: this.currentUrl,
      injectedCookies: this.injectedCount,
      blockedRequests: this.blockedMethods,
      blockedSubmits: this.blockedSubmit,
    }
  }

  enqueue(operation) {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  touchIdle() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    const minutes = Number(this.config.browser?.idleTimeoutMin ?? 15)
    if (!(minutes > 0)) return
    this.idleTimer = setTimeout(() => {
      this.log.info?.('[cookie-whitelist] closing idle read-only browser')
      void this.close().catch(() => {})
    }, minutes * 60_000)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  async ensure() {
    if (this.cdp !== null && !this.cdp.closed) return
    if (this.starting !== null) return this.starting
    this.starting = this.startInternal().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async startInternal() {
    const browser = await resolveBrowser(this.config)
    const launched = await launchChromium({
      executable: browser.executable,
      headless: true,
      visible: false,
      dataDir: this.dataDir,
      log: this.log,
      timeoutMs: Number(this.config.browser?.readTimeoutMs ?? 20_000),
    })
    this.launch = launched
    this.cdp = launched.cdp
    this.browserInfo = browser
    try {
      await this.setupPage()
      this.ready = true
      this.touchIdle()
      this.log.info?.(`[cookie-whitelist] read-only browser ready (${browser.kind}) on port ${launched.port}`)
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async setupPage() {
    const cdp = this.cdp
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Network.enable')
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    try {
      await cdp.send('Network.setUserAgentOverride', {
        userAgent: USER_AGENT,
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      })
    } catch {
      // Non-fatal; some Chromium builds reject the override before navigation.
    }
    const frameTree = await cdp.send('Page.getFrameTree')
    this.mainFrameId = frameTree?.frameTree?.frame?.id ?? ''
    this.offs.push(
      cdp.on('Fetch.requestPaused', (params) => {
        void this.handleRequestPaused(params).catch((error) => {
          this.log.warn?.(`[cookie-whitelist] request interception failed: ${error?.message ?? error}`)
        })
      }),
    )
    this.offs.push(
      cdp.on('Page.frameNavigated', (params) => {
        if (params.frame && params.frame.parentId === undefined) {
          this.currentUrl = params.frame.url || this.currentUrl
          this.navigationHost = urlHost(params.frame.url) || this.navigationHost
        }
      }),
    )
    this.offs.push(
      cdp.on('Page.javascriptDialogOpening', () => {
        void cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
      }),
    )
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    const script = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT })
    this.scriptId = script?.identifier ?? ''
    await cdp.send('Page.navigate', { url: 'about:blank' }).catch(() => {})
  }

  async handleRequestPaused(params) {
    const { requestId, request, resourceType, frameId } = params
    if (!request || typeof request.url !== 'string') {
      await this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
      return
    }
    const method = String(request.method || 'GET').toUpperCase()
    if (!ALLOWED_METHODS.has(method)) {
      this.blockedMethods += 1
      await this.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
      return
    }
    if (resourceType === 'Document' && (frameId === this.mainFrameId || frameId === undefined)) {
      const host = urlHost(request.url)
      if (host !== null) this.navigationHost = host
    }
    const topHost = this.navigationHost || urlHost(this.currentUrl) || ''
    let strippedCookie = false
    const headers = { ...(request.headers || {}) }
    if (!this.store.isWhitelisted(topHost)) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'cookie') {
          delete headers[key]
          strippedCookie = true
        }
      }
    }
    if (strippedCookie) {
      // CDP's Fetch.Headers is an ARRAY of {name,value}; Network.Headers is a
      // dictionary. Passing the dictionary here makes continueRequest reject
      // with "Invalid parameters" and leaves the navigation paused forever.
      const pairs = Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))
      await this.cdp.send('Fetch.continueRequest', { requestId, headers: pairs }).catch(() => {})
    } else {
      await this.cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    }
  }

  waitForLoad(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        offLoad()
        offNav()
        resolve(value)
      }
      const offLoad = this.cdp.on('Page.loadEventFired', () => finish('load'))
      const offNav = this.cdp.on('Page.frameNavigated', (params) => {
        if (params.frame && params.frame.parentId === undefined) finish('navigated')
      })
      const timer = setTimeout(() => finish('timeout'), Math.max(3000, timeoutMs))
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  async evaluate(expression, timeoutMs = 20_000) {
    const result = await this.cdp.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: false },
      timeoutMs,
    )
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page evaluation failed'
      throw new Error(String(text).slice(0, 500))
    }
    return result.result?.value
  }

  async waitDocumentReady(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => '')
      if (state === 'complete' || state === 'interactive') return state
      await delay(100)
    }
    return ''
  }

  async clearAndInject(url) {
    await this.cdp.send('Network.clearBrowserCookies')
    const cookies = this.vault.getForUrl(url, this.store.listWhitelist())
    let injected = 0
    if (cookies.length > 0) {
      try {
        await this.cdp.send('Network.setCookies', { cookies })
        injected = cookies.length
      } catch {
        for (const cookie of cookies) {
          try {
            await this.cdp.send('Network.setCookie', cookie)
            injected += 1
          } catch {
            // One malformed cookie must not lose the others.
          }
        }
      }
    }
    this.injectedCount = injected
    return injected
  }

  async navigate(url, { timeoutMs } = {}) {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      const parsed = parseWebUrl(url)
      if (parsed === null) throw new Error('only http(s) URLs without credentials are allowed')
      const target = parsed.toString()
      const timeout = Math.max(3000, Number(timeoutMs ?? this.config.browser?.readTimeoutMs ?? 30_000))
      this.blockedMethods = 0
      this.blockedSubmit = 0
      this.navigationHost = urlHost(target) || ''
      const injected = await this.clearAndInject(target)
      const load = this.waitForLoad(timeout)
      const nav = await this.cdp.send('Page.navigate', { url: target })
      if (nav?.errorText) throw new Error(`navigation failed: ${nav.errorText}`)
      const loadResult = await load
      await delay(350)
      await this.waitDocumentReady(4000)
      const info = await this.evaluate('({ title: document.title || "", url: location.href, readyState: document.readyState })').catch(() => null)
      this.currentUrl = info?.url || target
      return {
        url: this.currentUrl,
        title: info?.title || '',
        readyState: info?.readyState || '',
        authenticated: this.store.isWhitelisted(urlHost(this.currentUrl) || ''),
        injectedCookies: injected,
        blockedRequests: this.blockedMethods,
        blockedSubmits: this.blockedSubmit,
        loadResult,
        timedOut: loadResult === 'timeout',
      }
    })
  }

  async read({ maxChars = 60_000 } = {}) {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      await this.waitDocumentReady(4000)
      const limit = Math.max(1000, Math.min(200_000, Number(maxChars) || 60_000))
      const info = await this.evaluate(READ_EXPRESSION)
      const finalUrl = typeof info?.url === 'string' && info.url !== '' ? info.url : this.currentUrl
      this.currentUrl = finalUrl
      const text = truncateText(String(info?.text ?? ''), limit)
      return {
        url: finalUrl,
        title: info?.title ?? '',
        text,
        truncated: String(info?.text ?? '').length > limit,
        links: Array.isArray(info?.links) ? info.links : [],
        authenticated: this.store.isWhitelisted(urlHost(finalUrl) || ''),
        injectedCookies: this.injectedCount,
        blockedRequests: this.blockedMethods,
        blockedSubmits: this.blockedSubmit,
      }
    })
  }

  async listFiles() {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      await this.waitDocumentReady(4000)
      const info = await this.evaluate(FILES_EXPRESSION)
      const finalUrl = typeof info?.url === 'string' && info.url !== '' ? info.url : this.currentUrl
      this.currentUrl = finalUrl
      return {
        url: finalUrl,
        title: info?.title ?? '',
        files: Array.isArray(info?.files) ? info.files : [],
        authenticated: this.store.isWhitelisted(urlHost(finalUrl) || ''),
        blockedRequests: this.blockedMethods,
        blockedSubmits: this.blockedSubmit,
      }
    })
  }
  async snapshot() {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      await this.waitDocumentReady(4000)
      const info = await this.evaluate(SNAPSHOT_EXPRESSION)
      const finalUrl = typeof info?.url === 'string' && info.url !== '' ? info.url : this.currentUrl
      this.currentUrl = finalUrl
      return {
        url: finalUrl,
        title: info?.title ?? '',
        elements: Array.isArray(info?.elements) ? info.elements : [],
        scrollY: info?.scrollY ?? 0,
        scrollHeight: info?.scrollHeight ?? 0,
        authenticated: this.store.isWhitelisted(urlHost(finalUrl) || ''),
        blockedRequests: this.blockedMethods,
        blockedSubmits: this.blockedSubmit,
      }
    })
  }

  async click(ref) {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      if (typeof ref !== 'string' || ref === '') throw new Error('a snapshot ref is required')
      const before = this.currentUrl
      const load = this.waitForLoad(6000)
      const result = await this.evaluate(clickExpression(ref))
      if (!result || result.ok !== true) return { ok: false, ...result, url: this.currentUrl }
      await load
      await delay(450)
      await this.waitDocumentReady(3000)
      const info = await this.evaluate('({ title: document.title || "", url: location.href })').catch(() => null)
      this.currentUrl = info?.url || this.currentUrl
      return {
        ok: true,
        ...result,
        url: this.currentUrl,
        title: info?.title ?? '',
        navigated: this.currentUrl !== before,
        authenticated: this.store.isWhitelisted(urlHost(this.currentUrl) || ''),
        blockedRequests: this.blockedMethods,
        blockedSubmits: this.blockedSubmit,
      }
    })
  }

  async scroll(deltaY) {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      const amount = Math.max(-10_000, Math.min(10_000, Number(deltaY) || 0))
      const info = await this.evaluate(`(() => { window.scrollBy({ top: ${amount}, behavior: 'instant' }); return { scrollY: Math.round(window.scrollY), innerHeight: window.innerHeight, scrollHeight: document.documentElement.scrollHeight }; })()`)
      return { ok: true, ...info, url: this.currentUrl }
    })
  }

  async screenshot() {
    return this.enqueue(async () => {
      await this.ensure()
      this.touchIdle()
      const result = await this.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      return { base64: result.data, url: this.currentUrl, title: await this.evaluate('document.title').catch(() => '') }
    })
  }

  async close() {
    const cdp = this.cdp
    const launch = this.launch
    this.cdp = null
    this.launch = null
    this.ready = false
    this.browserInfo = null
    this.currentUrl = ''
    this.navigationHost = ''
    this.injectedCount = 0
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    for (const off of this.offs) {
      try {
        off()
      } catch {
        // ignore
      }
    }
    this.offs = []
    if (cdp) {
      try {
        await cdp.send('Network.clearBrowserCookies', {}, 3000).catch(() => {})
      } catch {
        // ignore
      }
      cdp.close()
    }
    if (launch) {
      await killBrowserHandle(launch.handle, { log: this.log })
      await cleanupProfile(launch.profileDir, this.log)
    }
  }

  async dispose() {
    await this.close()
  }
}



