# Changelog

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
