// Explorer entity operations (PLAN §6 Explorer → Creation / Delete / Rescan, §3 on-disk model): create, rename,
// duplicate, delete, repair and reveal folders, characters and animations through window.api.fs. Each filesystem
// change runs on the explorer store's serial op queue; changes that touch open docs go through
// documents.runExclusive (or documents.renameAnimation) so tabs, doc IO queues and pending jobs follow.
import {
  animImageFileName, animJsonRel, animNameFromRel, baseImageFileName, charJsonRel, charNameFromRel, charRelFromAnimRel, joinRel,
  parentRel, parseImageFileName
} from '@shared/dataPaths';
import type { ScanNode } from '@shared/api';
import { uid } from '@shared/uid';
import {
  createAnimationMeta, createCharacterMeta, parseAnimation, serializeAnimation, serializeCharacter, type AnimationMeta
} from '../../../core/model';
import { metaFromState, referencedImages, stateFromMeta, withReferenceImage } from '../../../core/docState';
import { entityNamesInListing, uniqueName, validateName } from '../../../core/util/naming';
import { dialogs } from '../../../services/dialogs';
import { reportError } from '../../../services/errors';
import { toasts } from '../../../services/toasts';
import { useDocumentsStore } from '../../../stores/documents';
import { findScanNode, isAtOrBelow, remapRel, useExplorerStore } from '../../../stores/explorer';
import { useJobsStore } from '../../../stores/jobs';
import { useSettingsStore } from '../../../stores/settings';
import { useTabsStore } from '../../../stores/tabs';
import type { DocHandle, ExplorerNode } from '../../../stores/types';
import { openCharacterDialog } from './characterDialog';

const api = (): typeof window.api => window.api;

