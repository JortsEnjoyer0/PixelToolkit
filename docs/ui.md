# UI building blocks

Read before building or changing any UI: styling, shared controls, the shell, dialogs, toasts, shortcuts, focus. Skel
Anim panels and key bindings: [skelanim/skelanim.md](skelanim/skelanim.md). Startup, services table, adding a tool:
[architecture.md](architecture.md).

## Theme and CSS

`bootstrap.ts` imports the global sheets of `src/renderer/src/styles/` in this order (app and testbed): `theme.css`
(all tokens on `:root`, dark only), `base.css` (reset; `body` is `user-select: none`, inputs and contenteditable opt
back in; `:focus-visible` ring only; scrollbars; `.pixelated`), `controls.css` (controls), `utilities.css` (helpers).

- **Generic styling lives in `styles/`.** `<style scoped>` only for layout specific to one component (`NavBar`, the
  tool panes), built from tokens. `SettingsDialog.vue` has no style block: the template for new form dialogs.
- **Never hard-code a colour in a `.vue` file** (only the dev page `testbed/TestbedApp.vue` does): add a token, or
  re-point one locally (`FrameThumb.vue` sets `--checker-a/-b` to `--thumb-checker-a/-b`). Canvas and three.js colours
  are TS constants (`editor/*`, `tools/skelanim/frametrack/thumbDraw.ts`, `OPENPOSE_COLORS` in `core/rig/coco.ts`).

### Tokens (`theme.css`)
- Look: dark "night" theme with a very subtle blue bias. Surfaces are near-black leaning blue; hover, active, inactive
  selection and tree-guide overlays are `rgba(150, 180, 255, …)`; focused selection and menu hover tint the accent
  `#4c8dff`. Keep new colours in that family.
- Surfaces `--bg-0` (viewport, wells, inputs) to `--bg-4` (menus, hovered controls); `--bg-1` is the app background and
  matches `backgroundColor` in `src/main/index.ts` (change both). Overlays `--bg-hover`, `--bg-active`, `--bg-overlay`
  (modal backdrop). Borders `--border`, `--border-strong`, `--border-subtle`.
- Text `--text`, `--text-dim`, `--text-faint`, `--text-on-accent`. Accent `--accent` (`-hover`, `-active`, `-dim`,
  `-muted`), `--focus-ring`. Status `--danger|success|warning`, each with `-dim` (tint) and `-text` (readable on dark);
  `--danger-bg` / `--warning-bg` for bubbles over content.
- Scales: `--font-size-xs..xxl` (11–24 px, body 13), `--space-1..6` (4–32 px), `--radius` (controls),
  `--radius-popup` (dialogs), `--shadow-*`, `--speed-*` + `--ease`. Sizes: `--control-height` (28, `-sm` 22),
  `--toolbar-height`, `--tabbar-height`, `--navbar-width`, `--panel-width`, `--row-height`, `--form-label-width`. Per
  component: `--control-*`, `--input-*`, `--selection-bg(-inactive)`, `--menu-*`, `--tooltip-*`, `--toast-bg`, …
- Z layers, low to high: `--z-base`, `-raised`, `-sticky`, `-dropdown`, `-overlay`, `-modal`, `-popover`, `-toast`,
  `-tooltip`, `-mouse-notify`. Layer with these; a raw `z-index: 1` only lifts a focused item inside a group.

### Classes
`controls.css` (~1500 lines) opens with a comment listing its vocabulary by family: read that, not the file. Missing
from it: `.badge-pill`, `.form-label.is-top` (beside a textarea), `.btn-icon.has-label`, `.toolbar-label`.
- States: `.is-active` or `aria-pressed="true"` (toggled button, active tab / menu item), `.is-loading` (content hidden
  under `.btn-spinner`), `.btn-ghost.is-danger` (red on hover), `.is-invalid` or `aria-invalid="true"` (inputs).
- `.list-row.is-selected` is a faint tint, accent while the `.list` has focus; `.is-focused` is the keyboard-cursor
  ring. `.tree-row` indents by `style="--depth: n"`; `.range` fills by `--fill`; `.input-affix` by `--affix-count`.
