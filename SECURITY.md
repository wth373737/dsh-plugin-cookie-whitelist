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
| Downloaded files | Not written by default; $DSH_HOME/cookie-whitelist/downloads/ only with `keep: true` | Until the user deletes them |

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

1. **Tool schema**: `cookie_browse` has no fill/write action; only open/read/snapshot/click/scroll/screenshot/files/read_file/status/close.
2. **Injected page script**: captures and cancels `submit`; replaces `HTMLFormElement.prototype.submit` and `requestSubmit`; replaces `window.open`; disables `navigator.sendBeacon`.
3. **Click validation**: clicking a submit-like control inside a form returns `form-submit-blocked` before dispatch.
4. **CDP `Fetch` interception**: any request whose method is not `GET`, `HEAD`, or `OPTIONS` is failed with `BlockedByClient`. When the top-level page is not whitelisted, the `Cookie` header is removed from every intercepted request.

This is a safety boundary for *the agent's tool surface*, not a sandbox against a malicious browser exploit. Page JavaScript still executes (needed to render modern sites); a browser 0-day is out of scope.

## File downloads and PDF text

`cookie_browse action:"read_file"` downloads a file with the same rule as navigation:

- Cookies are rebuilt per redirect hop from the vault; a redirect to a non-whitelisted host receives no cookies.
- The response is capped (`files.maxBytes`, default 8 MiB). A larger file produces `FILE_TOO_LARGE`; the tool asks the user through `approval` before retrying. The approval prompt names the file size and says the temporary copy is deleted after reading unless the user asks to keep it.
- The default is `keep: false`: bytes are parsed in memory and no file is written. `keep: true` writes to `$DSH_HOME/cookie-whitelist/downloads/` and returns the path; the user must ask for this first.
- PDF text extraction uses `pdfjs-dist` in the Host process with `isEvalSupported: false`. No PDF JavaScript is executed. HTML resource wrappers are parsed for file links; a candidate whose name/URL matches Course Planner, Schedule, Syllabus, or Teaching Plan is followed once. If several unrelated files exist, the tool returns `fileCandidates` instead of guessing.
- Text/HTML is truncated to `files.maxChars`; PDF pages to `files.maxPages`. Binary/Office files have no built-in text extractor and are not silently misread.
- Extracted text can contain personal data from the page; it is returned to the requesting agent and may be stored in the session log as tool output. Treat those values as user data.

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



