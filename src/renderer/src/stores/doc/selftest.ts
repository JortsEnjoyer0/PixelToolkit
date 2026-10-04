// Self-test of the document core (documents / tabs / workspace stores) and Img to PixelArt's rectify store against an
// in-memory window.api (rectify: with stubbed image decoding).
// Run: npm run test:docs   (exit code 1 on any failure). Not part of the app bundle.
import { fakeJob, fakeJobs, keydown, beforeUnload, memFs, StubInput } from './selftestEnv';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { nextTick, watch } from 'vue';
import { WORKSPACE_REL } from '@shared/dataPaths';
import { uid } from '@shared/uid';
import { createAnimationMeta, createCharacterMeta, formatJson, parseAnimation, serializeAnimation, serializeCharacter, type FrameData } from '../../core/model';
import { newFrame } from '../../core/docState';
import { restPose } from '../../core/rig/poses';
import { dialogs, type DialogEntry } from '../../services/dialogs';
import { editorInteracting } from '../../services/editorState';
import { runCloseHandlers } from '../../services/lifecycle';
import { mouseNotifyState } from '../../services/mouseNotify';
import { toasts } from '../../services/toasts';
import { normalizeGrid } from '../../core/pixelart/grid';
import { GC_DELAY_MS, useDocumentsStore } from '../documents';
import { DEFAULT_GRID, useRectifyStore } from '../rectify';
import { useSettingsStore } from '../settings';
import { installDocumentShortcuts, restoreWorkspace, useTabsStore } from '../tabs';
import { parseWorkspace, useWorkspaceStore } from '../workspace';
import type { DocHandle } from '../types';
import { deps } from './deps';
import { IoQueue } from './ioQueue';
import type { DocInternal } from './handle';

deps.jobs = () => fakeJobs;

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passes++;
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}`, detail ?? '');
  }
}
async function rejects(name: string, p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
    check(name, false, 'resolved');
  } catch (e) {
    check(name, re.test((e as Error).message), (e as Error).message);
  }
}
const section = (s: string): void => console.log(`\n${s}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const gcSettled = async (doc: DocHandle): Promise<void> => {
  await sleep(GC_DELAY_MS + 30);
  await (doc as DocInternal).io.drain();
};

// ---------- dialog auto-answers ----------
const answers: string[] = [];
const seenDialogs: DialogEntry[] = [];
watch(() => dialogs.stack.length, () => {
  const top = dialogs.stack[dialogs.stack.length - 1];
  if (!top || seenDialogs.includes(top))
    return;
  seenDialogs.push(top);
  const answer = answers.shift();
  if (answer !== undefined)
    queueMicrotask(() => dialogs.resolve(top.id, answer));
}, { flush: 'sync' });
const lastDialog = (): DialogEntry | undefined => seenDialogs[seenDialogs.length - 1];
const lastNote = (): string | undefined => mouseNotifyState.notes[mouseNotifyState.notes.length - 1]?.text;
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---------- fixtures ----------
const CHAR = 'Townsfolk/Merchant';
const WALK = `${CHAR}/Walk.json`;
const IDLE = `${CHAR}/Idle.json`;
const img = (anim: string, u: string): string => `${CHAR}/${anim}.${u}.png`;
const PNG = new Uint8Array([137, 80, 78, 71]);

const R = uid();
const A = uid();
const B = uid();
const C = uid();
const I1 = uid();
const BASE = uid();

function frame(image: string | null): FrameData {
  return { ...newFrame(restPose()), image };
}

memFs.mkdirp(CHAR);
memFs.putJson(`${CHAR}.json`, serializeCharacter({ ...createCharacterMeta(), description: 'a merchant' }));
memFs.put(`${CHAR}/base.${BASE}.png`, PNG);
const walkMeta = createAnimationMeta({ action: 'walk' });
walkMeta.reference = { ...walkMeta.reference, image: R };
walkMeta.frames = [frame(A), frame(B), frame(C)];
memFs.putJson(WALK, serializeAnimation(walkMeta));
for (const u of [R, A, B, C])
  memFs.put(img('Walk', u), PNG);
const idleMeta = createAnimationMeta({ action: 'idle' });
idleMeta.frames = [frame(I1)];
memFs.putJson(IDLE, serializeAnimation(idleMeta));
memFs.put(img('Idle', I1), PNG);
const walkText = memFs.text(WALK);