- `.form-grid` = label column + control; a `.form-hint` / `.form-error` in the grid starts in the control column;
  `.form-span` spans both. Transparent images sit on `.checker`.
- `utilities.css` (no index): flex (`.row`, `.col`, `.flex-1`, `.min-w-0`, `.items-*`, `.justify-*`, `.ml-auto`),
  spacing (`.gap-0..5`, `.p-*`, `.px-*`, `.py-*`, `.mt-*`, `.mb-*`), sizing (`.w-full`, `.fill`, `.abs-fill`,
  `.scroll-y`), text (`.text-xs..lg`, `.text-dim`, `.text-faint`, `.text-<status>`, `.text-mono`, `.tabular`,
  `.truncate`, `.break-anywhere`, `.select-text`), visibility (`.hidden`, `.invisible`, `.pointer-none`, `.sr-only`).

## Common components

In `src/renderer/src/components/common/`. Icons are Lucide (`@lucide/vue`): pass the component, not a name. `types.ts`
holds `ButtonVariant`, `ControlSize` (sm 22, md 28, lg 32 px) and `SelectOption`.

| Component | Use | Notable props and behaviour |
|---|---|---|
| `IconButton` | Every icon button | `icon`, `tooltip` (also the aria-label), `shortcut` (key cap in the tooltip), `active` (toggle), `loading` (spinner, blocks clicks), `variant` (ghost default), `dangerHover`, `label`, `size`. Never takes focus on press |
| `NumberSlider` | Numeric values | `min`, `max`, `step`, `precision`. `:slider="false"` = field only. `wheel` = mouse wheel steps (Shift ×10, Ctrl ignored). `update:modelValue` is live, `commit` fires once per finished edit. Clamps and snaps to `step`; Escape reverts without closing a dialog |
| `Select` | Styled native select, generic over string or number | Options `{ value, label, disabled? }` or plain values; the model keeps its type; a missing value shows `placeholder`. Controlled |
| `Checkbox` | Native checkbox + label | `label` or slot, `indeterminate`. Controlled: reverts if the parent rejects the value |
| `SecretInput` | API keys | `stored` (field starts empty, "saved" placeholder), `v-model:cleared` (removal). Patch rule in its header |
| `Splitter` | Resize handle between panels | `v-model:width` live, `commit` on release (persist then). `side` left (default) / right / top / bottom, `min` 120, `max` 800, `defaultWidth` (double-click resets). Arrows ±16 px (Shift ±64) |
| `Toolbar`, `ToolbarSeparator`, `ToolbarSpacer`, `Spinner` | Control strips; busy indicator | Toolbar: `vertical`, `position="bottom"`, `plain`, `label`. Spinner: `size`, `label` |
| `DialogFrame` | Chrome for every dialog | `title`, `icon`, `iconTone`, `size` (sm/default/md/lg = 380/440/520/640 px), `closable` (× emits `close`). Default slot = scrolling body; `#footer` slot = buttons |
| `ConfirmDialog`, `PromptDialog`, `ChoiceDialog` | Built-in dialog views | Rendered by `DialogHost`; never used directly |

**v-tooltip** (`tooltip.ts`, registered globally by `bootstrap.ts`): one shared element `#ptk-tooltip`, nothing to mount.
- Value: `'text'`, `{ text, shortcut?, placement?, delay? }` or falsy; `v-tooltip.right` etc. (default bottom; flips, clamps).
- Shows after 500 ms of hover, at once while "warm" (another is visible or hid < 350 ms ago), on keyboard focus only
  for `:focus-visible`. Hides on pointerdown, wheel, scroll, keydown, blur, resize; overlays call `hideTooltip()`.
- Bound to pointer events, which disabled buttons still get: a disabled control keeps its tooltip to say why.

**Hosts.** Each global overlay is a state-only service in `services/` (callable from stores and plain TS) plus a host
that `App.vue` mounts once: `dialogs.ts` → `DialogHost`; `toasts.ts` → `ToastHost` (bottom right); `mouseNotify.ts` →
`MouseNotifyHost`; `contextMenu.ts` → `ContextMenuHost`. `contextMenu.open(eventOrPoint, items)` takes `MenuItem`s
(`label`, `icon?`, `shortcut?`, `disabled?`, `danger?`, `action`) and `SEPARATOR`; for a dropdown under a button pass
`{ x: rect.left, y: rect.bottom + 2 }` (`ControlPanel.vue`).

