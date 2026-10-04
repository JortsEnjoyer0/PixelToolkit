# src/main

Electron main process. Read `docs/architecture.md` first, and `docs/pixellab.md` for anything touching PixelLab api or jobs.

- Renderer paths are data-root relative and are resolved only through `core/dataFs.ts` (`resolveChecked()`, or
  `resolveInside()` + `assertRealInside()`: lexical and realpath sandbox). Validate every IPC argument; the renderer is
  untrusted. New handlers go through `ipc/handle.ts` (sender check).
- Outside the data root, main reads or writes only a path the user picked in a native dialog (`ipc/images.ts`,
  `ipc/files.ts`; unpackaged builds also take the `PT_TEST_*` dialog hooks): never accept an absolute path from the
  renderer. `files.savePng` checks the image (`checkRgbaImage()`) before opening the dialog.
- PixelLab calls and job submit/cancel return `Result<T>` through `handleResult` and never reject across IPC. Other
  handlers (`handle`) reject with a user-facing `Error` message (the renderer toasts it).
- Logic goes into electron-free `core/` modules with injected deps, tested by `scripts/test-*.ts` (`npm run test:main`);
  `ipc/*` and `jobs.ts` stay thin glue.
- Writes use `atomicWrite()` and are non-recursive (`createDirs` only for `.ptk/` and `appSettings.config`), so a late
  write cannot resurrect a deleted folder. Images in the data root are never overwritten: new pixels get a new uid
  (`writeNewImage()`); `files.savePng` replaces only the file the user confirmed in the save dialog.
- A paid POST is journaled first and never resubmitted (an unknown outcome becomes a failed record): no POST retries.
- Secrets in `appSettings.config` never leave main: the renderer gets `SECRET_MASK`; never log or print keys.
