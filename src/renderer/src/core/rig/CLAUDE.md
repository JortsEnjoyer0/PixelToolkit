# core/rig

Read `docs/skelanim/rig.md` first: coordinates, the rig, calibration, projection, z_index and lifting.

- **Never break the exactness guarantees:**
  - FK∘calibrate reproduces the 18 NECK-forced COCO points to < 1e-6;
  - lift → calibrate → FK → project reproduces the 17 non-NECK estimate joints to < 1e-6 px.
- **Keep the exported names and signatures.** The editor, `docState.ts`, `model.ts`, `generate.ts`, the frame track,
  the testbed and `scripts/verify-rig.ts` all call them.
- **Keep the hot paths allocation-light.** `fk` and `cocoFromFk` run per frame and per thumbnail and allocate nothing
  when given `out` buffers; `projectPose` reuses a `createProjectScratch()` for FK. Do not add allocations to them.
- Stay framework-free: no Vue, stores or three.js.
- Run `npm run test:rig` after any change here. If you change behaviour, update `docs/skelanim/rig.md` in the same
  change.