const KIND_LABEL: Record<ExplorerNode['kind'], string> = {
  folder: 'folder', character: 'character', animation: 'animation', brokenCharacter: 'character'
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Names already used in a dir (dirs and json basenames), read from disk now. */
async function namesIn(dirRel: string): Promise<string[]> {
  return entityNamesInListing(await api().fs.listDir(dirRel));
}

// ---------- open / reveal ----------

/** Open or activate the tab of an animation (load errors become a toast). */
export async function openAnimation(rel: string): Promise<void> {
  try {
    await useTabsStore().open(rel);
  } catch (e) {
    reportError(e, 'Could not open the animation');
  }
}

/** Enter / double-click: folder toggles, character opens its dialog, animation opens its tab, broken repairs. */
export async function activateNode(node: ExplorerNode): Promise<void> {
  const explorer = useExplorerStore();
  switch (node.kind) {
    case 'folder':
      explorer.toggle(node.rel);
      return;
    case 'character':
      await editCharacter(node.rel);
      return;
    case 'animation':
      await openAnimation(node.rel);
      return;
    default:
      await repairNode(node);
  }
}

export async function editCharacter(charRel: string): Promise<void> {
  await openCharacterDialog(charRel);
}

/** Show the entity in Windows Explorer (a broken character: its json). */
export async function revealNode(node: ExplorerNode | null): Promise<void> {
  const rel = node === null ? '' : node.kind === 'brokenCharacter' ? charJsonRel(node.rel) : node.rel;
  await api().app.revealInExplorer(rel);
}

// ---------- create ----------

/** New Folder (always at the root): unique default name, mkdir, then inline rename. */
export async function newFolder(): Promise<void> {
  const explorer = useExplorerStore();
  const rel = await explorer.runOp(async () => {
    const name = uniqueName('New Folder', await namesIn(''));
    await api().fs.mkdir(name);
    await explorer.refresh();
    return name;
  });
  await explorer.beginRename(rel);
}

/**
 * New Character in the target folder (the selected folder or the folder of the selected item; else the root): write
 * "<name>.json" and mkdir "<name>", inline rename, then open the Character dialog.
 */
export async function newCharacter(): Promise<void> {
  const explorer = useExplorerStore();
  const folder = explorer.targetFolderRel;
  const rel = await explorer.runOp(async () => {
    const name = uniqueName('New Character', await namesIn(folder));
    const charRel = joinRel(folder, name);
    // json first: a failed mkdir leaves a repairable broken character instead of a stray folder
    await api().fs.writeJson(charJsonRel(charRel), serializeCharacter(createCharacterMeta()));
    await api().fs.mkdir(charRel);
    await explorer.refresh();
    return charRel;
  });
  if (folder !== '')
    explorer.setExpanded(folder, true);
  const finalRel = await explorer.beginRename(rel);
  await editCharacter(finalRel);
}

/**
 * New Animation in the target character: unique default name, fps from settings, camera and template from the
 * character defaults, and the first base image whose direction matches the default direction copied in as the
 * reference. Then inline rename, then open its tab.
 */
export async function newAnimation(): Promise<void> {
  const explorer = useExplorerStore();
  const charRel = explorer.targetCharacterRel;
  if (charRel === null)
    return;
  const rel = await explorer.runOp(async () => {
    const name = uniqueName('New Animation', await namesIn(charRel));
    const character = await useDocumentsStore().loadCharacter(charRel);
    const { direction, view, templateId } = character.defaults;
    const base = character.baseImages.find((b) => b.direction === direction) ?? null;
    let meta = createAnimationMeta({
      direction, view, templateId, fps: useSettingsStore().settings.app.defaultFps,
      canvas: base ? { width: base.width, height: base.height } : undefined
    });
    if (base) {
      const copy = await api().images.copyToAnimation(charRel, baseImageFileName(base.uid), name);
      const img = { image: copy.uid, sourceBaseUid: base.uid, width: base.width, height: base.height };
      meta = { ...meta, reference: withReferenceImage(stateFromMeta(meta), img).reference };
    }
    const animRel = animJsonRel(charRel, name);
    await api().fs.writeJson(animRel, serializeAnimation(meta));
    await explorer.refresh();
    return animRel;
  });
  explorer.setExpanded(charRel, true);
  const finalRel = await explorer.beginRename(rel);
  await openAnimation(finalRel);
}

// ---------- rename ----------

/** Validation message for renaming `node` to `name` (null when valid), against its current siblings. */
export function renameError(node: ExplorerNode, name: string): string | null {
  return validateName(name, { siblings: useExplorerStore().siblingNames(node), self: node.name });
}

/**
 * Rename on disk; resolves the new rel. Folder: dir rename. Character: json first, then the dir (the json is rolled
 * back when the dir fails). Animation: documents.renameAnimation (images, then the json; open or not). Folder and
 * character renames run in documents.runExclusive so open docs, their IO queues and pending jobs follow.
 */
export async function renameNode(node: ExplorerNode, name: string): Promise<string> {
  if (name === node.name)
    return node.rel;
  const error = renameError(node, name);
  if (error)
    throw new Error(error);
  const explorer = useExplorerStore();
  const documents = useDocumentsStore();
  return explorer.runOp(async () => {
    const from = node.rel;
    let to: string;
    if (node.kind === 'animation') {
      // Not wrapped in runExclusive: renameAnimation queues on the doc's own IO queue, which runExclusive would pause
      to = await documents.renameAnimation(from, name);
    } else if (node.kind === 'folder') {
      to = joinRel(parentRel(from), name);
      await documents.runExclusive(from, () => api().fs.rename(from, to), (d) => remapRel(d, from, to));
    } else if (node.kind === 'character') {
      to = joinRel(parentRel(from), name);
      await documents.runExclusive(from, () => renameCharacterFiles(from, to), (d) => remapRel(d, from, to));
    } else {
      to = joinRel(parentRel(from), name);
      await api().fs.rename(charJsonRel(from), charJsonRel(to));
    }
    explorer.remap(from, to);
    await explorer.refresh();
    return to;
  });
}

async function renameCharacterFiles(from: string, to: string): Promise<void> {
  await api().fs.rename(charJsonRel(from), charJsonRel(to));
  try {
    await api().fs.rename(from, to);
  } catch (e) {
    try {
      await api().fs.rename(charJsonRel(to), charJsonRel(from));
    } catch (rollback) {
      console.error('[explorer] character json rollback failed', rollback);
    }
    throw e;
  }
}

/** F2 / context menu: inline rename of a node (no-op for a node already being renamed). */
export function startRename(node: ExplorerNode): void {
  if (!node.renaming)
    void useExplorerStore().beginRename(node.rel);
}

/** The inline editor committed `name`: rename on disk and resolve beginRename() with the final rel. */
export async function commitRename(node: ExplorerNode, name: string): Promise<void> {
  const done = useExplorerStore().takeRename();
  let finalRel = node.rel;
  try {
    finalRel = await renameNode(node, name);
  } catch (e) {
    reportError(e, `Could not rename "${node.name}"`);
  }
  done(finalRel);
}

export function cancelRename(node: ExplorerNode): void {
  useExplorerStore().takeRename()(node.rel);
}

// ---------- duplicate ----------

/** Copy of an animation next to it: new id, unique name ("Walk 2"), its reference and frame images copied to new uids. */
async function writeDuplicate(src: AnimationMeta, from: { charRel: string; name: string }): Promise<string> {
  const name = uniqueName(from.name, await namesIn(from.charRel));
  const copies = new Map<string, string | null>();
  let missing = 0;
  for (const img of referencedImages(stateFromMeta(src))) {
    try {
      copies.set(img, (await api().images.copyToAnimation(from.charRel, animImageFileName(from.name, img), name)).uid);
    } catch (e) {
      console.warn(`[explorer] duplicate: could not copy ${animImageFileName(from.name, img)}`, e);
      copies.set(img, null);
      missing++;
    }
  }
  const mapped = (u: string | null): string | null => u === null ? null : copies.get(u) ?? null;
  const frames = src.frames.map((f) => {
    const image = mapped(f.image);
    return { ...f, image, imageStale: image !== null && f.imageStale };
  });
  const meta: AnimationMeta = { ...src, id: uid(), reference: { ...src.reference, image: mapped(src.reference.image) }, frames };
  const rel = animJsonRel(from.charRel, name);
  if (await api().fs.exists(rel))
    throw new Error(`"${name}" already exists`);
  await api().fs.writeJson(rel, serializeAnimation(meta));
  if (missing > 0)
    toasts.push({ kind: 'warning', title: 'Some images were not copied', message: `${plural(missing, 'image')} of "${from.name}" could not be read; the copy keeps its poses without them.` });
  return rel;
}

/** Duplicate an animation (an open doc is copied as currently edited, unsaved changes included), then open the copy. */
export async function duplicateAnimation(node: ExplorerNode): Promise<void> {
  if (node.kind !== 'animation')
    return;
  const explorer = useExplorerStore();
  const rel = await explorer.runOp(async () => {
    const doc = useDocumentsStore().findByRel(node.rel);
    const out = doc
      ? await doc.runIo((p) => writeDuplicate(metaFromState(doc.state.value, { id: doc.id, fps: doc.fps.value }), p))
      : await writeDuplicate(parseAnimation(await api().fs.readJson(node.rel)), { charRel: parentRel(node.rel), name: node.name });
    await explorer.refresh();
    return out;
  });
  explorer.select(rel, { reveal: true });
  await openAnimation(rel);
}

// ---------- delete ----------

function countContents(n: ScanNode): { characters: number; animations: number } {
  let characters = 0;
  let animations = 0;
  for (const c of n.children) {
    if (c.kind === 'animation')
      animations++;
    else {
      characters++;
      animations += c.children.filter((a) => a.kind === 'animation').length;
    }
  }
  return { characters, animations };
}

function deleteMessage(n: ScanNode): string {
  const { characters, animations } = countContents(n);
  if (n.kind === 'folder') {
    const parts = [characters > 0 ? plural(characters, 'character') : '', animations > 0 ? plural(animations, 'animation') : ''].filter(Boolean);
    return parts.length ? `Delete folder "${n.name}" with ${parts.join(' and ')}?` : `Delete the empty folder "${n.name}"?`;
  }
  if (n.kind === 'character')
    return animations > 0 ? `Delete character "${n.name}" with ${plural(animations, 'animation')}?` : `Delete character "${n.name}"? It has no animations.`;
  if (n.kind === 'brokenCharacter')
    return `Delete the character file "${n.name}.json"? Its folder is already missing.`;
  return `Delete animation "${n.name}"?`;
}

/** Recycle the entity's files. Character: dir first (a failure then leaves a deletable broken character, not a folder). */
async function trashEntity(n: ScanNode): Promise<void> {
  const fs = api().fs;
  switch (n.kind) {
    case 'folder':
      await fs.trash(n.rel);
      return;
    case 'character':
      await fs.trash(n.rel);
      await fs.trash(charJsonRel(n.rel));
      return;
    case 'brokenCharacter':
      await fs.trash(charJsonRel(n.rel));
      return;
    default: {
      // The json, then every file owned by the animation by name ("<name>.<uid>.png": saved, unsaved and undo images)
      await fs.trash(n.rel);
      const charRel = parentRel(n.rel);
      const owned = (await fs.listDir(charRel)).filter((e) => e.kind === 'file' && parseImageFileName(e.name)?.owner === n.name);
      for (const f of owned)
        await fs.trash(joinRel(charRel, f.name));
    }
  }
}

/** The row to select after `node` (and its visible subtree) disappears: the next row, else the previous one. */
function neighbourAfter(node: ExplorerNode): string | null {
  const rows = useExplorerStore().rows;
  const i = rows.findIndex((r) => r.rel === node.rel);
  if (i < 0)
    return null;
  for (let j = i + 1; j < rows.length; j++) {
    if (!isAtOrBelow(rows[j].rel, node.rel))
      return rows[j].rel;
  }
  return i > 0 ? rows[i - 1].rel : null;
}

/**
 * Delete with confirmation. Counts come from a fresh scan; the dialog lists the tabs that will close (unsaved
 * changes are lost) and the pending generations that will be cancelled. Files go to the Recycle Bin.
 */
export async function deleteNode(node: ExplorerNode): Promise<void> {
  const explorer = useExplorerStore();
  const documents = useDocumentsStore();
  const jobs = useJobsStore();
  const tabs = useTabsStore();
  const fresh = findScanNode(await api().fs.scanData(), node.rel);
  if (!fresh) {
    toasts.push({ kind: 'info', title: `"${node.name}" no longer exists` });
    await explorer.refresh();
    return;
  }
  // A broken character's only file is its json (an open doc can only sit at that exact path)
  const scope = fresh.kind === 'brokenCharacter' ? charJsonRel(fresh.rel) : fresh.rel;
  const docs = tabs.order.map((id) => documents.get(id)).filter((d): d is DocHandle => d !== undefined && isAtOrBelow(d.rel.value, scope));
  const pending = jobs.pendingUnder(scope);
  const sections: string[] = [];
  if (docs.length > 0) {
    const lines = docs.map((d) => `  • ${d.name.value}${d.dirty.value ? ' (unsaved changes are lost)' : ''}`);
    sections.push([`${docs.length === 1 ? 'This tab' : 'These tabs'} will close:`, ...lines].join('\n'));
  }
  if (pending.length > 0) {
    const lines = pending.map((j) => `  • ${charNameFromRel(charRelFromAnimRel(j.animRel))} / ${animNameFromRel(j.animRel)} (${j.status})`);
    sections.push([`${pending.length === 1 ? 'This pending generation' : `These ${pending.length} pending generations`} will be cancelled:`, ...lines].join('\n'));
  }
  sections.push('This can\'t be undone in the app (files go to the Recycle Bin).');
  const res = await dialogs.confirm({
    title: `Delete ${KIND_LABEL[fresh.kind]}`,
    message: deleteMessage(fresh),
    detail: sections.join('\n\n'),
    danger: true,
    okLabel: 'Delete'
  });
  if (!res.ok)
    return;
  const next = neighbourAfter(node);
  await explorer.runOp(async () => {
    for (const j of jobs.pendingUnder(scope))
      await jobs.cancel(j.key);
    try {
      await documents.runExclusive(scope, () => trashEntity(fresh), (d) => isAtOrBelow(d, scope) ? null : d);
    } finally {
      explorer.forget(fresh.rel);
      await explorer.refresh();
    }
  });
  if (next !== null && explorer.node(next))
    explorer.select(next, { reveal: true });
}

// ---------- repair ----------

const looksLikeAnimation = (raw: unknown): boolean =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw) && ['frames', 'reference', 'rig'].some((k) => k in raw);

