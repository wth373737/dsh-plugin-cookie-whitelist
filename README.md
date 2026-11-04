# dsh-plugin-cookie-whitelist

> Give the agent your login state **only** for domains you approve — with a browser extension, a localhost receiver, an in-memory vault, and a read-only CDP browser.

This plugin lets DeepSeek Harness read pages that need your browser session. Cookies are read inside Chrome, Edge, or Firefox by an extension, filtered to an approved domain list before they leave the browser, posted to `127.0.0.1` with a pairing token, and kept only in Host process memory. The agent then uses a disposable incognito Chrome/Edge instance that receives cookies for the current whitelisted domain only.

## At a glance

- **Extension side** — Chromium Manifest V3 and Firefox Manifest V2 share one `background.js`; the only network destination is `http://127.0.0.1:<port>`.
- **Host side** — token-gated receiver, per-domain authorization requests, in-memory vault with TTL, read-only browser, optional interactive login fallback, and a settings page.
- **Read-only by construction** — form submit, `requestSubmit`, `window.open`, and every non-`GET`/`HEAD`/`OPTIONS` request are blocked. There is no fill tool.
- **No cookie persistence** — values are never written to disk, logs, tool results, or the settings UI. The browser profile is disposable and incognito.

## Install

1. Install the DSH plugin (GitHub or `plugin_manager`).
2. Open **Settings → Cookie Whitelist**; copy the receiver URL and pairing token.
3. Load the extension:
   - Chrome/Edge: `chrome://extensions` → Developer mode → Load unpacked → `extension/chromium`.
   - Firefox: `about:debugging` → This Firefox → Load Temporary Add-on → `extension/firefox/manifest.json`.
4. Paste the URL and token into the extension options; click **Test connection**.
5. Add domains in the settings page, or let the agent call `cookie_authorize` and approve it in chat.

For browsers without a supported extension, use the settings page's **Temporary browser login** window: it opens a disposable incognito Chrome/Edge window, the user logs in by hand, and **Finish and capture** copies the domain's cookies into the vault.

## Tools

| Tool | Purpose |
| --- | --- |
| `cookie_whitelist_status` | Whitelist, pending requests, extension heartbeat, vault counts, browser state. Never returns values. |
| `cookie_authorize` | Ask the user to approve one domain; approval is a user action. |
| `cookie_sync` | Ask the extension to re-read approved domains; counts only. |
| `cookie_browse` | Read-only `open` / `read` / `snapshot` / `click` / `scroll` / `screenshot` / `status` / `close`. |

## Security model

- The receiver binds `127.0.0.1` only and requires the pairing token on every `/v1/*` call.
- A request whose `Origin` is an ordinary `http(s)` page is rejected; only extension origins and local header-bearing calls pass.
- Cookies are accepted only when the cookie's own `Domain` applies to the requested whitelisted domain; the Host re-filters every delivery.
- Before each navigation the browser jar is cleared, then only cookies whose domain matches the whitelisted target are injected.
- Non-whitelisted top-level pages have the `Cookie` header stripped from every intercepted request.
- The extension's `<all_urls>` permission is required by the cookies API; it has no content scripts, no telemetry, and no remote endpoint.

See [SECURITY.md](./SECURITY.md) and [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the full threat model.

## Known limits

- Some sites reject cloned sessions (device binding, risk controls); the mechanism is not a guarantee.
- CAPTCHA/2FA requires the user; the temporary login window is the fallback.
- Firefox needs a temporary or signed add-on; Chrome/Edge use developer-mode unpacked loading.
- Chrome/Edge forbid remote debugging on the default profile, so an isolated profile is used intentionally.
- Screenshots can contain personal data; if the `attachments` service is unavailable the PNG is written to the plugin's `shots/` directory.

## Development

```bash
node scripts/build-extensions.mjs
node test/smoke.mjs
node test/extension-sim.mjs
node test/browser.mjs       # requires Chrome/Edge; launches a disposable instance
node test/host-sim.mjs
```

## License

MIT. Original icons; no third-party runtime is bundled.

