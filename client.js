// dsh-plugin-cookie-whitelist — Web settings page.
//
// Plain React from the host module table; no imports beyond "react". The page
// talks only to its own same-origin fenced route, which requires a custom
// header so a random website cannot CSRF the settings API.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-cookie-whitelist',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React
    const API = '/cookie-whitelist/api'
    const UI_HEADER = 'x-cookie-whitelist-ui'

    const TEXT = {
      zh: {
        title: 'Cookie 白名单',
        subtitle:
          '只有这里列出的域名会收到你的 Cookie。Cookie 只在内存中保存，浏览器使用一次性无痕实例；智能体只能导航、读取、点击翻页和截图，不能提交表单。',
        connected: '扩展已连接',
        disconnected: '扩展未连接',
        receiver: '接收器',
        vault: '内存 Cookie',
        pending: '待批准',
        error: '操作失败',
        notice: '已完成',
        requestsTitle: '授权请求',
        requestsEmpty: '目前没有待批准的域名。智能体请求新域名时会出现在这里。',
        allow: '允许并加入白名单',
        deny: '拒绝',
        reason: '原因',
        noReason: '未填写原因',
        source: '来源',
        expires: '过期',
        whitelistTitle: '域名白名单',
        whitelistHint: '支持子域。删除后，该域名不会再收到 Cookie；已获取的内存 Cookie 会在到期后清除。',
        domainPlaceholder: '例如 example.com 或 mail.example.com',
        add: '加入白名单',
        remove: '移除',
        cookies: '条 Cookie',
        none: '无',
        extensionTitle: '浏览器扩展',
        extensionHint:
          '扩展在浏览器内部读取 Cookie，并在离开浏览器之前只保留任务中的白名单域名。它只会把数据发到本机 127.0.0.1。',
        receiverUrl: '接收地址',
        token: '配对令牌',
        show: '显示',
        hide: '隐藏',
        copy: '复制',
        copyUrl: '复制地址',
        copyToken: '复制令牌',
        openFolder: '打开文件夹',
        chrome: 'Chrome / Edge',
        firefox: 'Firefox',
        steps: '安装步骤',
        lastSeen: '最近心跳',
        neverSeen: '从未连接',
        browserLabel: '浏览器',
        extError: '扩展报告',
        loginTitle: '临时浏览器登录（Chrome / Edge）',
        loginHint:
          '如果使用 Firefox 或其他浏览器，或扩展不可用，可以让用户在一次性登录窗口里手动登录。登录完成后点“完成并提取”，Cookie 会进入内存 Vault，窗口和临时 profile 立即销毁。',
        loginPlaceholder: '已加入白名单的域名',
        startLogin: '打开登录窗口',
        finishLogin: '完成并提取',
        cancelLogin: '取消',
        loginOpen: '登录窗口已打开',
        loginClosed: '窗口已关闭',
        vaultTitle: '只读浏览器与内存 Vault',
        vaultHint:
          '每次导航前都会清空浏览器 Cookie，只注入当前 URL 命中白名单的 Cookie。非白名单站点一律匿名访问；POST/PUT/PATCH/DELETE 全部被拦截。',
        browserRunning: '只读浏览器运行中',
        browserStopped: '只读浏览器未启动',
        closeBrowser: '关闭只读浏览器',
        clearVault: '清空内存 Cookie',
        clearConfirm: '确定要清空内存中的全部 Cookie 吗？智能体需要重新同步或重新登录。',
        injected: '已注入',
        blocked: '已拦截请求',
        blockedSubmit: '已拦截提交',
        vaultDomains: '域名',
        vaultEmpty: '内存中还没有 Cookie。先安装扩展并同步，或使用临时登录。',
        syncAll: '让扩展立即同步',
        browser: '浏览器',
        footer: '只读方法：GET / HEAD / OPTIONS。Cookie 值不会出现在界面、日志或工具结果中。',
        loading: '加载中…',
        noReceiver: '接收器未启动，请查看 DSH 日志。',
        version: '版本',
        confirm: '确认',
        copyDone: '已复制到剪贴板',
        copyFail: '复制失败，请手动选择文本。',
        addDone: '已加入白名单，正在请求扩展同步。',
        removed: '已移除。',
        approved: '已批准，正在请求扩展同步。',
        rejected: '已拒绝。',
        synced: '已通知扩展同步。',
        vaultCleared: '内存 Cookie 已清空。',
        browserClosed: '只读浏览器已关闭。',
        loginStarted: '登录窗口已打开，请在窗口中完成登录。',
        loginFinished: '已提取 Cookie 并销毁登录窗口。',
        loginCancelled: '已取消并销毁登录窗口。',
        reveal: '已打开扩展文件夹。',
        refresh: '刷新',
        connHint: '扩展每 2 秒轮询一次；心跳在 90 秒内视为已连接。',
        tokenHint: '只显示给本机用户；不要发到聊天里。',
        extPath: '数据目录',
        reqQueued: '等待扩展下一次轮询。',
      },
      en: {
        title: 'Cookie Whitelist',
        subtitle:
          'Only the domains listed here receive your cookies. Values live in memory only, the browser is a disposable incognito instance, and the agent can navigate, read, click pagination, and screenshot but cannot submit forms.',
        connected: 'Extension connected',
        disconnected: 'Extension offline',
        receiver: 'Receiver',
        vault: 'In-memory cookies',
        pending: 'Pending',
        error: 'Action failed',
        notice: 'Done',
        requestsTitle: 'Authorization requests',
        requestsEmpty: 'No pending domains. Requests from the agent appear here.',
        allow: 'Allow and whitelist',
        deny: 'Deny',
        reason: 'Reason',
        noReason: 'No reason given',
        source: 'Source',
        expires: 'Expires',
        whitelistTitle: 'Domain whitelist',
        whitelistHint: 'Subdomains are included. Removing a domain stops future cookie injection; already fetched cookies expire from memory.',
        domainPlaceholder: 'e.g. example.com or mail.example.com',
        add: 'Add domain',
        remove: 'Remove',
        cookies: 'cookies',
        none: 'none',
        extensionTitle: 'Browser extension',
        extensionHint:
          'The extension reads cookies inside the browser and keeps only the whitelisted domains in the current task before anything leaves the browser. It sends data only to 127.0.0.1.',
        receiverUrl: 'Receiver URL',
        token: 'Pairing token',
        show: 'Show',
        hide: 'Hide',
        copy: 'Copy',
        copyUrl: 'Copy URL',
        copyToken: 'Copy token',
        openFolder: 'Open folder',
        chrome: 'Chrome / Edge',
        firefox: 'Firefox',
        steps: 'Setup',
        lastSeen: 'Last heartbeat',
        neverSeen: 'Never connected',
        browserLabel: 'Browser',
        extError: 'Extension reports',
        loginTitle: 'Temporary browser login (Chrome / Edge)',
        loginHint:
          'For Firefox or another browser, or when the extension is unavailable, open a disposable login window. After logging in, click Finish: cookies enter the memory vault and the window/profile are destroyed.',
        loginPlaceholder: 'A whitelisted domain',
        startLogin: 'Open login window',
        finishLogin: 'Finish and capture',
        cancelLogin: 'Cancel',
        loginOpen: 'Login window open',
        loginClosed: 'Window closed',
        vaultTitle: 'Read-only browser and memory vault',
        vaultHint:
          'Cookies are cleared before every navigation and only those matching the whitelist are injected. Non-whitelisted sites are anonymous; POST/PUT/PATCH/DELETE are blocked.',
        browserRunning: 'Read-only browser running',
        browserStopped: 'Read-only browser stopped',
        closeBrowser: 'Close browser',
        clearVault: 'Clear memory cookies',
        clearConfirm: 'Clear every cookie currently held in memory? The agent will need to sync or log in again.',
        injected: 'injected',
        blocked: 'blocked requests',
        blockedSubmit: 'blocked submits',
        vaultDomains: 'Domain',
        vaultEmpty: 'No cookies in memory. Install the extension and sync, or use temporary login.',
        syncAll: 'Sync now',
        browser: 'Browser',
        footer: 'Read-only methods: GET / HEAD / OPTIONS. Cookie values never appear in the UI, logs, or tool results.',
        loading: 'Loading…',
        noReceiver: 'Receiver is not running; check the DSH log.',
        version: 'Version',
        confirm: 'Confirm',
        copyDone: 'Copied to clipboard',
        copyFail: 'Copy failed; select the text manually.',
        addDone: 'Domain added; asking the extension to sync.',
        removed: 'Removed.',
        approved: 'Approved; asking the extension to sync.',
        rejected: 'Rejected.',
        synced: 'Extension sync requested.',
        vaultCleared: 'In-memory cookies cleared.',
        browserClosed: 'Read-only browser closed.',
        loginStarted: 'Login window opened; finish logging in there.',
        loginFinished: 'Cookies captured and the login window destroyed.',
        loginCancelled: 'Login cancelled and window destroyed.',
        reveal: 'Extension folder opened.',
        refresh: 'Refresh',
        connHint: 'The extension polls every 2 seconds; a heartbeat within 90 seconds counts as connected.',
        tokenHint: 'Shown only to the local user; never paste it into chat.',
        extPath: 'Data directory',
        reqQueued: 'Waiting for the next extension poll.',
      },
    }

    function detectLang() {
      const raw = (typeof navigator !== 'undefined' && navigator.language) || ''
      return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    const LANG = detectLang()
    const L = TEXT[LANG]
    function t(key) {
      return L[key] === undefined ? key : L[key]
    }

    function api(method, payload) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [UI_HEADER]: '1' },
        body: JSON.stringify(Object.assign({ method }, payload === undefined ? {} : payload)),
      })
        .then(async (response) => {
          const parsed = await response.json().catch(() => null)
          if (!response.ok || parsed === null || parsed.ok !== true) {
            const message =
              parsed && parsed.error && typeof parsed.error.message === 'string'
                ? parsed.error.message
                : `HTTP ${response.status}`
            throw new Error(message)
          }
          return parsed.value
        })
        .catch((error) => {
          if (error instanceof Error) throw error
          throw new Error(String(error))
        })
    }

    function formatTime(ms) {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff >= 0 && diff < 90_000) return LANG === 'zh' ? '刚刚' : 'just now'
      if (diff >= 0 && diff < 3_600_000) {
        const mins = Math.max(1, Math.round(diff / 60_000))
        return LANG === 'zh' ? `${mins} 分钟前` : `${mins} min ago`
      }
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    function formatExpiry(ms) {
      if (!ms) return '—'
      const diff = ms - Date.now()
      if (diff <= 0) return LANG === 'zh' ? '已过期' : 'expired'
      const mins = Math.max(1, Math.round(diff / 60_000))
      return LANG === 'zh' ? `${mins} 分钟后` : `in ${mins} min`
    }

    async function copyText(text, onDone, onFail) {
      try {
        await navigator.clipboard.writeText(text)
        onDone()
        return
      } catch {
        // fall through
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        if (ok) onDone()
        else onFail()
      } catch {
        onFail()
      }
    }

    const CSS = `
      .cw-root { display:flex; flex-direction:column; gap:16px; padding:2px 2px 24px; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.55; }
      .cw-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
      .cw-title { font-size:18px; font-weight:650; letter-spacing:-.01em; }
      .cw-sub { color:var(--dsw-alias-label-secondary); max-width:720px; margin-top:4px; }
      .cw-pills { display:flex; flex-wrap:wrap; gap:6px; }
      .cw-pill { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:999px; padding:2px 9px; font-size:11px; color:var(--dsw-alias-label-secondary); display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
      .cw-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); display:inline-block; }
      .cw-dot.ok { background:var(--dsw-alias-state-success-primary); }
      .cw-dot.bad { background:var(--dsw-alias-state-error-primary); }
      .cw-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:12px; align-items:start; }
      .cw-card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:10px; min-width:0; }
      .cw-card.wide { grid-column:1 / -1; }
      .cw-h2 { font-size:13px; font-weight:650; display:flex; align-items:center; gap:6px; }
      .cw-hint { color:var(--dsw-alias-label-secondary); font-size:12px; }
      .cw-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .cw-grow { flex:1 1 auto; min-width:0; }
      .cw-input { flex:1 1 180px; min-width:0; height:30px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:7px; padding:0 9px; font:inherit; outline:none; }
      .cw-input:focus { border-color:var(--dsw-alias-brand-primary); }
      .cw-btn { height:30px; padding:0 11px; border-radius:7px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; cursor:pointer; white-space:nowrap; }
      .cw-btn:hover { border-color:var(--dsw-alias-border-l2); }
      .cw-btn.primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
      .cw-btn.primary:hover { filter:brightness(1.06); }
      .cw-btn.danger { color:var(--dsw-alias-state-error-primary); }
      .cw-btn.ok { color:var(--dsw-alias-state-success-primary); }
      .cw-btn.small { height:26px; padding:0 8px; font-size:12px; }
      .cw-btn:disabled { opacity:.5; cursor:not-allowed; }
      .cw-list { display:flex; flex-direction:column; gap:6px; max-height:280px; overflow:auto; }
      .cw-item { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:9px 10px; display:flex; gap:10px; justify-content:space-between; align-items:flex-start; background:var(--dsw-alias-bg-base); }
      .cw-item-main { min-width:0; display:flex; flex-direction:column; gap:2px; }
      .cw-domain { font-weight:600; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px; overflow-wrap:anywhere; }
      .cw-meta { color:var(--dsw-alias-label-secondary); font-size:11.5px; overflow-wrap:anywhere; }
      .cw-empty { color:var(--dsw-alias-label-tertiary); font-size:12px; padding:8px 0; }
      .cw-code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11.5px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:2px 6px; overflow-wrap:anywhere; }
      .cw-alert { border-radius:8px; padding:8px 10px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); }
      .cw-alert.error { color:var(--dsw-alias-state-error-primary); }
      .cw-alert.ok { color:var(--dsw-alias-state-success-primary); }
      .cw-steps { margin:0; padding-left:18px; color:var(--dsw-alias-label-secondary); font-size:12px; display:flex; flex-direction:column; gap:3px; }
      .cw-sep { height:1px; background:var(--dsw-alias-border-l1); margin:2px 0; }
      .cw-kv { display:grid; grid-template-columns:auto 1fr; gap:4px 10px; font-size:12px; align-items:baseline; }
      .cw-k { color:var(--dsw-alias-label-secondary); white-space:nowrap; }
      .cw-v { min-width:0; overflow-wrap:anywhere; }
      .cw-tag { font-size:11px; color:var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l1); border-radius:5px; padding:0 5px; }
      @media (max-width: 720px) { .cw-grid { grid-template-columns:1fr; } }
    `

    function Pill(props) {
      return h(
        'span',
        { className: 'cw-pill' },
        h('span', { className: `cw-dot ${props.tone || ''}` }),
        props.children,
      )
    }

    function Card(props) {
      return h(
        'section',
        { className: `cw-card${props.wide ? ' wide' : ''}` },
        h('div', { className: 'cw-h2' }, props.title),
        props.hint ? h('div', { className: 'cw-hint' }, props.hint) : null,
        props.children,
      )
    }

    function SettingsPage() {
      const [status, setStatus] = useState(null)
      const [pairing, setPairing] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [domain, setDomain] = useState('')
      const [loginDomain, setLoginDomain] = useState('')
      const [showToken, setShowToken] = useState(false)

      const refresh = useCallback(async () => {
        try {
          const value = await api('status')
          setStatus(value)
          setError('')
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }, [])

      useEffect(() => {
        let alive = true
        refresh()
        api('pairing')
          .then((value) => {
            if (alive) setPairing(value)
          })
          .catch((e) => {
            if (alive) setError(e instanceof Error ? e.message : String(e))
          })
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') refresh()
        }, 2500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [refresh])

      const run = useCallback(
        async (method, payload, message) => {
          if (busy !== '') return null
          setBusy(method + (payload && payload.id ? `:${payload.id}` : ''))
          setError('')
          setNotice('')
          try {
            const value = await api(method, payload)
            if (value && value.status) setStatus(value.status)
            if (message) setNotice(typeof message === 'function' ? message(value) : message)
            return value
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
            return null
          } finally {
            setBusy('')
          }
        },
        [busy],
      )

      const whitelist = status && Array.isArray(status.whitelist) ? status.whitelist : []
      const requests = status && Array.isArray(status.requests) ? status.requests : []
      const vaultDomains = status && status.vault && Array.isArray(status.vault.domains) ? status.vault.domains : []
      const loginSessions = status && Array.isArray(status.loginSessions) ? status.loginSessions : []
      const browser = (status && status.browser) || {}
      const extension = (status && status.extension) || {}
      const receiver = (status && status.receiver) || {}
      const vaultTotal = status && status.vault ? status.vault.totalCookies : 0
      const counts = useMemo(() => {
        const map = new Map()
        for (const row of vaultDomains) map.set(row.domain, row)
        return map
      }, [vaultDomains])

      function onAdd() {
        const value = domain.trim()
        if (value === '') return
        run('whitelist.add', { domain: value }, t('addDone')).then((result) => {
          if (result) setDomain('')
        })
      }

      function onStartLogin() {
        const value = loginDomain.trim()
        if (value === '') return
        run('login.start', { domain: value }, t('loginStarted')).then((result) => {
          if (result) setLoginDomain('')
        })
      }

      function onCopy(text, label) {
        copyText(
          text,
          () => setNotice(`${label}${LANG === 'zh' ? '：' : ': '}${t('copyDone')}`),
          () => setError(t('copyFail')),
        )
      }

      const pendingCount = requests.length
      const extConnected = extension.connected === true

      return h(
        'div',
        { className: 'cw-root' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'cw-head' },
          h(
            'div',
            null,
            h('div', { className: 'cw-title' }, t('title')),
            h('div', { className: 'cw-sub' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'cw-pills' },
            h(Pill, { tone: extConnected ? 'ok' : 'bad' }, extConnected ? t('connected') : t('disconnected')),
            h(Pill, { tone: receiver.running ? 'ok' : 'bad' }, `${t('receiver')} ${receiver.running ? `:${receiver.port}` : '—'}`),
            h(Pill, null, `${t('vault')} ${vaultTotal}`),
            h(Pill, { tone: pendingCount > 0 ? 'bad' : '' }, `${t('pending')} ${pendingCount}`),
          ),
        ),
        error ? h('div', { className: 'cw-alert error' }, `${t('error')}: ${error}`) : null,
        notice ? h('div', { className: 'cw-alert ok' }, notice) : null,

        h(
          'div',
          { className: 'cw-grid' },
          h(
            Card,
            { title: t('requestsTitle'), hint: pendingCount === 0 ? t('requestsEmpty') : null },
            pendingCount === 0
              ? null
              : h(
                  'div',
                  { className: 'cw-list' },
                  requests.map((request) =>
                    h(
                      'div',
                      { className: 'cw-item', key: request.id },
                      h(
                        'div',
                        { className: 'cw-item-main' },
                        h('div', { className: 'cw-domain' }, request.domain),
                        h('div', { className: 'cw-meta' }, `${t('reason')}: ${request.reason || t('noReason')}`),
                        h('div', { className: 'cw-meta' }, `${t('source')}: ${request.source || 'agent'} · ${t('expires')}: ${formatExpiry(request.expiresAt)}`),
                      ),
                      h(
                        'div',
                        { className: 'cw-row' },
                        h(
                          'button',
                          { type: 'button', className: 'cw-btn primary small', disabled: busy !== '', onClick: () => run('requests.approve', { id: request.id }, t('approved')) },
                          t('allow'),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'cw-btn danger small', disabled: busy !== '', onClick: () => run('requests.reject', { id: request.id }, t('rejected')) },
                          t('deny'),
                        ),
                      ),
                    ),
                  ),
                ),
          ),

          h(
            Card,
            { title: t('whitelistTitle'), hint: t('whitelistHint') },
            h(
              'div',
              { className: 'cw-row' },
              h('input', {
                className: 'cw-input',
                value: domain,
                placeholder: t('domainPlaceholder'),
                onChange: (event) => setDomain(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') onAdd()
                },
              }),
              h('button', { type: 'button', className: 'cw-btn primary', disabled: busy !== '', onClick: onAdd }, t('add')),
            ),
            whitelist.length === 0
              ? h('div', { className: 'cw-empty' }, LANG === 'zh' ? '白名单为空。先加入一个域名，或让智能体发起授权请求。' : 'The whitelist is empty. Add a domain or let the agent request one.')
              : h(
                  'div',
                  { className: 'cw-list' },
                  whitelist.map((item) => {
                    const row = counts.get(item)
                    return h(
                      'div',
                      { className: 'cw-item', key: item },
                      h(
                        'div',
                        { className: 'cw-item-main' },
                        h('div', { className: 'cw-domain' }, item),
                        h(
                          'div',
                          { className: 'cw-meta' },
                          row ? `${row.cookies} ${t('cookies')} · ${t('lastSeen')}: ${formatTime(row.receivedAt)}` : `0 ${t('cookies')}`,
                        ),
                      ),
                      h(
                        'button',
                        { type: 'button', className: 'cw-btn danger small', disabled: busy !== '', onClick: () => run('whitelist.remove', { domain: item }, t('removed')) },
                        t('remove'),
                      ),
                    )
                  }),
                ),
          ),
          h(
            Card,
            { title: t('extensionTitle'), hint: t('extensionHint'), wide: true },
            h(
              'div',
              { className: 'cw-kv' },
              h('span', { className: 'cw-k' }, t('receiverUrl')),
              h(
                'span',
                { className: 'cw-v' },
                h('span', { className: 'cw-code' }, pairing && pairing.receiverUrl ? pairing.receiverUrl : '—'),
                pairing && pairing.receiverUrl
                  ? h(
                      'button',
                      { type: 'button', className: 'cw-btn small', style: { marginLeft: 6 }, onClick: () => onCopy(pairing.receiverUrl, t('receiverUrl')) },
                      t('copyUrl'),
                    )
                  : null,
              ),
              h('span', { className: 'cw-k' }, t('token')),
              h(
                'span',
                { className: 'cw-v' },
                h('span', { className: 'cw-code' }, pairing ? (showToken ? pairing.token : '••••••••••••••••') : '—'),
                pairing
                  ? h(
                      'button',
                      { type: 'button', className: 'cw-btn small', style: { marginLeft: 6 }, onClick: () => setShowToken(!showToken) },
                      showToken ? t('hide') : t('show'),
                    )
                  : null,
                pairing
                  ? h(
                      'button',
                      { type: 'button', className: 'cw-btn small', style: { marginLeft: 6 }, onClick: () => onCopy(pairing.token, t('token')) },
                      t('copyToken'),
                    )
                  : null,
                h('span', { className: 'cw-meta', style: { marginLeft: 6 } }, t('tokenHint')),
              ),
              h('span', { className: 'cw-k' }, t('lastSeen')),
              h(
                'span',
                { className: 'cw-v' },
                extension.lastSeen
                  ? `${formatTime(extension.lastSeen)} · ${extension.browser || t('browser')}${extension.version ? ` v${extension.version}` : ''}`
                  : t('neverSeen'),
              ),
            ),
            extension.error ? h('div', { className: 'cw-alert error' }, `${t('extError')}: ${extension.error}`) : null,
            h(
              'div',
              { className: 'cw-grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' } },
              h(
                'div',
                { className: 'cw-item-main' },
                h('div', { className: 'cw-h2' }, t('chrome')),
                h('div', { className: 'cw-meta cw-code' }, pairing && pairing.extensions ? pairing.extensions.chromium : '—'),
                h(
                  'div',
                  { className: 'cw-row', style: { marginTop: 6 } },
                  h(
                    'button',
                    { type: 'button', className: 'cw-btn small', disabled: !pairing || busy !== '', onClick: () => run('extension.reveal', { kind: 'chromium' }, t('reveal')) },
                    t('openFolder'),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'cw-item-main' },
                h('div', { className: 'cw-h2' }, t('firefox')),
                h('div', { className: 'cw-meta cw-code' }, pairing && pairing.extensions ? pairing.extensions.firefox : '—'),
                h(
                  'div',
                  { className: 'cw-row', style: { marginTop: 6 } },
                  h(
                    'button',
                    { type: 'button', className: 'cw-btn small', disabled: !pairing || busy !== '', onClick: () => run('extension.reveal', { kind: 'firefox' }, t('reveal')) },
                    t('openFolder'),
                  ),
                ),
              ),
            ),
            h('div', { className: 'cw-sep' }),
            h('div', { className: 'cw-h2' }, t('steps')),
            h(
              'ol',
              { className: 'cw-steps' },
              (pairing && Array.isArray(LANG === 'zh' && pairing.stepsZh ? pairing.stepsZh : pairing.steps) ? (LANG === 'zh' && pairing.stepsZh ? pairing.stepsZh : pairing.steps) : []).map((step, index) => h('li', { key: index }, step)),
            ),
            h('div', { className: 'cw-meta' }, t('connHint')),
            h(
              'div',
              { className: 'cw-row' },
              h('button', { type: 'button', className: 'cw-btn', disabled: busy !== '', onClick: () => run('sync.all', {}, t('synced')) }, t('syncAll')),
              h('button', { type: 'button', className: 'cw-btn', disabled: busy !== '', onClick: refresh }, t('refresh')),
            ),
          ),

          h(
            Card,
            { title: t('loginTitle'), hint: t('loginHint') },
            h(
              'div',
              { className: 'cw-row' },
              h('input', {
                className: 'cw-input',
                value: loginDomain,
                placeholder: t('loginPlaceholder'),
                list: 'cw-whitelist-domains',
                onChange: (event) => setLoginDomain(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') onStartLogin()
                },
              }),
              h(
                'datalist',
                { id: 'cw-whitelist-domains' },
                whitelist.map((item) => h('option', { key: item, value: item })),
              ),
              h('button', { type: 'button', className: 'cw-btn primary', disabled: busy !== '', onClick: onStartLogin }, t('startLogin')),
            ),
            loginSessions.length === 0
              ? null
              : h(
                  'div',
                  { className: 'cw-list' },
                  loginSessions.map((session) =>
                    h(
                      'div',
                      { className: 'cw-item', key: session.id },
                      h(
                        'div',
                        { className: 'cw-item-main' },
                        h('div', { className: 'cw-domain' }, session.domain),
                        h(
                          'div',
                          { className: 'cw-meta' },
                          session.running
                            ? `${t('loginOpen')} · ${formatTime(session.startedAt)}`
                            : `${t('loginClosed')} · ${formatTime(session.startedAt)}`,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'cw-row' },
                        h(
                          'button',
                          { type: 'button', className: 'cw-btn primary small', disabled: busy !== '' || !session.running, onClick: () => run('login.finish', { id: session.id }, t('loginFinished')) },
                          t('finishLogin'),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'cw-btn danger small', disabled: busy !== '', onClick: () => run('login.cancel', { id: session.id }, t('loginCancelled')) },
                          t('cancelLogin'),
                        ),
                      ),
                    ),
                  ),
                ),
          ),
          h(
            Card,
            { title: t('vaultTitle'), hint: t('vaultHint'), wide: true },
            h(
              'div',
              { className: 'cw-row' },
              h(Pill, { tone: browser.running ? 'ok' : '' }, browser.running ? t('browserRunning') : t('browserStopped')),
              browser.running
                ? h(Pill, null, `${t('browser')} ${browser.browser || '—'} · ${t('injected')} ${browser.injectedCookies || 0}`)
                : null,
              h(Pill, null, `${t('blocked')} ${browser.blockedRequests || 0}`),
              h(Pill, null, `${t('blockedSubmit')} ${browser.blockedSubmits || 0}`),
            ),
            h(
              'div',
              { className: 'cw-row' },
              h(
                'button',
                { type: 'button', className: 'cw-btn', disabled: busy !== '' || !browser.running, onClick: () => run('browser.close', {}, t('browserClosed')) },
                t('closeBrowser'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'cw-btn danger',
                  disabled: busy !== '' || vaultTotal === 0,
                  onClick: () => {
                    if (window.confirm(t('clearConfirm'))) run('vault.clear', {}, t('vaultCleared'))
                  },
                },
                t('clearVault'),
              ),
            ),
            vaultDomains.length === 0
              ? h('div', { className: 'cw-empty' }, t('vaultEmpty'))
              : h(
                  'div',
                  { className: 'cw-list' },
                  vaultDomains.map((row) =>
                    h(
                      'div',
                      { className: 'cw-item', key: row.domain },
                      h(
                        'div',
                        { className: 'cw-item-main' },
                        h('div', { className: 'cw-domain' }, row.domain),
                        h(
                          'div',
                          { className: 'cw-meta' },
                          `${row.cookies} ${t('cookies')} · ${Math.round(row.bytes / 1024)} KB · ${t('lastSeen')}: ${formatTime(row.receivedAt)}`,
                        ),
                      ),
                      h('span', { className: 'cw-tag' }, formatExpiry(row.expiresAt)),
                    ),
                  ),
                ),
            h('div', { className: 'cw-sep' }),
            h('div', { className: 'cw-meta' }, t('footer')),
            h('div', { className: 'cw-meta' }, `${t('version')} ${status ? status.version : '—'} · ${t('extPath')} ${status ? status.dataDir : '—'}`),
          ),
        ),
      )
    }

    return {
      name: 'dsh-plugin-cookie-whitelist',
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'cookie-whitelist',
                  order: 65,
                  label: LANG === 'zh' ? 'Cookie 白名单' : 'Cookie Whitelist',
                  registrant: 'dsh-plugin-cookie-whitelist',
                },
                SettingsPage,
              ),
            ),
          'cookie-whitelist: settings section',
        )
      },
    }
  },
})

