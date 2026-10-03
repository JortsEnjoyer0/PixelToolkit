# editor/

The three.js pose editor. Read `docs/skelanim/rig.md` and the Editor part of `docs/skelanim/skelanim.md` "UI" first.

- **Store-free and non-reactive, on purpose:** import only three, `core/` and `@shared`. The testbed drives the same
  viewport with no IPC or data, three.js objects must never sit in Vue proxies, and `EditorPane.vue` is the only app
  adapter (`IEditorViewport`, `DocSource` and the events in `editor/types.ts`). No `ref()` / `reactive()` here.
- **One commit per gesture:** drags edit a scratch pose; `commitPose` / `commitCoco` run once on pointerup. A doc swap,
  target change or content refresh cancels a running drag (keep that for new gestures).
- **On-demand rendering:** `invalidate()` after every visible change, never a free-running loop. Draw order: floor and
  image plane, `clearDepth()`, ghosts (each ending in a depth reset), skeleton, OpenPose overlay, gizmo.
- **Picking:** gestures go through the capture-phase arbiter in `EditorViewport` (gizmo axis, then COCO handle or joint
  / bone, then orbit). Add a new gesture there, never as a competing listener.
- **Dispose** what you create (each view's `dispose()`, `forgetDocument()`, the viewport on unmount and HMR). Check
  visual changes with `npm run dev:testbed` (fixtures, no API calls).
