# PixelToolkit

Electron + Vue 3 + TypeScript + three.js desktop toolkit for pixel art. First tool: the Skeletal Animator.

- Architecture and build plan: `docs/PLAN.md`
- Coding rules (mandatory): `CodeGuide.md`
- Settings and API keys: `appSettings.config` (JSON, gitignored, created with defaults on first run)
- App data: `data/` (gitignored), beside `appSettings.config`
- Where both live: the project folder in dev; `%APPDATA%\PixelToolkit` in an installed build (never the install dir,
  which every update replaces; an older build's files there are copied over once), or the exe's folder for a portable
  build. `PT_DATA_ROOT` overrides the data folder.

## Commands

```bash
npm install          # also downloads the Electron binary (postinstall: install-electron)
npm run dev          # app with renderer HMR
npm run dev:debug    # same, plus CDP on 127.0.0.1:9222 (Playwright connectOverCDP)
npm run dev:testbed  # loads testbed.html instead of index.html (same as PT_TESTBED=1)
npm run typecheck    # node + web (vue-tsc) + scripts projects
npm run lint         # ESLint with the CodeGuide @stylistic rules; lint:fix autofixes
npm test             # every node test below (no Electron, no API calls, no generations spent)
npm run test:rig     # numeric checks for core/rig (also: npm run verify:rig)
npm run test:main    # main-process fs sandbox, session sweep and PixelLab client (test-main-fs), job service (test-jobs)
npm run test:docs    # documents / tabs / workspace stores against an in-memory window.api
npm run test:playback # playback and jobs stores (apply results, estimate, submit)
npm run fixtures     # pads assets/test_imgs into testbed/fixtures; estimates ONLY missing *.estimate.json (~0.1 gen each); -- --dry to skip calls
npm run build        # typecheck + electron-vite build to out/
npm run build:win    # NSIS installer via electron-builder
```

Screenshot endpoint (loopback; in dev, or a packaged build started with `PT_DEV_SCREENSHOT=1`):
`curl.exe -s -o shot.png "http://127.0.0.1:47321/screenshot?file=name.png"` also writes `.screenshots/name.png`.
Health check: `http://127.0.0.1:47321/health`. `PT_SCREENSHOT_PORT` changes the port.

The rig testbed page (`npm run dev:testbed`) exists in dev only: production builds contain `index.html` alone
(`PT_TESTBED=1` builds it too, e.g. for `electron-vite preview -- --testbed`).
