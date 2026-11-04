/**
 * File download and text extraction for the read-only browser.
 *
 * Downloads use only cookies that the vault already holds for the target
 * host, so a redirect to a non-whitelisted host is fetched anonymously.
 * PDF text extraction is optional at runtime: if pdfjs-dist is missing the
 * caller receives a clear error instead of a broken tool.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assertInside, parseWebUrl, truncateText, urlHost } from './util.mjs'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_REDIRECTS = 6

export class FileTooLargeError extends Error {
  constructor(sizeBytes, limitBytes) {
    super(`file is ${sizeBytes} bytes, above the ${limitBytes} byte inline limit`)
    this.name = 'FileTooLargeError'
    this.code = 'FILE_TOO_LARGE'
    this.sizeBytes = sizeBytes
    this.limitBytes = limitBytes
  }
}

export function buildCookieHeader(vault, store, url) {
  try {
    const cookies = vault.getForUrl(url, store.listWhitelist())
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  } catch {
    return ''
  }
}

function filenameFromDisposition(value) {
  if (typeof value !== 'string') return ''
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(value)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      return star[1].trim().replace(/^"|"$/g, '')
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value)
  return plain ? plain[1].trim() : ''
}

function safeFilename(name, fallback = 'download') {
  const base = String(name || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  return base === '' ? fallback : base
}

function fallbackFilename(url) {
  try {
    const parsed = new URL(url)
    const base = path.basename(parsed.pathname)
    return safeFilename(base || 'download')
  } catch {
    return 'download'
  }
}

/**
 * Fetch one file, following redirects while rebuilding the Cookie header per
 * hop. Only hosts the vault has a cookie for receive cookies.
 */
export async function fetchWebFile({ url, vault, store, maxBytes = 8 * 1024 * 1024, signal } = {}) {
  let current = String(url || '')
  let lastError = null
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const parsed = parseWebUrl(current)
    if (parsed === null) throw new Error('only http(s) file URLs without credentials are allowed')
    const headers = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
    }
    const cookieHeader = buildCookieHeader(vault, store, current)
    if (cookieHeader !== '') headers.Cookie = cookieHeader
    let response
    try {
      response = await fetch(current, { headers, redirect: 'manual', signal })
    } catch (error) {
      lastError = error
      throw error
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`redirect ${response.status} without a location`)
      current = new URL(location, current).toString()
      continue
    }
    if (!response.ok) {
      throw new Error(`file request failed with HTTP ${response.status}`)
    }
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new FileTooLargeError(contentLength, maxBytes)
    }
    const chunks = []
    let total = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new FileTooLargeError(total, maxBytes)
          }
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock?.()
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer())
      total = buffer.length
      if (total > maxBytes) throw new FileTooLargeError(total, maxBytes)
      chunks.push(buffer)
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase()
    const filename = safeFilename(
      filenameFromDisposition(response.headers.get('content-disposition')) || fallbackFilename(current),
    )
    return {
      bytes: Buffer.concat(chunks),
      size: total,
      contentType,
      filename,
      finalUrl: current,
      status: response.status,
    }
  }
  throw lastError ?? new Error('too many redirects')
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
export function classifyFile({ contentType = '', filename = '', url = '' }) {
  const ext = (() => {
    const match = String(filename || url).split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i)
    return match ? match[1].toLowerCase() : ''
  })()
  if (contentType.includes('pdf') || ext === 'pdf') return 'pdf'
  if (contentType.startsWith('text/') || /json|xml|csv|javascript/.test(contentType)) return 'text'
  if (['txt', 'csv', 'tsv', 'md', 'json', 'xml', 'html', 'htm', 'log', 'yaml', 'yml'].includes(ext)) return 'text'
  if (contentType.startsWith('image/')) return 'image'
  if (/word|officedocument|excel|powerpoint|msword/.test(contentType) || ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'].includes(ext)) {
    return 'office'
  }
  return 'binary'
}

export function decodeText(bytes, contentType = '') {
  const charsetMatch = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType)
  const charset = charsetMatch ? charsetMatch[1].trim() : 'utf-8'
  let text = ''
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
  return text.replace(/^\uFEFF/, '')
}