## Shell

- `App.vue` (kept-alive tool, hosts, startup), `tools/registry.ts`, adding a tool: [architecture.md](architecture.md).
- `components/shell/NavBar.vue`: one icon-over-label button per `TOOLS` entry (`v-model` = active tool id, accent bar on
  the active one), Settings pinned at the bottom. Hidden tools stay mounted, and so do their shortcut registrations.
- `components/shell/openSettings.ts`: `openSettings()` = `dialogs.open(SettingsDialog)`, resolving `true` after a save;
  a second call while open returns the same promise. Called by the NavBar cog and the global `Ctrl+,` (`App.vue`).
- `SettingsDialog.vue`: groups PixelLab (key, base URL checked with `checkedBase` from `@shared/pixellab`, free "Check
  balance" of the saved key), AI providers, Application (data folder, autosave, undo limit, default fps), Editor (fly
  speed, default display toggles). Saves one `SettingsPatch` via `useSettingsStore().save`; a failed save stays open
  with the error in `.dialog-footer-start`; a changed data folder shows a "Restart required" toast.

## Interaction conventions

### Focus zones (`services/focusZone.ts`) and buttons
- Zones: `explorer`, `tabs`, `panel`, `editor`, `frametrack` (`ZONES`; new zone names go there). Tag each zone's root
  `data-zone="…"`. The zone follows the last `pointerdown` or `focusin` (captured on the document, so clicks on
  non-focusable elements and `mousedown.prevent` buttons count); outside every zone (nav bar, dialogs) it is `null`.
- Overlays that must not take the zone carry `data-zone-ignore` (context menu, toasts). `DialogHost` restores the zone
  after the last dialog closes; `focusZone.set()` switches it from code.
- Toolbar, nav and tab-close buttons use `@mousedown.prevent`, so a click never moves keyboard focus off the editor or a
  field. `IconButton` does it already; add it to raw `<button>`s in strips. Toggles pass `active` (`.is-active`,
  `aria-pressed`). Dialogs and the context menu give focus back to the element that had it before they opened.

### Shortcuts (`services/shortcuts.ts`)
- `shortcuts.register(scope, combo, handler, opts)` returns the unregister function (call it on unmount). Scope is a zone
  or `'global'`; combos are case-insensitive, modifiers in any order: `'ctrl+shift+z'`, `'delete'`, `'left'`.
- Routing (one window `keydown` listener): current-zone handlers first, then global, newest registration first in each
  group. Returning `false` declines (next handler, finally the browser default); the first that accepts gets
  `preventDefault()` + `stopPropagation()`. Nothing fires while a modal dialog or the context menu is open, or when a
  component already called `preventDefault()` on the key.
- Text-input exemption: keys from text inputs, textareas and contenteditable are ignored unless `allowInInputs` (only
  Ctrl+S). Plain arrows stay with targets that own them (text fields, range inputs, selects).
- `blockWhileInteracting` skips the handler while the editor drags: undo/redo, and Left/Right because a new target would
  cancel the drag. `EditorPane.vue` sets both `shortcuts.setInteracting` and `editorInteracting`
  (`services/editorState.ts`; `undoRedo` in `stores/tabs.ts` checks it too). `noRepeat` ignores auto-repeat (Ctrl+S).
- **An instance that may not be current must check and return `false`**: kept-alive tools, per-doc components
  (`isCurrent()` in `FrameTrack.vue`). Keys meant for a focused button are declined too (`fromButton` in `ExplorerPanel.vue`).
- The editor's own keys (WASD / Space / C fly, Escape cancels a drag) live on its container in `editor/EditorViewport.ts`.
- Text fields commit on blur: call `blurTextField()` before reading `dirty`, saving or switching the active doc. For
  one commit per edit (Enter or blur; Escape reverts) reuse `tools/skelanim/panel/CommitField.vue`.

