# stores/

Pinia stores behind Skel Anim. Read `docs/skelanim/skelanim.md` first ("Documents" to "Estimate and generation flow").
`rectify.ts` is Img to PixelArt's (`docs/img2pixel/img2pixel.md`): a markRaw source in a shallowRef, no `data/` IO;
the rules below are Skel Anim's.

- **State:** immutable, copy-on-write: change it only via `doc.apply(label, producer)` (`core/docState.ts` producers);
  never mutate `doc.state.value` (frozen in dev and tests). DocHandles are `markRaw`: keep them in `shallowReactive`
  maps or plain variables. Reactive state in `job/*Core.ts` holds only ids and plain records.
- **Store cycles resolve lazily** (`doc/deps.ts`, `() => useXStore()` getters): a top-level `useXStore()` in a setup
  must not close a cycle. Keep each `*StoreApi` in `types.ts` satisfied (`use*Api()` is the compile check).
- **IO:** doc file IO runs in `doc.runIo((paths) => …)` with the paths it is given. Explorer ops touching open docs use
  `documents.runExclusive`; its op must not save or rename those docs. Only serialize / `plainCopy` output crosses IPC.
- **Drags:** `cancelEditorInteraction()` before an outside apply to the active doc; autosave uses `whenEditorIdle()`.
- **Images:** `doc.noteCreatedImage(uid)` before the apply that references a new file. GC (`doc/gc.ts`) deletes only
  exact non-live `<anim>.<uid>.png`; unacked job uids stay live; ack only after the result is saved. User deletes use
  `fs.trash`, never `fs.deleteFiles`. Tests: `npm run test:docs`, `npm run test:playback`.