/**
 * A broken character is a json without its dir. Usually the dir is missing: recreate it. When the json is really an
 * animation, its character lost its json instead (the character dir then scans as a folder): recreate that json.
 */
export async function repairNode(node: ExplorerNode): Promise<void> {
  if (node.kind !== 'brokenCharacter')
    return;
  const explorer = useExplorerStore();
  const raw: unknown = await api().fs.readJson(charJsonRel(node.rel)).catch(() => null);
  if (!looksLikeAnimation(raw)) {
    await explorer.runOp(async () => {
      await api().fs.mkdir(node.rel);
      await explorer.refresh();
    });
    explorer.setExpanded(node.rel, true);
    explorer.select(node.rel, { reveal: true });
    toasts.push({ kind: 'success', title: `Repaired "${node.name}"`, message: 'Its character folder was recreated.' });
    return;
  }
  const charRel = node.parentRel;
  if (charRel === null) {
    toasts.push({ kind: 'warning', title: `"${node.name}.json" is an animation file`, message: 'Animations must live inside a character folder. Move it into one, then refresh.' });
    return;
  }
  const charName = charNameFromRel(charRel);
  const res = await dialogs.confirm({
    title: 'Repair character',
    message: `"${charName}" looks like a character whose "${charName}.json" file is missing. Recreate it?`,
    detail: 'The folder is then shown as a character again, with its animations. Base images have to be imported again.',
    okLabel: 'Recreate'
  });
  if (!res.ok)
    return;
  await explorer.runOp(async () => {
    if (await api().fs.exists(charJsonRel(charRel)))
      throw new Error(`"${charName}.json" already exists`);
    await api().fs.writeJson(charJsonRel(charRel), serializeCharacter(createCharacterMeta()));
    await explorer.refresh();
  });
  explorer.setExpanded(charRel, true);
  explorer.select(charRel, { reveal: true });
  toasts.push({ kind: 'success', title: `Repaired "${charName}"` });
}