### Feedback: mouse notes, toasts or inline
| Use | When | Examples |
|---|---|---|
| `mouseNotify(text)` | Instant confirmation of a user action, at the cursor (keyboard actions too); ~1.1 s, not clickable, max 4 | "Undo Rotate Left Forearm", "Nothing to redo", "Saved", "Auto-saved" |
| `toasts.push({ kind, title, message?, action?, timeoutMs? })` | Outcome of async work, or a problem the user must read; one optional `action: { label, run }`. Lives 4 s (`info`, `success`), 6 s (`warning`), 8 s (`error`); `timeoutMs: 0` = sticky; max 5; hover pauses | Generation finished or failed, "Restart required", warnings with details |
| Inline `.form-error` / `.notice` | Validation and errors that belong to a form or panel | Settings base URL, failed save inside a dialog |

### Dialogs (`services/dialogs.ts`)
- Promise-based; dialogs stack, only the top one is live. `confirm({ title, message, detail?, danger?, okLabel?,
  cancelLabel?, checkbox? })` → `{ ok, checked }`. `danger` (red OK, warning icon) for destructive actions; the OK
  label is the verb ("Delete", "Discard", "Generate").
- `prompt({ title, message?, value?, placeholder?, okLabel?, validate? })` → `string | null`; a `validate` message
  disables OK. `choice({ title, message, detail?, buttons, cancelId })` → button id; buttons left to right, e.g. Save /
  Don't Save (`kind: 'danger'`) / Cancel; the first `primary` takes Enter.
- `dialogs.open(Component, props)` → emitted value, or `undefined` when dismissed. The component renders `<DialogFrame>`
  and emits `resolve(value)` or `cancel`. Wrap it in an opener (`openSettings`, `openCharacterDialog` in
  `tools/skelanim/explorer/characterDialog.ts`). One holding edits asks before discarding: it handles `@close` and
  Escape on its `<DialogFrame>` itself (`requestClose` in `tools/skelanim/CharacterDialog.vue`).
- Keys: Enter clicks `[data-dialog-primary]` unless focus is on a button, textarea, select, link or contenteditable;
  Escape dismisses; Tab is trapped; first focus `[data-autofocus]`. Keys already `preventDefault()`ed are skipped: a
  field reverting on Escape consumes it only when it has something to revert (NumberSlider, CommitField). Backdrop
  click dismisses built-ins only. Footer: right-aligned, primary first; `.dialog-footer-start` for left content.

### Errors (`services/errors.ts`)
- `installGlobalErrorHandling` (`bootstrap.ts`) sends Vue errors, unhandled rejections and uncaught errors to
  `reportError`. Let unexpected failures propagate (`CodeGuide.md`). Catch locally only to handle an error
  specifically: keep a dialog open with an inline message, warn instead, retry.
- `reportError(e, title)`: logs and toasts (same message within 2 s once); use it in the `.catch` of fire-and-forget
  work, titled like `Could not save "Walk"`. `errorMessage(e)`: user-facing text of anything thrown (no IPC prefix).

### Labels and text
- **Undo labels** are Title Case "Verb Object" naming what changed: `Rotate Left Forearm`, `Move Hips`, `Change Pitch`,
  `Toggle Send Depth`, `Estimate Skeleton`; undo/redo show them as mouse notes ("Undo …"). Bone names come from
  `HUMAN_NAMES` (`core/rig/rigDef.ts`), COCO points from `humanLabel` (`core/rig/coco.ts`). Continuous edits apply on
  NumberSlider's `update:modelValue` with a `mergeKey` (`ApplyOptions`) and call `doc.history.seal()` on `commit`.
- **Menu items**: Title Case, `…` when they open a dialog ("Edit Character…"); `shortcut` is display only.
- **Tooltips**: short, usually sentence case; the shortcut goes in `shortcut`, not the text. A toggle names its feature
  or states the mode and what a click does ("Gizmo space: world (click for local)"). A disabled control says why
  ("New Animation (select a character first)").
- **Messages** put entity names in double quotes; error titles start with "Could not …".
