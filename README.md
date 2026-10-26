# Cozy Reader

A mobile-first, installable reading timer that pays AU$2 per hour by default. It is a static, vanilla HTML/CSS/JavaScript PWA: no account, backend, or dependency installation is required.

## Run locally

Serve `dist/` from a local HTTP server (service workers do not work from `file://`). For example, with Node installed:

```powershell
npx serve dist
```

Open the printed URL in a browser. For the most faithful iOS check, access the site over HTTPS on an iPhone and use Safari’s Share menu → **Add to Home Screen**.

## Behaviour and storage

- The source of truth is a persisted timestamp plus accumulated active milliseconds, never the display interval.
- Money is stored as a fixed-point numerator (`milliseconds × cents/hour`) rather than floating-point dollars, so sub-cent earnings carry forward exactly.
- The IndexedDB snapshot stores the balance, settings, and current session. If IndexedDB is unavailable, a localStorage fallback is used.
- Updating the hourly rate first settles an active time segment at its old rate; only later reading is charged at the new rate.

## PWA / offline test

1. Load the app once while online and wait for the service worker to install.
2. In browser developer tools, switch the network to Offline and reload. The application shell should still load.
3. Start a session, refresh or close/reopen the app, and confirm the timestamp-derived elapsed time remains accurate.

## GitHub Pages deployment

Publish the contents of `dist/` (not this repository root) via GitHub Pages. All asset, manifest, and service-worker paths are relative, so the PWA works under a repository subpath such as `https://account.github.io/repository/`.

GitHub Pages must be served over HTTPS for service-worker installation and PWA installability.
