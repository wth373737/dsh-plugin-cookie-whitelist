/**
 * Build the two unpacked extensions from one source tree.
 *
 * Chromium (Chrome/Edge) uses Manifest V3 + a service worker; Firefox uses
 * Manifest V2 + a persistent background page. Both share background.js and
 * the options page. No bundler and no runtime dependencies.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'extension-src')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const files = [
  'background.js',
  'options.html',
  'options.js',
  'options.css',
  'icon.svg',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
]
const icons = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
}

const description =
  'Send cookies for approved domains from this browser to the local DSH Cookie Whitelist plugin. Local 127.0.0.1 only; no telemetry.'

const chromium = {
  manifest_version: 3,
  name: 'DSH Cookie Whitelist Bridge',
  version,
  description,
  minimum_chrome_version: '116',
  permissions: ['cookies', 'storage', 'alarms'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'background.js' },
  icons,
  action: {
    default_title: 'DSH Cookie Whitelist',
    default_icon: { 16: icons[16], 32: icons[32] },
  },
  options_ui: { page: 'options.html', open_in_tab: true },
}

const firefox = {
  manifest_version: 2,
  name: 'DSH Cookie Whitelist Bridge',
  version,
  description,
  permissions: ['cookies', 'storage', 'alarms', '<all_urls>'],
  background: { scripts: ['background.js'], persistent: true },
  icons,
  browser_action: {
    default_title: 'DSH Cookie Whitelist',
    default_icon: { 16: icons[16], 32: icons[32] },
  },
  options_ui: { page: 'options.html', open_in_tab: true },
  browser_specific_settings: {
    gecko: {
      id: 'cookie-whitelist@wth373737',
      strict_min_version: '115.0',
    },
  },
}

for (const [name, manifest] of Object.entries({ chromium, firefox })) {
  const out = path.join(root, 'extension', name)
  await fs.rm(out, { recursive: true, force: true })
  await fs.mkdir(path.join(out, 'icons'), { recursive: true })
  for (const file of files) {
    await fs.copyFile(path.join(src, file), path.join(out, file))
  }
  await fs.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`built extension/${name}`)
}