async function main(): Promise<void> {
  let pinia: Pinia = createPinia();
  setActivePinia(pinia);
  const settings = useSettingsStore();
  await settings.load();

  section('IoQueue');
  {
    const q = new IoQueue();
    const log: string[] = [];
    const a = q.run(async () => {
      await sleep(10);
      log.push('a');
    });
    const release = await q.pause();
    check('pause waits for queued ops', log.join() === 'a');
    const b = q.run(async () => {
      log.push('b');
    });
    await sleep(10);
    check('ops after a pause wait', log.join() === 'a' && q.pending === 2);
    release();
    await Promise.all([a, b]);
    check('release resumes', log.join() === 'a,b' && q.pending === 0);
    const failing = q.run(async () => {
      throw new Error('boom');
    });
    await failing.catch(() => undefined);
    check('a failing op does not block the queue', (await q.run(async () => 42)) === 42);
  }

  const documents = useDocumentsStore();
  const tabs = useTabsStore();
  const workspace = useWorkspaceStore();
  await workspace.whenLoaded();

  section('workspace display (ghost frames)');
  {
    const d = workspace.state;
    const parsed = (display: unknown): { showGhosts: boolean; ghostCount: number } => parseWorkspace({ display }, d).display;
    check('defaults: ghosts off, count 1', !d.display.showGhosts && d.display.ghostCount === 1 && parsed(undefined).ghostCount === 1);
    check('saved toggle and count restored', parsed({ showGhosts: true, ghostCount: 4 }).showGhosts && parsed({ ghostCount: 4 }).ghostCount === 4);
    check('count rounded and clamped to 0..15', parsed({ ghostCount: 2.6 }).ghostCount === 3 && parsed({ ghostCount: 99 }).ghostCount === 15 && parsed({ ghostCount: -2 }).ghostCount === 0);
    check('malformed values fall back', parsed({ showGhosts: 'yes', ghostCount: '4' }).ghostCount === 1 && !parsed({ showGhosts: 'yes' }).showGhosts && parsed({ ghostCount: null }).ghostCount === 1);
    const color = (v: unknown): string => parseWorkspace({ display: { ghostColor: v } }, d).display.ghostColor;
    check('ghost colour: default, restored lower-cased, malformed falls back',
      d.display.ghostColor === '#874040' && color('#FF8800') === '#ff8800' && color('red') === '#874040' && color('#ff880') === '#874040' && color(42) === '#874040');
  }

  section('workspace img2pixel');
  {
    const d = workspace.state;
    const parsed = (img2pixel: unknown): typeof d.img2pixel => parseWorkspace({ img2pixel }, d).img2pixel;
    const r = d.img2pixel.rectify;
    check('defaults: Rectify To Grid, background removal, colour merging and snapping on, square off, no colour limit',
      d.img2pixel.subtool === 'rectify' && r.removeBackground && r.mergeColors && r.snapToEdges && !r.makeSquare && r.maxColors === 0);
    check('missing or malformed → defaults', sameJson(parsed(undefined), d.img2pixel) && sameJson(parsed('x'), d.img2pixel));
    const saved = { subtool: 'later', rectify: { removeBackground: false, makeSquare: true, mergeColors: false, snapToEdges: false, maxColors: 64 } };
    check('saved sub-tool and options restored', sameJson(parsed(saved), saved));
    check('max colours snaps to a slider setting', parsed({ rectify: { maxColors: 50 } }).rectify.maxColors === 48
      && parsed({ rectify: { maxColors: -3 } }).rectify.maxColors === 0);
    const mixed = parsed({ subtool: '', rectify: { removeBackground: 'no', makeSquare: true, extra: 1 } });
    check('fields fall back one by one, unknown keys dropped', mixed.subtool === 'rectify' && mixed.rectify.removeBackground
      && mixed.rectify.makeSquare && mixed.rectify.mergeColors && mixed.rectify.snapToEdges && mixed.rectify.maxColors === 0
      && !('extra' in mixed.rectify));
  }

  section('rectify store (Img to PixelArt)');
  {
    // Decoding stubs: a blob's text is "<w>x<h>" (or "<w>x<h>@<ms>" for a slow decode); anything else is not an image
    const g = globalThis as unknown as Record<string, unknown>;
    const closed: string[] = [];
    g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
    g.createImageBitmap = async (blob: Blob) => {
      const text = await blob.text();
      const m = /^(\d+)x(\d+)(?:@(\d+))?$/.exec(text);
      if (!m)
        throw new Error('undecodable');
      await sleep(Number(m[3] ?? 0));
      return { width: Number(m[1]), height: Number(m[2]), close: () => closed.push(text) };
    };
    g.OffscreenCanvas = class {
      getContext(): object {
        return { drawImage: () => undefined, getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
      }
    };
    const revoked: string[] = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string): void => {
      revoked.push(url);
      revoke(url);
    };
    const blob = (text: string): Blob => new Blob([text]);

    const rect = useRectifyStore();
    check('starts empty with the default grid and workspace options', rect.source === null && sameJson(rect.grid, DEFAULT_GRID)
      && rect.outputSize === null && sameJson(rect.options, workspace.state.img2pixel.rectify) && await rect.rectify() === null);
    rect.setGrid({ offsetX: 17.5, offsetY: -1 });
    check('setGrid wraps offsets into [0, size)', rect.grid.offsetX === 1.5 && rect.grid.offsetY === 15 && Object.isFrozen(rect.grid));
    rect.nudge(-2, 1);
    check('nudge moves by whole px and wraps', rect.grid.offsetX === 15.5 && rect.grid.offsetY === 0);
    rect.setGrid({ size: 1.234 });
    check('size clamped and rounded, offsets re-wrapped', sameJson(rect.grid, normalizeGrid({ size: 2, offsetX: 15.5, offsetY: 0 })));
    rect.setGrid({ size: 4, offsetX: 0 });

    rect.setOptions({ makeSquare: true });
    check('options live in the workspace', rect.options.makeSquare && workspace.state.img2pixel.rectify.makeSquare
      && workspace.state.img2pixel.rectify.removeBackground);
    await workspace.flush();
    check('…and are written to workspace.json', memFs.json<{ img2pixel: { rectify: { makeSquare: boolean } } }>(WORKSPACE_REL).img2pixel.rectify.makeSquare);
    rect.setOptions({ makeSquare: false });

    const slow = rect.loadBlob(blob('16x16@30'), 'slow.png');
    check('loading while decoding', rect.loading);
    await rect.loadBlob(blob('16x8'), 'fast.png');
    check('the newer load wins', rect.source?.name === 'fast.png' && !rect.loading);
    await slow;
    check('a superseded load is dropped and its bitmap closed', rect.source?.name === 'fast.png' && closed.includes('16x16@30'));
    check('output size follows the grid', sameJson(rect.outputSize, { width: 4, height: 2 }));
    const rectifying = rect.rectify();
    check('rectifying flag set before rectify runs', rect.rectifying);
    const result = await rectifying;
    check('rectify gives one px per cell', !rect.rectifying && result?.image.width === 4 && result.image.height === 2);

    const estimating = rect.runEstimate();
    check('estimating flag set before the estimate runs', rect.estimating && rect.lastEstimate === null);
    await estimating;
    const est = rect.lastEstimate;
    check('estimate adopted as the grid', !rect.estimating && est !== null && sameJson(rect.grid, normalizeGrid(est)));

    const fast = rect.source;
    await rejects('not an image → user-facing error', rect.loadBlob(blob('nope'), 'notes.txt'), /"notes\.txt" is not an image/);
    await rejects('larger than MAX_IMAGE_SIDE → error names size and limit', rect.loadBlob(blob('9000x10'), 'wide.png'), /9000 × 10 px.*8192/);
    await rejects('more than MAX_IMAGE_PIXELS → error', rect.loadBlob(blob('5000x5000'), 'big.png'), /megapixels/);
    check('failed loads keep the source and close their bitmaps', rect.source === fast && !rect.loading
      && closed.includes('9000x10') && closed.includes('5000x5000'));

    const files = window.api.files;
    window.api.files = { ...files, openImage: async () => ({ name: 'opened.png', bytes: new TextEncoder().encode('8x8') }) };
    await rect.openFile();
    check('openFile adopts the picked file', rect.source?.name === 'opened.png' && rect.source.image.width === 8);
    check('a new image clears the estimate; the old URL is revoked and its bitmap closed', rect.lastEstimate === null
      && fast !== null && revoked.includes(fast.url) && closed.includes('16x8'));
    window.api.files = { ...files, openImage: async () => null };
    await rect.openFile();
    check('a cancelled dialog changes nothing', rect.source?.name === 'opened.png');
    window.api.files = files;

    const opened = rect.source;
    rect.$dispose();
    check('disposing the store releases the source', opened !== null && revoked.includes(opened.url) && closed.includes('8x8'));
    URL.revokeObjectURL = revoke;
  }

  section('load + save round trip');
  const walk = await documents.load(WALK) as DocInternal;
  check('loaded name / charRel', walk.name.value === 'Walk' && walk.charRel.value === CHAR);
  check('not dirty after load', !walk.dirty.value);
  check('state frozen', Object.isFrozen(walk.state.value) && Object.isFrozen(walk.state.value.frames[0].pose.rot));
  check('same handle for another casing', (await documents.load(WALK.toUpperCase())) === walk);
  check('findByRel case-insensitive', documents.findByRel(WALK.toLowerCase()) === walk);
  await sleep(5);
  check('character loaded with the doc', documents.characters.get(CHAR)?.description === 'a merchant');
  check('save ok', await documents.save(walk.id));
  check('"Saved" note', lastNote() === 'Saved');
  check('saved bytes identical to the loaded file', memFs.text(WALK) === walkText);
  const reparsed = parseAnimation(memFs.json(WALK));
  check('parse → serialize identical', formatJson(serializeAnimation(reparsed)) + '\n' === walkText);

  section('apply / undo / redo / dirty');
  const v0 = walk.version.value;
  walk.apply('Set Action', (s) => ({ ...s, action: 'stroll' }));
  check('apply → dirty, version bumped', walk.dirty.value && walk.version.value === v0 + 1 && walk.state.value.action === 'stroll');
  walk.apply('Noop', (s) => s);
  check('identity producer is a no-op', walk.history.undoCount === 1);
  check('undo returns label', walk.undo() === 'Set Action');
  check('undo back to saved → clean', !walk.dirty.value && walk.state.value.action === 'walk');
  check('redo returns label', walk.redo() === 'Set Action');
  check('redo → dirty', walk.dirty.value);
  check('save after redo', await documents.save(walk.id) && !walk.dirty.value);
  check('file has the new action', memFs.json<{ action: string }>(WALK).action === 'stroll');
  walk.undo();
  check('undo past saved → dirty', walk.dirty.value);
  walk.redo();
  check('redo to saved → clean', !walk.dirty.value);
  walk.setFps(24);
  check('setFps → dirty (metaRev)', walk.dirty.value && walk.metaRev.value === 1);
  await documents.save(walk.id);
  check('fps saved', memFs.json<{ fps: number }>(WALK).fps === 24 && !walk.dirty.value);

  section('merge keys');
  const before = walk.history.undoCount;
  walk.apply('Pitch', (s) => ({ ...s, pitchDeg: 21 }), { mergeKey: 'pitch', mergeMs: 60000 });
  walk.apply('Pitch', (s) => ({ ...s, pitchDeg: 22 }), { mergeKey: 'pitch', mergeMs: 60000 });
  walk.apply('Pitch', (s) => ({ ...s, pitchDeg: 23 }), { mergeKey: 'pitch', mergeMs: 60000 });
  check('same key merges into one entry', walk.history.undoCount === before + 1 && walk.state.value.pitchDeg === 23);
  walk.apply('Seed', (s) => ({ ...s, seed: 5 }), { mergeKey: 'seed', mergeMs: 60000 });
  check('different key → new entry', walk.history.undoCount === before + 2);
  walk.undo();
  walk.undo();
  check('one undo reverts the merged run', walk.state.value.pitchDeg === walkMeta.pitchDeg && !walk.dirty.value);

  section('eviction → image GC');
  await settings.save({ app: { undoLimit: 2 } });
  await nextTick();
  check('undo limit follows settings', walk.history.getLimit() === 2);
  walk.apply('Delete Frame', (s) => ({ ...s, frames: s.frames.filter((f) => f.image !== C) }));
  await documents.save(walk.id);
  await gcSettled(walk);
  check('image still live while an undo state references it', memFs.has(img('Walk', C)));
  walk.apply('Edit 1', (s) => ({ ...s, seed: 1 }));
  walk.apply('Edit 2', (s) => ({ ...s, seed: 2 }));
  await gcSettled(walk);
  check('evicted-only image deleted', !memFs.has(img('Walk', C)));
  check('live images kept', [R, A, B].every((u) => memFs.has(img('Walk', u))));
  check('base image untouched', memFs.has(`${CHAR}/base.${BASE}.png`));
  check('deleted uid leaves the candidates', !walk.candidates.has(C));
  // created this session but not applied yet: protected from eviction GC
  const imported = await walk.runIo((p) => window.api.images.importReference(p.charRel, p.name));
  walk.noteCreatedImage(imported!.uid);
  walk.apply('Edit 3', (s) => ({ ...s, seed: 3 }));
  walk.apply('Edit 4', (s) => ({ ...s, seed: 4 }));
  walk.apply('Edit 5', (s) => ({ ...s, seed: 5 }));
  await gcSettled(walk);
  check('created-but-unapplied image survives eviction GC', memFs.has(img('Walk', imported!.uid)));
  // pending job frameUids stay live
  const J = uid();
  memFs.put(img('Walk', J), PNG);
  walk.noteCreatedImage(J);
  walk.apply('Use J', (s) => ({ ...s, frames: s.frames.map((f, i) => i === 0 ? { ...f, image: J } : f) }));
  walk.apply('Unuse J', (s) => ({ ...s, frames: s.frames.map((f, i) => i === 0 ? { ...f, image: A } : f) }));
  const job = fakeJob(walk.id, WALK, [J]);
  walk.apply('Edit 6', (s) => ({ ...s, seed: 6 }));
  walk.apply('Edit 7', (s) => ({ ...s, seed: 7 }));
  await gcSettled(walk);
  check('pending job image kept', memFs.has(img('Walk', J)));
  fakeJobs.records.splice(fakeJobs.records.indexOf(job), 1);
  walk.apply('Edit 8', (s) => ({ ...s, seed: 8 }));
  await gcSettled(walk);
  check('job image deleted once the job is gone', !memFs.has(img('Walk', J)));
  await documents.save(walk.id);

  section('rename (open doc)');
  fakeJob(walk.id, WALK, [uid()]);
  await rejects('duplicate sibling name rejected', documents.renameAnimation(WALK, 'idle'), /already exists/);
  await rejects('invalid name rejected', documents.renameAnimation(WALK, 'bad.name'), /cannot contain/);
  // an interrupted earlier rename left one image under the target name: it heals
  memFs.entries.delete(img('Walk', B).toLowerCase());
  memFs.put(`${CHAR}/Walk Cycle.${B}.png`, PNG);
  const cycleRel = await documents.renameAnimation(WALK, 'Walk Cycle');
  check('new rel returned', cycleRel === `${CHAR}/Walk Cycle.json`);
  check('handle follows', walk.rel.value === cycleRel && walk.name.value === 'Walk Cycle');
  check('json renamed', memFs.has(cycleRel) && !memFs.has(WALK));
  check('owned images renamed (incl. created + healed)', [R, A, B, imported!.uid].every((u) => memFs.has(`${CHAR}/Walk Cycle.${u}.png`)));
  check('no old-name images left', memFs.files(CHAR).every((f) => !f.startsWith('Walk.')));
  check('job retargeted', fakeJobs.retargets.some((r) => r.animRel === cycleRel));
  const caseRel = await documents.renameAnimation(cycleRel, 'walk cycle');
  check('case-only rename', memFs.actual(caseRel) === `${CHAR}/walk cycle.json` && walk.name.value === 'walk cycle');
  await documents.renameAnimation(caseRel, 'Walk Cycle');
  memFs.failRename = /\.json$/;
  await rejects('json rename failure rejects', documents.renameAnimation(cycleRel, 'Sprint'), /simulated/);
  memFs.failRename = null;
  check('images rolled back after a failed json rename', memFs.has(`${CHAR}/Walk Cycle.${R}.png`) && !memFs.has(`${CHAR}/Sprint.${R}.png`));
  check('handle unchanged after failure', walk.rel.value === cycleRel);

  section('rename (closed animation)');
  const runRel = await documents.renameAnimation(IDLE, 'Run');
  check('closed animation renamed', runRel === `${CHAR}/Run.json` && memFs.has(runRel) && memFs.has(img('Run', I1)) && !memFs.has(img('Idle', I1)));

  section('tabs');
  await tabs.open(cycleRel);
  const run = await tabs.open(runRel);
  check('open activates', tabs.activeDocId === run.id && tabs.order.length === 2);
  check('tab info', tabs.tabs[1].label === 'Run' && tabs.tabs[1].charName === 'Merchant' && tabs.tabs[1].active);
  tabs.move(1, 0);
  check('move reorders', tabs.order[0] === run.id);
  tabs.activate(walk.id);
  check('activate', tabs.activeDoc === walk);
  memFs.mkdirp('Other');
  memFs.putJson('Other.json', serializeCharacter(createCharacterMeta()));
  memFs.putJson('Other/Run.json', serializeAnimation(createAnimationMeta()));
  const otherRun = await tabs.open('Other/Run.json');
  check('duplicate labels get the character suffix', tabs.tabs.filter((t) => t.showCharSuffix).length === 2);
  otherRun.apply('Edit', (s) => ({ ...s, seed: 9 }));
  answers.push('cancel');
  check('dirty close + Cancel keeps the tab', !await tabs.close(otherRun.id) && tabs.order.includes(otherRun.id));
  check('close prompt is a Save / Don\'t Save / Cancel choice', lastDialog()?.kind === 'choice');
  // an unsaved, created image goes with Don't Save
  const N2 = uid();
  memFs.put(`Other/Run.${N2}.png`, PNG);
  otherRun.noteCreatedImage(N2);
  otherRun.apply('Use N2', (s) => ({ ...s, frames: [{ ...newFrame(restPose()), image: N2 }] }));
  answers.push('discard');
  check('Don\'t Save closes', await tabs.close(otherRun.id) && !tabs.order.includes(otherRun.id) && !documents.docs.has(otherRun.id));
  check('unsaved image deleted on unload', !memFs.has(`Other/Run.${N2}.png`));
  check('file unchanged by Don\'t Save', memFs.json<{ seed: number }>('Other/Run.json').seed === 0);
  check('closing the active tab activates a neighbour', tabs.activeDocId !== otherRun.id && tabs.activeDocId !== null);

  section('runExclusive');
  const charJob = fakeJob(run.id, runRel, [uid()]);
  let finishOp!: () => void;
  const opGate = new Promise<void>((r) => {
    finishOp = r;
  });
  walk.apply('Edit before move', (s) => ({ ...s, seed: 11 }));
  const remap = (rel: string): string | null => rel.toLowerCase().startsWith('townsfolk/') ? 'Village/' + rel.slice('Townsfolk/'.length) : rel;
  const exclusive = documents.runExclusive('Townsfolk', async () => {
    await opGate;
    await window.api.fs.rename('Townsfolk', 'Village');
    return 'moved';
  }, remap);
  await sleep(5);
  const writesBefore = memFs.writes.length;
  const queuedSave = documents.save(walk.id);
  await sleep(10);
  check('save waits while the queue is paused', memFs.writes.length === writesBefore);
  check('ioBusy during the exclusive op', documents.ioBusy);
  finishOp();
  check('runExclusive resolves the op result', await exclusive === 'moved');
  check('queued save succeeded', await queuedSave);
  check('save ran with the remapped path', memFs.writes[memFs.writes.length - 1] === 'Village/Merchant/Walk Cycle.json');
  check('docs remapped', walk.rel.value === 'Village/Merchant/Walk Cycle.json' && run.charRel.value === 'Village/Merchant');
  check('jobs retargeted', charJob.animRel === 'Village/Merchant/Run.json');
  check('character cache re-keyed', documents.characters.has('Village/Merchant') && !documents.characters.has(CHAR));
  await sleep(450);
  await workspace.flush();
  check('workspace tabs follow the move', memFs.json<{ tabs: string[] }>(WORKSPACE_REL).tabs.includes('Village/Merchant/Walk Cycle.json'));
  const runFiles = memFs.files('Village/Merchant').filter((f) => f.startsWith('Run.') && f.endsWith('.png'));
  await documents.runExclusive('Village/Merchant/Run.json', async () => {
    await window.api.fs.trash('Village/Merchant/Run.json');
  }, () => null);
  check('deleted doc unloaded', !documents.docs.has(run.id));
  check('its tab closed', !tabs.order.includes(run.id));
  check('no GC on a deleted doc', runFiles.length > 0 && runFiles.every((f) => memFs.has(`Village/Merchant/${f}`)));
  check('ioBusy clears', !documents.ioBusy);

  section('reconcile');
  const CYCLE = 'Village/Merchant/Walk Cycle.json';
  await documents.save(walk.id);
  let scan = await window.api.fs.scanData();
  await documents.reconcile(scan);
  const vSaved = walk.version.value;
  await documents.reconcile(await window.api.fs.scanData());
  check('own save does not reload', walk.version.value === vSaved && walk.history.undoCount > 0);
  const external = memFs.json<Record<string, unknown>>(CYCLE);
  memFs.putJson(CYCLE, { ...external, action: 'external edit' });
  await documents.reconcile(await window.api.fs.scanData());
  check('clean doc reloaded after an external change', walk.state.value.action === 'external edit' && walk.history.undoCount === 0 && !walk.dirty.value);
  walk.apply('Local', (s) => ({ ...s, action: 'local' }));
  memFs.putJson(CYCLE, { ...external, action: 'external 2' });
  await documents.reconcile(await window.api.fs.scanData());
  check('dirty doc never reloaded', walk.state.value.action === 'local');
  memFs.remove(CYCLE);
  scan = await window.api.fs.scanData();
  await documents.reconcile(scan);
  check('vanished → missingOnDisk', walk.missingOnDisk.value && tabs.tabs.find((t) => t.docId === walk.id)?.missingOnDisk === true);
  check('save recreates a missing doc', await documents.save(walk.id) && memFs.has(CYCLE) && !walk.missingOnDisk.value);
  // character dir gone: save fails with a toast
  const moved = memFs.files('Village/Merchant');
  memFs.remove('Village/Merchant');
  await documents.reconcile(await window.api.fs.scanData());
  walk.apply('Orphan', (s) => ({ ...s, seed: 12 }));
  const toastCount = toasts.list.length;
  check('missing character dir → save fails', !await documents.save(walk.id));
  check('…with an error toast', toasts.list.length === toastCount + 1 && toasts.list[toasts.list.length - 1].kind === 'error');
  check('character dropped from the cache', !documents.characters.has('Village/Merchant'));
  memFs.mkdirp('Village/Merchant');
  for (const f of moved)
    memFs.put(`Village/Merchant/${f}`, PNG);
  memFs.putJson('Village/Merchant.json', serializeCharacter(createCharacterMeta()));
  check('save works again once the dir is back', await documents.save(walk.id));

  section('autosave');
  walk.apply('Auto 1', (s) => ({ ...s, seed: 13 }));
  editorInteracting.value = true;
  const auto = documents.autosave();
  await sleep(10);
  check('autosave deferred while the editor drags', walk.dirty.value);
  editorInteracting.value = false;
  check('autosave saved one doc', await auto === 1 && !walk.dirty.value);
  check('"Auto-saved" note', lastNote() === 'Auto-saved');
  check('nothing dirty → nothing saved', await documents.autosave() === 0);

  section('duplicate id');
  memFs.putJson('Village/Merchant/Walk Copy.json', memFs.json(CYCLE));
  const copy = await documents.load('Village/Merchant/Walk Copy.json');
  check('copy gets a fresh id', copy.id !== walk.id);
  await (copy as DocInternal).io.drain();
  check('fresh id persisted', memFs.json<{ id: string }>('Village/Merchant/Walk Copy.json').id === copy.id);
  await documents.unload(copy.id);
  {
    const V = 'Village/Merchant';
    const json = <T>(rel: string): T => memFs.json<T>(rel);
    // An Explorer copy of the json only, opened BEFORE its original: its images are named after the original
    const D1 = uid();
    const D2 = uid();
    const runMeta = createAnimationMeta({ action: 'run' });
    runMeta.frames = [frame(D1), frame(D2)];
    memFs.putJson(`${V}/Sprint.json`, serializeAnimation(runMeta));
    memFs.put(`${V}/Sprint.${D1}.png`, PNG);
    memFs.put(`${V}/Sprint.${D2}.png`, PNG);
    memFs.put(`${V}/Sprint - Copy.json`, memFs.text(`${V}/Sprint.json`));
    const sprintCopy = await documents.load(`${V}/Sprint - Copy.json`) as DocInternal;
    const sprint = await documents.load(`${V}/Sprint.json`) as DocInternal;
    await sprintCopy.io.drain();
    await sprint.io.drain();
    check('copy opened first: the copy gets the fresh id, the original keeps its own', sprintCopy.id !== runMeta.id && sprint.id === runMeta.id);
    check('… stored in the copy only', json<{ id: string }>(`${V}/Sprint - Copy.json`).id === sprintCopy.id && json<{ id: string }>(`${V}/Sprint.json`).id === runMeta.id);
    // A copy without images, opened while its original (closed) has a pending job
    const jumpMeta = createAnimationMeta({ action: 'jump' });
    memFs.putJson(`${V}/Jump.json`, serializeAnimation(jumpMeta));
    memFs.put(`${V}/Jump 2.json`, memFs.text(`${V}/Jump.json`));
    const jumpJob = fakeJob(jumpMeta.id, `${V}/Jump.json`, [uid()]);
    const jumpCopy = await documents.load(`${V}/Jump 2.json`) as DocInternal;
    await jumpCopy.io.drain();
    check('a copy whose original has a pending job gets the fresh id (the job keeps the original)', jumpCopy.id !== jumpMeta.id && jumpJob.docId === jumpMeta.id);
    // Two jsons that cannot be told apart: the second one opened gets the fresh id, and its own jobs follow it
    const sitMeta = createAnimationMeta({ action: 'sit' });
    memFs.putJson(`${V}/Sit.json`, serializeAnimation(sitMeta));
    memFs.put(`${V}/Sit B.json`, memFs.text(`${V}/Sit.json`));
    const sitA = await documents.load(`${V}/Sit.json`);
    const sitJob = fakeJob(sitMeta.id, `${V}/Sit B.json`, [uid()]);
    const sitB = await documents.load(`${V}/Sit B.json`) as DocInternal;
    await sitB.io.drain();
    check('second of two equal jsons gets the fresh id; its job is rekeyed to it', sitA.id === sitMeta.id && sitB.id !== sitMeta.id
      && sitJob.docId === sitB.id && fakeJobs.rekeys.some((r) => r.key === sitJob.key && r.docId === sitB.id));
    for (const j of [jumpJob, sitJob])
      fakeJobs.records.splice(fakeJobs.records.indexOf(j), 1);
    for (const d of [sprintCopy, sprint, jumpCopy, sitA, sitB])
      await documents.unload(d.id);
  }
  check('own save records the written mtime (no re-read on rescan)', await documents.save(walk.id)
    && (walk as DocInternal).diskMtime === (memFs.get(CYCLE) as { mtime: number }).mtime);

  section('shortcuts');
  /** Skel Anim is the shown tool (App.vue's predicate). */
  let skelAnimShown = true;
  installDocumentShortcuts(() => skelAnimShown);
  tabs.activate(walk.id);
  walk.apply('Rotate Left Forearm', (s) => ({ ...s, seed: 14 }));
  check('Ctrl+Z handled', keydown({ key: 'z', ctrl: true }));
  check('Ctrl+Z undoes the active doc', walk.state.value.seed === 13 && lastNote() === 'Undo Rotate Left Forearm');
  keydown({ key: 'y', ctrl: true });
  check('Ctrl+Y redoes', walk.state.value.seed === 14 && lastNote() === 'Redo Rotate Left Forearm');
  keydown({ key: 'Z', ctrl: true, shift: true });
  check('Ctrl+Shift+Z at the top → "Nothing to redo"', lastNote() === 'Nothing to redo');
  editorInteracting.value = true;
  keydown({ key: 'z', ctrl: true });
  editorInteracting.value = false;
  check('Ctrl+Z skipped while the editor drags', walk.state.value.seed === 14);
  const input = new StubInput();
  input.focus();
  check('Ctrl+Z ignored in text fields (native undo)', !keydown({ key: 'z', ctrl: true, target: input }) && walk.state.value.seed === 14);
  check('Ctrl+S allowed in text fields', keydown({ key: 's', ctrl: true, target: input }));
  await (walk as DocInternal).io.drain();
  check('Ctrl+S blurred the field and saved', input.blurred === 1 && !walk.dirty.value);
  skelAnimShown = false;
  walk.apply('Hidden tool', (s) => ({ ...s, seed: 20 }));
  check('another tool shown: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z / Ctrl+S decline', !keydown({ key: 'z', ctrl: true })
    && !keydown({ key: 'y', ctrl: true }) && !keydown({ key: 'Z', ctrl: true, shift: true }) && !keydown({ key: 's', ctrl: true })
    && walk.state.value.seed === 20 && walk.dirty.value);
  skelAnimShown = true;
  walk.undo();
  answers.push('cancel');
  void dialogs.confirm({ title: 'modal', message: 'x' });
  walk.apply('Under modal', (s) => ({ ...s, seed: 15 }));
  keydown({ key: 'z', ctrl: true });
  await sleep(1);
  check('shortcuts suppressed by a modal', walk.state.value.seed === 15);
  walk.undo();

  section('exclusive ordering (no deadlocks)');
  memFs.mkdirp('Lab/Bot');
  memFs.putJson('Lab/Bot.json', serializeCharacter(createCharacterMeta()));
  memFs.putJson('Lab/Bot/Wave.json', serializeAnimation(createAnimationMeta()));
  const renaming = documents.renameAnimation('Lab/Bot/Wave.json', 'Wave 2');
  let gate2!: () => void;
  const g2 = new Promise<void>((r) => {
    gate2 = r;
  });
  const ex2 = documents.runExclusive('Lab', async () => {
    await g2;
    await window.api.fs.rename('Lab', 'Lab2');
  }, (r) => r.toLowerCase().startsWith('lab/') ? 'Lab2/' + r.slice(4) : r);
  const lateLoad = documents.load('Lab/Bot/Wave 2.json');
  let lateDone = false;
  lateLoad.then(() => {
    lateDone = true;
  }, () => {
    lateDone = true;
  });
  check('a closed rename started earlier completes first', await renaming === 'Lab/Bot/Wave 2.json');
  await sleep(10);
  check('a later load waits for the exclusive op', !lateDone);
  gate2();
  await ex2;
  await rejects('…and then finds the old path gone', lateLoad, /Could not open/);
  check('the moved animation opens at its new path', (await documents.load('Lab2/Bot/Wave 2.json')).name.value === 'Wave 2');

  section('close handler + beforeunload');
  walk.apply('Unsaved', (s) => ({ ...s, seed: 16 }));
  check('beforeunload guarded while dirty', beforeUnload());
  fakeJob(walk.id, CYCLE, [uid()], 'queued');
  answers.push('cancel');
  check('Cancel aborts the close', !await runCloseHandlers() && walk.dirty.value);
  const prompt = lastDialog();
  check('prompt names the one doc once and mentions running jobs', prompt?.kind === 'choice' && /"Walk Cycle" \(Merchant\)/.test(prompt.options.message)
    && !/Walk Cycle/.test(prompt.options.detail ?? '') && /continue/.test(prompt.options.detail ?? ''));
  answers.push('save');
  check('Save All closes', await runCloseHandlers());
  check('doc saved on close', !walk.dirty.value && memFs.json<{ seed: number }>(CYCLE).seed === 16);
  check('workspace persisted on close', memFs.json<{ activeRel: string }>(WORKSPACE_REL).activeRel === CYCLE);
  check('beforeunload free when clean', !beforeUnload());

  section('restoreWorkspace (fresh session)');
  memFs.putJson(WORKSPACE_REL, { ...memFs.json<object>(WORKSPACE_REL), tabs: ['Gone/Nope/Missing.json', CYCLE], activeRel: CYCLE });
  walk.apply('Left dirty', (s) => ({ ...s, seed: 17 }));
  for (const id of ['tabs', 'documents', 'workspace']) {
    const s = (pinia as unknown as { _s: Map<string, { $dispose(): void }> })._s.get(id);
    s?.$dispose();
  }
  pinia = createPinia();
  setActivePinia(pinia);
  await useSettingsStore().load();
  await restoreWorkspace();
  const tabs2 = useTabsStore();
  check('existing tab restored, missing skipped', tabs2.order.length === 1 && tabs2.activeDoc?.rel.value === CYCLE);
  answers.push('cancel');
  check('the disposed store\'s close handler is gone (no prompt for its dirty doc)', await runCloseHandlers() && answers.length === 1);
  answers.length = 0;
}

main().then(() => {
  console.log(`\n${passes} passed, ${failures} failed`);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(failures > 0 ? 1 : 0);
}, (e: unknown) => {
  console.error(e);
  (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(1);
});
