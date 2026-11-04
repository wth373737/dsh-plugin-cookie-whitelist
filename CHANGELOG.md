# Changelog

## 1.1.0 — 2026-11-04

- Added `cookie_browse action:"files"` to list Course Planner / Schedule / syllabus / PDF / Office candidates from the current page.
- Added `cookie_browse action:"read_file"` with whitelist-cookie downloads, HTML resource-wrapper link following, PDF text extraction via `pdfjs-dist`, page/character limits, 8 MB inline limit with user approval, and `keep:false` default (no retained file).
- System prompt and tool description now explicitly tell the agent to inspect Course Planner / Schedule / PDF files for test dates instead of stopping at page text.
- Added file-reader tests (text, PDF, HTML wrapper, size limit) and documented the new flow.

## 1.0.0 — 2026-11-04

- Initial release.
- Chromium Manifest V3 and Firefox Manifest V2 extensions generated from one source.
- Token-gated localhost receiver with Origin allowlist and rate limiting.
- Per-domain authorization requests with chat-native approval plus a settings-page pending queue.
- In-memory cookie vault with TTL, per-domain validation, and best-effort value zeroization.
- Read-only CDP browser: disposable incognito Chrome/Edge, per-navigation cookie injection, GET/HEAD/OPTIONS-only request interception, form-submit/popup blocking, click/snapshot/scroll/screenshot.
- Temporary interactive login fallback for Firefox/other browsers.
- Settings page with pairing, whitelist, requests, login, vault, and browser status.
- Tests: util/store/vault/receiver/tools smoke, real Chrome integration, Host registration simulation.

