import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FileTooLargeError,
  classifyFile,
  extractFileLinks,
  extractPdfText,
  readFileFromUrl,
} from '../lib/file-reader.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const silent = { info() {}, warn() {}, error() {} }

function makePdf(text) {
  const safe = String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  const header = '%PDF-1.4\n'
  let body = ''
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(header + body))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(header + body)
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  return Buffer.from(`${header}${body}${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1')
}

function startServer() {
  const pdf = makePdf('Hello Test 1 from planner')
  const server = http.createServer((req, res) => {
    if (req.url === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('hello text file')
      return
    }
    if (req.url === '/pdf' || req.url === '/planner.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) })
      res.end(pdf)
      return
    }
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><a href="logo.png">logo</a><a href="planner.pdf">Course Planner</a><a href="notes.docx">Notes</a></body></html>')
      return
    }
    if (req.url === '/large') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '2048' })
      res.end('x'.repeat(2048))
      return
    }
    res.writeHead(404)
    res.end('missing')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

const dir = path.join(ROOT, `.tmp-files-${process.pid}-${Date.now()}`)
await fs.mkdir(dir, { recursive: true })
const { server, port } = await startServer()
const base = `http://127.0.0.1:${port}`
const vault = {
  getForUrl() {
    return [{ name: 'sid', value: 'test' }]
  },
}
const store = { listWhitelist: () => ['127.0.0.1'] }

try {
  assert.equal(classifyFile({ contentType: 'application/pdf', filename: 'a.pdf' }), 'pdf')
  assert.equal(classifyFile({ contentType: 'text/plain', filename: 'a.txt' }), 'text')
  assert.equal(classifyFile({ contentType: 'application/zip', filename: 'a.zip' }), 'binary')

  const links = extractFileLinks('<a href="planner.pdf">Course Planner</a><img src="logo.png"><a href="notes.docx">Notes</a>', base)
  assert.equal(links.length, 2)
  assert.equal(links.some((row) => row.label.includes('planner.pdf')), true)

  const pdfText = await extractPdfText(makePdf('Hello Test 1 from planner'), { maxPages: 1 })
  assert.equal(pdfText.pageCount, 1)
  assert.match(pdfText.text, /Hello Test 1 from planner/)

  const text = await readFileFromUrl({ url: `${base}/text`, vault, store, dataDir: dir, maxBytes: 1024 })
  assert.equal(text.kind, 'text')
  assert.equal(text.text, 'hello text file')

  const pdf = await readFileFromUrl({ url: `${base}/pdf`, vault, store, dataDir: dir, maxBytes: 100000 })
  assert.equal(pdf.kind, 'pdf')
  assert.match(pdf.text, /Hello Test 1 from planner/)

  const html = await readFileFromUrl({ url: `${base}/html`, vault, store, dataDir: dir, maxBytes: 100000 })
  assert.equal(html.kind, 'pdf')
  assert.match(html.text, /Hello Test 1 from planner/)
  assert.equal(html.via?.resourcePage, `${base}/html`)

  let tooLarge = null
  try {
    await readFileFromUrl({ url: `${base}/large`, vault, store, dataDir: dir, maxBytes: 1024 })
  } catch (error) {
    tooLarge = error
  }
  assert.ok(tooLarge instanceof FileTooLargeError)
  assert.equal(tooLarge.sizeBytes, 2048)

  const kept = await readFileFromUrl({ url: `${base}/text`, vault, store, dataDir: dir, maxBytes: 1024, keep: true })
  assert.ok(kept.savedPath)
  assert.equal(await fs.readFile(kept.savedPath, 'utf8'), 'hello text file')

  console.log('file-reader: ok')
} finally {
  server.close()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
