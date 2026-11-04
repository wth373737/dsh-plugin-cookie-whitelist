# Architecture

## Components

| File | Responsibility |
| --- | --- |
| `index.js` | Cordis Host entry; merges config, creates the service, registers the four tools. |
| `lib/service.mjs` | Lifecycle, settings API, pairing info, system prompt, agent status, temporary login orchestration. |
| `lib/store.mjs` | Durable non-secret state: whitelist, requests, extension heartbeat, stats, pairing token. |
| `lib/vault.mjs` | Memory-only cookie buckets, per-domain validation, TTL, CDP cookie projection. |
| `lib/receiver.mjs` | HTTP receiver on `127.0.0.1`; token and Origin checks; task/cookie protocol. |
| `lib/cdp.mjs` | Browser discovery, disposable Chromium launch, DevToolsActivePort parsing, WebSocket CDP client. |
| `lib/browser.mjs` | Read-only page operations and all interception layers. |
| `lib/login.mjs` | Visible incognito login window; capture cookies on finish. |
| `lib/tools.mjs` | Agent-facing tool definitions. |
| `client.js` | Settings page in the Harness Web UI. |
| `extension-src/` | Shared extension source; `scripts/build-extensions.mjs` emits `extension/chromium` and `extension/firefox`. |

## Extension protocol

All calls are to `http://127.0.0.1:<port>` and `/v1/*` requires the `x-cookie-whitelist-token` header.

### `GET /v1/tasks`

The extension polls; the Host returns zero or one task:

```json
{
  "ok": true,
  "tasks": [{ "id": "task_...", "domains": ["example.com"] }],
  "pollMs": 2000,
  "serverTime": 1700000000000
}
```

Only approved domains ever appear. A task is created from the in-memory sync queue (whitelist additions, approvals, manual sync, startup re-sync). If the extension does not deliver within 150 seconds, the task is requeued.

### `POST /v1/cookies`

```json
{
  "taskId": "task_...",
  "browser": "Chrome/Edge",
  "version": "1.0.0",
  "domains": {
    "example.com": [
      { "name": "sid", "value": "...", "domain": ".example.com", "path": "/", "secure": true, "httpOnly": true, "sameSite": "lax" }
    ]
  }
}
```

The Host:

1. verifies the task exists;
2. accepts a domain only if it is in the task (or still whitelisted);
3. calls `vault.put(domain, cookies)`, which re-checks each cookie's `Domain` against the requested domain;
4. marks the task complete and updates the heartbeat;
5. returns counts only (`accepted`, `dropped`, per-domain counts). Values are never echoed.

### `POST /v1/status` and `POST /v1/ping`

Heartbeat and connectivity checks. `status` records browser label, version, and an error string (never a cookie value). The settings page treats a heartbeat younger than 90 seconds as connected.

## Authorization flow

```text
agent: cookie_authorize { domain, reason }
  └─ store.createRequest()
       ├─ if an approval answerer is available:
       │    approval.request({ toolName: "cookie_authorize", displayReason })
       │      allowed-once → store.decideRequest(approve) → enqueue sync
       │      rejected     → store.decideRequest(reject)
       │      unavailable  → keep pending, return pending to the agent
       └─ settings page polls status:
            requests.approve/reject → store.decideRequest
```

`cookie_authorize` cannot call `store.decideRequest` except after `allowed-once`. The settings page is the only other caller; both paths share the same store method, so audit fields are identical.

## Read-only browser lifecycle

1. `ReadOnlyBrowser.ensure()` resolves Chrome → Edge (or `browser.executable`) and launches:
   `--headless=new --incognito --remote-debugging-port=0 --user-data-dir=<temp> --disable-extensions ...`.
2. Parses `<profile>/DevToolsActivePort`, fetches `/json/list`, connects the first page target over WebSocket.
3. Enables `Page`, `Runtime`, `Network`, `Fetch`; gets the main frame id; injects the read-only script; navigates `about:blank`.
4. For each `open`:
   - parse and validate the URL (http/https, no credentials);
   - `Network.clearBrowserCookies()`;
   - `vault.getForUrl(url, whitelist)` → `Network.setCookies()` (with per-cookie fallback);
   - `Page.navigate()`; wait for load or 30 s;
   - read title/URL and return an authenticated flag + injected count.
5. `read` evaluates a DOM clone that drops script/style/iframe/canvas, returns text and up to 300 links.
6. `snapshot` marks visible interactive elements with `data-cw-ref` and returns refs/text/bounds.
7. `click` re-queries the ref, rejects submit-like controls in forms, scrolls into view, clicks, waits for load.
8. `close` clears cookies, closes CDP, kills the browser, deletes the profile.

### Interception

`Fetch.requestPaused` runs for every request:

```text
if method not in {GET, HEAD, OPTIONS}: failRequest(BlockedByClient)
if resourceType == Document and frameId == mainFrame: navigationHost = host(url)
if not whitelisted(navigationHost): delete Cookie header
continueRequest()  // pass headers only when a header was actually removed
```

Important CDP detail: `Fetch.Headers` is an **array** of `{ name, value }`, while `Network.Headers` is a dictionary. Passing the dictionary to `Fetch.continueRequest` yields `Invalid parameters` and leaves the navigation paused. The code passes headers only when it strips a cookie, and converts to the array shape.

## Storage layout

```text
$DSH_HOME/cookie-whitelist/
├── state.json          # whitelist, requests, extension heartbeat, stats
├── pairing-token       # 32-byte URL-safe random token
├── cw-browser-*        # disposable read-only profiles (deleted on close)
├── login/<id>/         # disposable login profiles (deleted on finish/cancel)
└── shots/              # screenshots only when attachments is unavailable
```

No cookie values are in any of these files.

## Configuration

The patch supplies defaults; `dataDir` and `browser.executable` are the only environment-specific ones users normally change. `server.port` is a preference: the receiver tries the configured port, then up to `+9`, then an ephemeral port, and the settings page shows the actual value.

## Failure behavior

- Receiver bind failure: the service logs and the settings page shows the receiver as stopped; tools still start and report the failure.
- Browser missing: `cookie_browse` returns an explicit error; other tools work.
- Extension asleep/offline: `cookie_sync` returns `extensionConnected: false` or `completed: false`, not a fake success.
- Login window closed by the user: `login.finish` fails with a clear message and cleans up.
- State write failure: logged; the in-memory state remains usable for the session.
