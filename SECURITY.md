# Security model

## Assets

| Asset | Where it lives | Lifetime |
| --- | --- | --- |
| Cookie values | Host process memory only (`CookieVault`) | Vault TTL (default 120 min), explicit clear, plugin unload, or browser close |
| Pairing token | `$DSH_HOME/cookie-whitelist/pairing-token` | Until the plugin data directory is removed |
| Whitelist / authorization requests | `$DSH_HOME/cookie-whitelist/state.json` | Persistent |
| Browser profile | `$DSH_HOME/cookie-whitelist/cw-browser-*` with `--incognito` | Deleted on browser close; stale profiles older than 24h are removed on start |
| Temporary login profile | `$DSH_HOME/cookie-whitelist/login/<id>` with `--incognito` | Deleted on finish/cancel; stale profiles are removed on start |
| Screenshots | `attachments` store, or `$DSH_HOME/cookie-whitelist/shots/` if attachments are unavailable | Provider policy |

Cookie **names and values** are never written to `state.json`, never logged, never returned by tools, and never rendered in the settings page. Only domain, count, byte size, and timestamps are exposed.

## Trust boundaries

```text
browser extension  --token+Origin-checked HTTP-->  127.0.0.1 receiver
                                                         |
                                                   Host memory vault
                                                         |
                                          CDP (loopback, ephemeral port)
                                                         |
                                             disposable Chrome/Edge
```

1. **Browser extension**: sees the pairing token and cookies. It is the only component allowed to read cookie values. It reads only domains returned in tasks and filters a second time before sending.
2. **Local receiver**: authenticates with a constant-time comparison of the pairing token. It rejects any request whose `Origin` is a normal web origin, so a random website cannot use the user's browser as a confused deputy. Bodies are capped at 8 MiB; a simple per-IP rate limit (300/min) applies.
3. **Host vault**: pure memory. Before a bucket is replaced or cleared, values are overwritten best-effort. JavaScript strings are immutable, so this is not a cryptographic wipe.
4. **Read-only browser**: a separate, non-default `--user-data-dir` is required because Chrome/Edge refuse remote debugging on the default profile. The browser is launched with `--incognito`, `--disable-extensions`, no first run, and a loopback-only debugging port. It is killed and its profile deleted on close/dispose.
5. **Settings API**: same-origin only, requires the custom header `x-cookie-whitelist-ui: 1`, and checks `Origin` against the DSH web origin. The token is shown only through this route.

## Read-only enforcement

The plugin enforces read-only at four layers:

1. **Tool schema**: `cookie_browse` has no fill/write action; only open/read/snapshot/click/scroll/screenshot/status/close.
2. **Injected page script**: captures and cancels `submit`; replaces `HTMLFormElement.prototype.submit` and `requestSubmit`; replaces `window.open`; disables `navigator.sendBeacon`.
3. **Click validation**: clicking a submit-like control inside a form returns `form-submit-blocked` before dispatch.
4. **CDP `Fetch` interception**: any request whose method is not `GET`, `HEAD`, or `OPTIONS` is failed with `BlockedByClient`. When the top-level page is not whitelisted, the `Cookie` header is removed from every intercepted request.

This is a safety boundary for *the agent's tool surface*, not a sandbox against a malicious browser exploit. Page JavaScript still executes (needed to render modern sites); a browser 0-day is out of scope.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| A website calls the local receiver to steal cookies | Token + Origin allowlist; no CORS for web origins; header-only token |
| A website CSRF-posts the settings API | Custom header requirement + Origin check; no CORS preflight handling |
| A malicious extension/task asks for unrelated domains | Task contains only approved domains; extension filters cookie `Domain`; Host re-filters; `vault.put` rejects cookies outside the requested domain |
| Agent self-approves a domain | `cookie_authorize` only requests; approval comes from `approval` (user) or the settings page; policy `never` fails closed |
| Cookie leak to a non-whitelisted site | Jar cleared per navigation; `Cookie` header stripped when top-level host is not whitelisted; `getForUrl` returns `[]` |
| Cookie leakage through tool results/logs | Tools/status report counts only; no value fields; error messages do not include values |
| Browser profile persistence | `--incognito`, disposable profile, delete on close; stale cleanup |
| Prompt injection asks for cookie values | System prompt and tool descriptions forbid asking for or repeating values; tools never expose them |
| Local process reads the pairing token | Same-user local process can read the data dir; it still cannot read cookie values unless it can call the extension or the vault. Use OS file permissions / a dedicated user if this matters. |

## Permissions

The extension requests `cookies`, `storage`, `alarms`, and `<all_urls>`. `<all_urls>` is required by the cookies API to read cookies for arbitrary domains. The extension has no content scripts, no host-page injection, no remote endpoints, and no telemetry. It only reads cookies for domains in the current task and only posts to the configured `127.0.0.1` origin.

## Reporting

Open a GitHub issue at <https://github.com/wth373737/dsh-plugin-cookie-whitelist/issues> for security reports. Do not include real cookie values, tokens, or personal data in a report.