/** Extract text from a PDF with pdfjs-dist, capped by pages and characters. */
export async function extractPdfText(bytes, { maxPages = 10, maxChars = 200_000 } = {}) {
  let pdfjs
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch (error) {
    throw new Error(`PDF text extractor is unavailable (pdfjs-dist): ${error?.message ?? error}`)
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  })
  try {
    const doc = await task.promise
    const pageCount = doc.numPages
    const limit = Math.max(1, Math.min(pageCount, Number(maxPages) || 10))
    const pages = []
    let total = 0
    let truncated = limit < pageCount
    for (let number = 1; number <= limit; number += 1) {
      const page = await doc.getPage(number)
      const content = await page.getTextContent()
      let pageText = ''
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        pageText += item.str
        pageText += item.hasEOL ? '\n' : ' '
      }
      pageText = pageText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
      if (total + pageText.length > maxChars) {
        pageText = pageText.slice(0, Math.max(0, maxChars - total))
        truncated = true
      }
      total += pageText.length
      pages.push({ page: number, text: pageText })
      if (total >= maxChars) {
        truncated = true
        break
      }
    }
    const text = pages.map((page) => page.text).join('\n\n').trim()
    return {
      pageCount,
      pages,
      text,
      truncated,
      empty: text.length === 0,
    }
  } finally {
    await task.destroy().catch(() => {})
  }
}

export function extractFileLinks(html, baseUrl = '') {
  const rows = []
  const seen = new Set()
  const re = /(?:href|src)\s*=\s*["']([^"']+)["']/gi
  let match
  while ((match = re.exec(String(html ?? ''))) !== null) {
    const raw = match[1].replace(/&amp;/g, '&').trim()
    if (raw === '' || /^(?:data|javascript|mailto|tel):/i.test(raw)) continue
    let url
    try {
      url = new URL(raw, baseUrl || undefined).toString()
    } catch {
      continue
    }
    const parsed = parseWebUrl(url)
    if (parsed === null || seen.has(url)) continue
    const pathName = parsed.pathname.toLowerCase()
    const fileExt = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|zip|rar|7z|odt|ods|odp)(?:$|[?#])/i
    if (!fileExt.test(pathName)) continue
    seen.add(url)
    rows.push({ url, label: decodeURIComponent(pathName.split('/').pop() || 'file').slice(0, 180) })
    if (rows.length >= 30) break
  }
  return rows
}
export async function writeDownload(dataDir, filename, bytes) {
  const dir = path.join(dataDir, 'downloads')
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, `${Date.now()}-${safeFilename(filename, 'download')}`)
  if (!assertInside(dataDir, target)) throw new Error('download target escapes the data directory')
  await fs.writeFile(target, bytes)
  return target
}

/**
 * Download + classify + extract one URL.
 * @returns {Promise<object>} metadata and extracted text; never cookie values.
 */
export async function readFileFromUrl({
  url,
  vault,
  store,
  dataDir,
  maxBytes = 8 * 1024 * 1024,
  maxPages = 10,
  maxChars = 200_000,
  keep = false,
  signal,
  depth = 0,
} = {}) {
  const file = await fetchWebFile({ url, vault, store, maxBytes, signal })
  const kind = classifyFile({ contentType: file.contentType, filename: file.filename, url: file.finalUrl })
  const result = {
    kind,
    url: file.finalUrl,
    requestedUrl: String(url),
    filename: file.filename,
    contentType: file.contentType,
    sizeBytes: file.size,
    savedPath: '',
    text: '',
  }
  if (kind === 'pdf') {
    const extracted = await extractPdfText(file.bytes, { maxPages, maxChars })
    result.pageCount = extracted.pageCount
    result.pages = extracted.pages
    result.text = extracted.text
    result.truncated = extracted.truncated
    if (extracted.empty) result.note = 'The PDF has no extractable text layer; it may be scanned or image-only.'
  } else if (kind === 'text') {
    const text = decodeText(file.bytes, file.contentType)
    result.text = truncateText(text, maxChars)
    result.truncated = text.length > maxChars
  } else if (kind === 'office' || kind === 'binary' || kind === 'image') {
    result.note = 'This format has no built-in text extractor; the bytes can be saved for the user or another reader.'
  }

  // Moodle resource pages are sometimes an HTML wrapper around the real file.
  // If exactly one file link is present, follow it automatically (one hop).
  if (kind === 'text' && String(file.contentType).includes('html') && depth < 1) {
    const html = decodeText(file.bytes, file.contentType)
    result.text = truncateText(htmlToText(html), maxChars)
    const candidates = extractFileLinks(html, file.finalUrl)
    result.fileCandidates = candidates
    const preferred = candidates.find((candidate) =>
      /course.?planner|planner|schedule|syllabus|teaching.?plan/i.test(`${candidate.label} ${candidate.url}`),
    ) || null
    if (preferred) {
      const nested = await readFileFromUrl({
        url: preferred.url,
        vault,
        store,
        dataDir,
        maxBytes,
        maxPages,
        maxChars,
        keep,
        signal,
        depth: depth + 1,
      })
      nested.via = { resourcePage: file.finalUrl, link: preferred.url }
      return nested
    }
    if (candidates.length > 1) {
      result.note = 'This HTML resource page links to several files; choose a candidate and call read_file on its url.'
    }
  }

  if (keep) result.savedPath = await writeDownload(dataDir, file.filename, file.bytes)
  return result
}





