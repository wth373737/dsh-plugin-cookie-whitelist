/* DSH Cookie Whitelist Bridge — options page. */
const isFirefox = typeof globalThis.browser !== 'undefined' && globalThis.browser?.runtime?.id
const api = isFirefox ? globalThis.browser : globalThis.chrome

const $ = (id) => document.getElementById(id)
const DEFAULT_RECEIVER = 'http://127.0.0.1:47821'

function storageGet(keys) {
  if (isFirefox) return api.storage.local.get(keys)
  return new Promise((resolve, reject) => {
    api.storage.local.get(keys, (value) => {
      if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message))
      else resolve(value || {})
    })
  })
}

function storageSet(values) {
  if (isFirefox) return api.storage.local.set(values)
  return new Promise((resolve, reject) => {
    api.storage.local.set(values, () => {
      if (api.runtime.lastError) reject(new Error(api.runtime.lastError.message))
      else resolve()
    })
  })
}

function send(message) {
  if (isFirefox) return api.runtime.sendMessage(message)
  return new Promise((resolve) => {
    api.runtime.sendMessage(message, (response) => {
      if (api.runtime.lastError) resolve({ ok: false, error: api.runtime.lastError.message })
      else resolve(response)
    })
  })
}

function validateReceiver(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Error('接收地址无效')
  }
  if (url.protocol !== 'http:') throw new Error('接收地址必须是 http://127.0.0.1:<端口>')
  if (url.hostname !== '127.0.0.1') throw new Error('只允许 127.0.0.1，不允许 localhost 或远程地址')
  if (url.port === '') throw new Error('接收地址必须包含端口，例如 http://127.0.0.1:47821')
  return url.origin
}

function setStatus(text, tone) {
  const node = $('status')
  node.textContent = text
  node.className = `status${tone ? ` ${tone}` : ''}`
}

async function load() {
  const stored = await storageGet(['receiverUrl', 'token', 'label', 'lastPollAt', 'lastError'])
  $('receiverUrl').value = stored.receiverUrl || DEFAULT_RECEIVER
  $('token').value = stored.token || ''
  $('label').value = stored.label || (isFirefox ? 'Firefox' : 'Chrome/Edge')
  renderRuntime(stored.lastPollAt, stored.lastError)
}

function renderRuntime(lastPollAt, lastError) {
  $('lastPoll').textContent = lastPollAt ? new Date(lastPollAt).toLocaleString() : '—'
  $('lastError').textContent = lastError || '—'
  const fresh = typeof lastPollAt === 'number' && Date.now() - lastPollAt < 90_000
  $('connState').textContent = fresh ? '最近 90 秒内有轮询' : '尚未连接或已停止'
  $('connState').style.color = fresh ? 'var(--ok)' : 'var(--bad)'
}

async function save() {
  const receiverUrl = validateReceiver($('receiverUrl').value)
  const token = $('token').value.trim()
  if (token.length < 16) throw new Error('配对令牌看起来不完整')
  const label = $('label').value.trim() || (isFirefox ? 'Firefox' : 'Chrome/Edge')
  await storageSet({ receiverUrl, token, label })
  $('receiverUrl').value = receiverUrl
  setStatus('已保存。扩展会在下一次轮询时使用新配置。', 'ok')
  return { receiverUrl, token, label }
}

async function test() {
  await save()
  setStatus('正在测试…', '')
  const result = await send({ type: 'cookie-whitelist.test' })
  if (result && result.ok) {
    setStatus(`连接成功：${result.health?.name || 'receiver'} v${result.health?.version || ''}`, 'ok')
  } else {
    setStatus(`连接失败：${result?.error || '没有响应'}`, 'bad')
  }
}

async function syncNow() {
  await save()
  setStatus('正在请求同步…', '')
  const result = await send({ type: 'cookie-whitelist.sync' })
  if (result && result.ok) {
    setStatus(`同步完成：处理 ${result.tasks || 0} 个任务，接收 ${result.delivered || 0} 条 Cookie。`, 'ok')
  } else {
    setStatus(`同步失败：${result?.error || result?.reason || '没有响应'}`, 'bad')
  }
  const stored = await storageGet(['lastPollAt', 'lastError'])
  renderRuntime(stored.lastPollAt, stored.lastError)
}

$('toggleToken').addEventListener('click', () => {
  const input = $('token')
  const showing = input.type === 'text'
  input.type = showing ? 'password' : 'text'
  $('toggleToken').textContent = showing ? '显示' : '隐藏'
})

$('save').addEventListener('click', () => {
  save().catch((error) => setStatus(String(error?.message ?? error), 'bad'))
})
$('test').addEventListener('click', () => {
  test().catch((error) => setStatus(String(error?.message ?? error), 'bad'))
})
$('sync').addEventListener('click', () => {
  syncNow().catch((error) => setStatus(String(error?.message ?? error), 'bad'))
})

load().catch((error) => setStatus(String(error?.message ?? error), 'bad'))
setInterval(() => {
  storageGet(['lastPollAt', 'lastError']).then((stored) => renderRuntime(stored.lastPollAt, stored.lastError)).catch(() => {})
}, 2500)
