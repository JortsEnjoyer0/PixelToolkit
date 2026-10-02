// npm run test:playback
// Playback stepping / targets / the play loop (fake requestAnimationFrame) and the jobs store logic: the "Generate"
// producer, applying finished jobs to open and closed docs, failed / cancelled records, the double-apply guard,
// estimates (cache, force, stale, failure) and submit. window.api, the documents store and the tabs store are mocks;
// docs are real mock DocHandles (stores/mockDoc.ts). No Electron, no network.
import { ref, shallowReactive } from 'vue';
import type { PixelToolkitApi, Result, EstimateResult } from '@shared/api';
import { animJsonRel, animNameFromRel, charRelFromAnimRel, jobStageDirRel, jobStageFileRel } from '@shared/dataPaths';
import type { JobRecord, JobUpdateEvent, SubmitAnimateInput, SubmitAnimateResult } from '@shared/jobs';
import { SKELETON_LABELS, type KeypointOut } from '@shared/pixellab';
import { uid } from '@shared/uid';
import { createAnimationMeta, createCharacterMeta, type AnimationMeta, type CharacterMeta, type FrameTarget, type UndoableState } from '../../core/model';
import { metaFromState, newFrame, withCamera, withFrames, withReferenceImage, withTargetPose } from '../../core/docState';
import { buildGeneration } from '../../core/generate';
import { idlePose } from '../../core/rig/poses';
import { registerEditorCancel } from '../../services/editorState';
import { toasts } from '../../services/toasts';
import { createMockDoc } from '../mockDoc';
import type { DocHandle } from '../types';
import { hasJobResult, snapshotChanges, withJobResult } from './applyResult';
import { createJobs } from './jobsCore';
import { REF_TARGET, createPlayback } from './playbackCore';

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

function section(name: string): void {
  console.log(`- ${name}`);
}

const CHAR = 'Town/Merchant';
const BASE_UID = uid();

function makeMeta(nFrames: number, fps = 12): AnimationMeta {
  const meta = createAnimationMeta({ canvas: { width: 64, height: 64 }, fps });
  const pose = idlePose(meta.rig);
  meta.reference = { ...meta.reference, image: uid(), sourceBaseUid: BASE_UID, pose };
  meta.frames = Array.from({ length: nFrames }, () => newFrame(pose));
  meta.action = 'walk';
  meta.description = 'a merchant';
  return meta;
}

const frameAt = (doc: DocHandle, i: number): FrameTarget => ({ kind: 'frame', uid: doc.state.value.frames[i].uid });
const indexOf = (doc: DocHandle, t: FrameTarget): number => t.kind === 'ref' ? -1 : doc.state.value.frames.findIndex((f) => f.uid === t.uid);
const deleteFrameAt = (doc: DocHandle, i: number): void => doc.apply('Delete Frame', (s) => withFrames(s, s.frames.filter((_, j) => j !== i)));
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// ---------- fake requestAnimationFrame ----------

class FakeRaf {
  private cbs = new Map<number, (t: number) => void>();
  private n = 0;
  raf = (cb: (t: number) => void): number => {
    this.cbs.set(++this.n, cb);
    return this.n;
  };
  caf = (id: number): void => {
    this.cbs.delete(id);
  };
  frame(t: number): void {
    const list = [...this.cbs.values()];
    this.cbs.clear();
    for (const cb of list)
      cb(t);
  }
  get pending(): number {
    return this.cbs.size;
  }
}

// ---------- playback ----------

function testPlayback(): void {
  section('playback: targets and stepping');
  const docs = shallowReactive(new Map<string, DocHandle>());
  const active = ref<string | null>(null);
  const fr = new FakeRaf();
  const pb = createPlayback({ docs: () => docs, activeDocId: () => active.value, raf: fr.raf, caf: fr.caf });
  const a = createMockDoc(makeMeta(5), { name: 'Walk', charRel: CHAR });
  docs.set(a.id, a);
  active.value = a.id;

  check('default target is REF', pb.target(a.id).kind === 'ref');
  pb.step(-1);
  check('REF − 1 stays REF (no wrap-around)', pb.target(a.id).kind === 'ref');
  pb.step(1);
  check('REF + 1 → frame 1', indexOf(a, pb.target(a.id)) === 0);
  pb.step(-1);
  check('frame 1 − 1 → REF', pb.target(a.id).kind === 'ref');
  for (let i = 0; i < 10; i++)
    pb.step(1);
  check('stepping stops at the last frame', indexOf(a, pb.target(a.id)) === 4);
  pb.step(-1);
  check('last − 1 → frame N−1', indexOf(a, pb.target(a.id)) === 3);
  pb.seekStart();
  check('seekStart → REF', pb.target(a.id).kind === 'ref');
  pb.seekEnd();
  check('seekEnd → last frame', indexOf(a, pb.target(a.id)) === 4);
  check('target object is stable between reads', pb.target(a.id) === pb.target(a.id));

  section('playback: vanished frames');
  pb.setTarget(a.id, frameAt(a, 2));
  const third = a.state.value.frames[2].uid;
  const fourth = a.state.value.frames[3].uid;
  deleteFrameAt(a, 2);
  const t1 = pb.target(a.id);
  check('deleted target → frame now at its index', t1.kind === 'frame' && t1.uid === fourth, JSON.stringify(t1));
  deleteFrameAt(a, 0);
  const t2 = pb.target(a.id);
  check('the resolved frame sticks when earlier frames are deleted', t2.kind === 'frame' && t2.uid === fourth, JSON.stringify(t2));
  a.undo();
  a.undo();
  const t3 = pb.target(a.id);
  check('undo restoring the frame keeps the current (valid) target', t3.kind === 'frame' && t3.uid === fourth && a.state.value.frames.some((f) => f.uid === third));
  pb.seekEnd();
  deleteFrameAt(a, 4);
  check('deleted last frame → new last frame', indexOf(a, pb.target(a.id)) === 3);
  a.apply('Clear', (s) => withFrames(s, []));
  check('empty track → REF', pb.target(a.id).kind === 'ref');
  pb.seekEnd();
  check('seekEnd on an empty track → REF', pb.target(a.id).kind === 'ref');
  pb.step(1);
  check('REF + 1 on an empty track stays REF', pb.target(a.id).kind === 'ref');
  pb.play();
  check('play needs at least one frame', !pb.playing.value && fr.pending === 0);
  a.undo();
  check('undo brings the frames back', a.state.value.frames.length === 4);

  section('playback: play loop');
  const b = createMockDoc(makeMeta(3, 10), { name: 'Run', charRel: CHAR });
  docs.set(b.id, b);
  active.value = b.id;
  pb.play();
  check('play from REF goes to frame 1 at once', pb.playing.value && indexOf(b, pb.target(b.id)) === 0);
  fr.frame(1000);
  check('first tick only starts the clock', indexOf(b, pb.target(b.id)) === 0);
  fr.frame(1099);
  check('no advance before 1/fps', indexOf(b, pb.target(b.id)) === 0);
  fr.frame(1100);
  check('advance after 1/fps (10 fps)', indexOf(b, pb.target(b.id)) === 1);
  fr.frame(1200);
  check('frame 3', indexOf(b, pb.target(b.id)) === 2);
  fr.frame(1300);
  check('loops back to frame 1 (not REF)', indexOf(b, pb.target(b.id)) === 0);
  fr.frame(9000);
  check('a long stall advances one frame only', indexOf(b, pb.target(b.id)) === 1);
  b.setFps(20);
  fr.frame(9050);
  check('fps changes apply while playing (20 fps)', indexOf(b, pb.target(b.id)) === 2);
  pb.setTarget(b.id, frameAt(b, 0));
  check('picking a frame keeps playing', pb.playing.value && indexOf(b, pb.target(b.id)) === 0);
  fr.frame(9080);
  check('picking a frame restarts its timing', indexOf(b, pb.target(b.id)) === 0);
  fr.frame(9100);
  check('… then advances after 1/fps', indexOf(b, pb.target(b.id)) === 1);
  pb.step(1);
  check('step pauses', !pb.playing.value && fr.pending === 0 && indexOf(b, pb.target(b.id)) === 2);
  pb.toggle();
  check('toggle plays from the current frame', pb.playing.value && indexOf(b, pb.target(b.id)) === 2);
  pb.toggle();
  check('toggle pauses', !pb.playing.value && fr.pending === 0);
  pb.play();
  pb.setTarget(b.id, REF_TARGET);
  check('picking REF while playing pauses', !pb.playing.value && pb.target(b.id).kind === 'ref');
  pb.play();
  pb.seekEnd();
  check('seekEnd pauses', !pb.playing.value && indexOf(b, pb.target(b.id)) === 2);
  pb.play();
  active.value = a.id;
  check('switching the active doc pauses', !pb.playing.value && fr.pending === 0);
  check('the other doc keeps its own target', indexOf(b, pb.target(b.id)) === 2 && pb.target(a.id).kind === 'ref');
  pb.play();
  check('the active doc plays', pb.playing.value && indexOf(a, pb.target(a.id)) === 0);
  pb.setTarget(b.id, frameAt(b, 0));
  check('setting a background doc target does not affect playback', pb.playing.value && indexOf(b, pb.target(b.id)) === 0);
  a.apply('Clear', (s) => withFrames(s, []));
  check('emptying the playing track pauses', !pb.playing.value && pb.target(a.id).kind === 'ref');
  pb.play();
  check('play on the empty track is a no-op', !pb.playing.value);
  docs.delete(b.id);
  check('a closed doc loses its target', pb.target(b.id).kind === 'ref');
}

// ---------- the "Generate" producer ----------

function testProducer(): void {
  section('job apply producer');
  const doc = createMockDoc(makeMeta(3), { name: 'Walk', charRel: CHAR });
  const s0 = doc.state.value;
  const { snapshot } = buildGeneration(s0, '');
  const images = [uid(), uid(), uid()];
  const s1 = withJobResult(s0, snapshot, images);
  check('one frame per submitted frame', s1.frames.length === 3);
  check('images in order', s1.frames.every((f, i) => f.image === images[i]));
  check('imageStale false', s1.frames.every((f) => !f.imageStale));
  const oldUids = new Set(s0.frames.map((f) => f.uid));
  check('fresh, unique frame uids', new Set(s1.frames.map((f) => f.uid)).size === 3 && s1.frames.every((f) => !oldUids.has(f.uid)));
  check('poses are the snapshot poses', !snapshotChanges({ ...s1, frames: s1.frames.map((f, i) => ({ ...f, uid: snapshot.frames[i].uid })) }, snapshot).track);
  check('poses are copies', s1.frames.every((f, i) => f.pose !== snapshot.frames[i].pose));
  check('the rest of the state is shared', s1.reference === s0.reference && s1.rig === s0.rig && s1.direction === s0.direction);
  check('input state untouched', s0.frames.length === 3 && s0.frames.every((f) => f.image === null));
  check('hasJobResult', hasJobResult(s1, images) && !hasJobResult(s0, images));
  let threw = false;
  try {
    withJobResult(s0, snapshot, images.slice(0, 2));
  } catch {
    threw = true;
  }
  check('length mismatch throws', threw);

  const roundTrip = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  const none = snapshotChanges(s0, roundTrip);
  check('unchanged track and camera', !none.track && !none.camera);
  const moved = { ...s0.frames[1].pose, root: [s0.frames[1].pose.root[0] + 0.1, s0.frames[1].pose.root[1], s0.frames[1].pose.root[2]] as [number, number, number] };
  const edited = withTargetPose(s0, { kind: 'frame', uid: s0.frames[1].uid }, moved);
  check('a re-posed frame counts as a track change', snapshotChanges(edited, snapshot).track);
  check('a removed frame counts as a track change', snapshotChanges(withFrames(s0, s0.frames.slice(1)), snapshot).track);
  const turned = withCamera(s0, { direction: 'east' }).state;
  const tc = snapshotChanges(turned, snapshot);
  check('a direction change counts as a camera change', tc.camera && !tc.track);
}

// ---------- mock window.api, documents and tabs ----------

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class MockApi {
  files = new Set<string>();
  renames: [string, string][] = [];
  acks: string[] = [];
  cancels: string[] = [];
  flashes = 0;
  estimateCalls: string[] = [];
  submits: SubmitAnimateInput[] = [];
  listed: JobUpdateEvent[] = [];
  full = new Map<string, JobRecord>();
  trashed: string[] = [];
  /** Animation jsons on disk (readJson; scanData lists them). */
  json = new Map<string, { id: string }>();
  estimateAnswer: () => Promise<Result<EstimateResult>> = async () => ({ ok: true, data: { keypoints: fakeKeypoints(0.5), usage: null } });
  /** When set, the next submit answers this instead of creating a job. */
  submitFailure: ((input: SubmitAnimateInput) => SubmitAnimateResult) | null = null;
  private listener: ((ev: JobUpdateEvent) => void) | null = null;

  emit(ev: JobUpdateEvent): void {
    this.listener?.(ev);
  }

  build(): PixelToolkitApi {
    const api = {
      fs: {
        rename: async (from: string, to: string): Promise<void> => {
          if (!this.files.has(from))
            throw new Error(`ENOENT ${from}`);
          if (this.files.has(to))
            throw new Error(`EEXIST ${to}`);
          this.files.delete(from);
          this.files.add(to);
          this.renames.push([from, to]);
        },
        exists: async (rel: string): Promise<boolean> => this.files.has(rel) || [...this.files].some((f) => f.startsWith(`${rel}/`)),
        readJson: async (rel: string): Promise<unknown> => {
          const j = this.json.get(rel);
          if (!j)
            throw new Error(`ENOENT ${rel}`);
          return j;
        },
        scanData: async (): Promise<unknown[]> => [...this.json.keys()].map((rel) => ({ kind: 'animation', name: animNameFromRel(rel), rel, mtimeMs: 0, children: [] })),
        trash: async (rel: string): Promise<void> => {
          this.trashed.push(rel);
        }
      },
      pixellab: {
        estimateSkeleton: (rel: string): Promise<Result<EstimateResult>> => {
          this.estimateCalls.push(rel);
          return this.estimateAnswer();
        }
      },
      jobs: {
        submitAnimate: async (input: SubmitAnimateInput): Promise<SubmitAnimateResult> => {
          this.submits.push(input);
          const fail = this.submitFailure;
          this.submitFailure = null;
          if (fail)
            return fail(input);
          const rec = makeRecord(input.docId, input.animRel, input.frameUids, input.snapshot, 'processing');
          this.full.set(rec.key, rec);
          return { ok: true, data: toEvent(rec) };
        },
        list: async (): Promise<JobUpdateEvent[]> => this.listed,
        get: async (key: string): Promise<JobRecord | null> => this.full.get(key) ?? null,
        ack: async (key: string): Promise<void> => {
          this.acks.push(key);
          this.full.delete(key);
        },
        cancel: async (key: string): Promise<Result<void>> => {
          this.cancels.push(key);
          return { ok: true, data: undefined };
        },
        retarget: async (key: string, animRel: string): Promise<void> => {
          const rec = this.full.get(key);
          if (rec)
            this.full.set(key, { ...rec, animRel });
        }
      },
      app: {
        flashFrame: async (): Promise<void> => {
          this.flashes++;
        }
      },
      on: (_event: string, cb: (ev: JobUpdateEvent) => void): (() => void) => {
        this.listener = cb;
        return () => {
          this.listener = null;
        };
      }
    };
    return api as unknown as PixelToolkitApi;
  }
}

function fakeKeypoints(x: number): KeypointOut[] {
  return SKELETON_LABELS.map((label, i) => ({ label, x, y: i / 20, z_index: -1 }));
}

function makeRecord(docId: string, animRel: string, frameUids: string[], snapshot: JobRecord['snapshot'], status: JobRecord['status'], extra: Partial<JobRecord> = {}): JobRecord {
  const key = uid();
  return {
    key, docId, animRel, refImageRel: 'x.png', status, jobId: 'job-1', submittedAt: Date.now(), updatedAt: Date.now(),
    frameUids, snapshot, stagedFiles: status === 'completed' ? frameUids.map((u) => jobStageFileRel(key, u)) : null,
    error: null, queuePosition: null, etaSec: null, usage: null, ...extra
  };
}

function toEvent(r: JobRecord): JobUpdateEvent {
  const ev: Partial<JobRecord> = { ...r, frameUids: [...r.frameUids], stagedFiles: r.stagedFiles ? [...r.stagedFiles] : null };
  delete ev.snapshot;
  return ev as JobUpdateEvent;
}

class MockDocuments {
  docs = shallowReactive(new Map<string, DocHandle>());
  characters = shallowReactive(new Map<string, CharacterMeta>());
  disk = new Map<string, AnimationMeta>();
  charDisk = new Map<string, CharacterMeta>();
  loads: string[] = [];
  saves: string[] = [];
  unloads: string[] = [];
  charWrites = 0;

  get(id: string): DocHandle | undefined {
    return this.docs.get(id);
  }

  findByRel(rel: string): DocHandle | undefined {
    return [...this.docs.values()].find((d) => d.rel.value.toLowerCase() === rel.toLowerCase());
  }

  async load(rel: string): Promise<DocHandle> {
    const open = this.findByRel(rel);
    if (open)
      return open;
    const meta = this.disk.get(rel);
    if (!meta)
      throw new Error(`missing ${rel}`);
    this.loads.push(rel);
    const doc = createMockDoc(structuredClone(meta), { name: animNameFromRel(rel), charRel: charRelFromAnimRel(rel) });
    this.docs.set(doc.id, doc);
    return doc;
  }

  async save(id: string): Promise<boolean> {
    const d = this.docs.get(id);
    if (!d)
      return false;
    this.disk.set(d.rel.value, metaFromState(d.state.value, { id, fps: d.fps.value }));
    d.markSaved();
    this.saves.push(id);
    return true;
  }

  async unload(id: string): Promise<void> {
    this.docs.delete(id);
    this.unloads.push(id);
  }

  async loadCharacter(charRel: string): Promise<CharacterMeta> {
    const c = this.charDisk.get(charRel);
    if (!c)
      throw new Error(`missing character ${charRel}`);
    this.characters.set(charRel, c);
    return c;
  }

  async updateCharacter(charRel: string, producer: (c: CharacterMeta) => CharacterMeta): Promise<CharacterMeta> {
    const next = producer(await this.loadCharacter(charRel));
    this.charDisk.set(charRel, next);
    this.characters.set(charRel, next);
    this.charWrites++;
    return next;
  }

  /** Put a doc on disk and open it. */
  open(meta: AnimationMeta, name: string): DocHandle {
    const doc = createMockDoc(meta, { name, charRel: CHAR });
    this.disk.set(doc.rel.value, meta);
    this.docs.set(doc.id, doc);
    return doc;
  }
}

function setup(): { mock: MockApi; documents: MockDocuments; tabs: { order: string[]; activeDocId: string | null; opened: string[]; open(rel: string): Promise<DocHandle> }; jobs: ReturnType<typeof createJobs> } {
  const mock = new MockApi();
  Object.assign(globalThis, { window: { api: mock.build() } });
  const documents = new MockDocuments();
  const character = createCharacterMeta();
  character.description = 'a merchant';
  character.baseImages = [{ uid: BASE_UID, label: 'south', direction: 'south', width: 64, height: 64, srcWidth: 64, srcHeight: 64, offset: [0, 0], estimate: null }];
  documents.charDisk.set(CHAR, character);
  const tabs = {
    order: [] as string[],
    activeDocId: null as string | null,
    opened: [] as string[],
    async open(rel: string): Promise<DocHandle> {
      const d = await documents.load(rel);
      if (!this.order.includes(d.id))
        this.order.push(d.id);
      this.activeDocId = d.id;
      this.opened.push(rel);
      return d;
    }
  };
  const jobs = createJobs({ documents: () => documents, tabs: () => tabs, hasFocus: () => false });
  return { mock, documents, tabs, jobs };
}

const toastTitles = (): string[] => toasts.list.map((t) => t.title);

/** A completed record for `doc` as main would hold it: snapshot of the current state, staged PNGs present. */
function completedFor(mock: MockApi, docId: string, animRel: string, state: UndoableState): JobRecord {
  const { snapshot } = buildGeneration(state, '');
  const rec = makeRecord(docId, animRel, snapshot.frames.map(() => uid()), snapshot, 'completed');
  for (const f of rec.stagedFiles ?? [])
    mock.files.add(f);
  mock.full.set(rec.key, rec);
  return rec;
}

// ---------- applying finished jobs ----------

async function testApply(): Promise<void> {
  section('jobs: applying finished records at init');
  toasts.clear();
  const { mock, documents, tabs, jobs } = setup();
  let cancels = 0;
  registerEditorCancel(() => {
    cancels++;
  });

  // A is open (active tab) and edited after submit; B is closed (on disk only)
  const a = documents.open(makeMeta(3), 'Walk');
  tabs.order.push(a.id);
  tabs.activeDocId = a.id;
  const recA = completedFor(mock, a.id, a.rel.value, a.state.value);
  a.apply('Delete Frame', (s) => withFrames(s, s.frames.slice(0, 2)));
  const metaB = makeMeta(4);
  const relB = animJsonRel(CHAR, 'Run');
  documents.disk.set(relB, metaB);
  mock.files.add(relB);
  mock.json.set(relB, { id: metaB.id });
  const recB = completedFor(mock, metaB.id, relB, metaB as UndoableState);
  const recFail = makeRecord(a.id, a.rel.value, [uid()], recA.snapshot, 'failed', { error: 'Content policy violation' });
  const recCancel = makeRecord(a.id, a.rel.value, [uid()], recA.snapshot, 'cancelled');
  for (const r of [recFail, recCancel])
    mock.full.set(r.key, r);
  mock.listed = [recA, recB, recFail, recCancel].map(toEvent);

  await jobs.init();
  await jobs.idle();

  const expectA = recA.frameUids.map((u) => `${CHAR}/Walk.${u}.png`);
  check('A: staged files moved to <charRel>/<name>.<uid>.png', expectA.every((to, i) => mock.renames.some(([f, t]) => f === recA.stagedFiles?.[i] && t === to)));
  check('A: track replaced by the result', hasJobResult(a.state.value, recA.frameUids) && a.state.value.frames.length === 3);
  check('A: one "Generate" undo entry', a.history.peekUndoLabel() === 'Generate');
  check('A: editor interaction cancelled (active doc)', cancels === 1);
  check('A: saved and acked', documents.saves.includes(a.id) && mock.acks.includes(recA.key));
  check('A: success toast with the frame count', toastTitles().includes('Animation generated — Walk (3 frames)'), toastTitles().join(' | '));
  const toastA = toasts.list.find((t) => t.title.includes('Walk (3'));
  check('A: toast notes the track changed since submit', !!toastA?.message?.includes('edited after submitting'), toastA?.message);
  check('A: no Open action for the active doc', !toastA?.action);
  a.undo();
  check('A: undo restores the edited track', a.state.value.frames.length === 2 && !hasJobResult(a.state.value, recA.frameUids));
  a.redo();

  const savedB = documents.disk.get(relB);
  check('B: loaded headless', documents.loads.includes(relB));
  check('B: saved with the result', !!savedB && savedB.frames.length === 4 && savedB.frames.every((f, i) => f.image === recB.frameUids[i]));
  check('B: unloaded again (no tab)', documents.unloads.includes(metaB.id) && !documents.docs.has(metaB.id));
  check('B: acked', mock.acks.includes(recB.key));
  const toastB = toasts.list.find((t) => t.title === 'Animation generated — Run (4 frames)');
  check('B: toast with an Open action', toastB?.action?.label === 'Open');
  toastB?.action?.run();
  await tick();
  check('B: Open opens its tab', tabs.opened.includes(relB));

  check('failed: error toast with the record error and the job id', toasts.list.some((t) => t.kind === 'error' && t.message === 'Content policy violation\nPixelLab job: job-1'));
  check('failed: acked', mock.acks.includes(recFail.key));
  check('cancelled: acked quietly', mock.acks.includes(recCancel.key) && toasts.list.length === 3, toastTitles().join(' | '));
  check('taskbar flashed while unfocused', mock.flashes >= 2);
  check('handled records are removed', jobs.records.value.length === 0);

  section('jobs: double-apply guard');
  const renames = mock.renames.length;
  mock.emit(toEvent(recA));
  await jobs.idle();
  check('a repeated completed event for an acked key is ignored', mock.renames.length === renames && jobs.records.value.length === 0);

  const recC = completedFor(mock, a.id, a.rel.value, a.state.value);
  const evC = toEvent(recC);
  mock.emit(evC);
  mock.emit({ ...evC, updatedAt: evC.updatedAt + 1 });
  await jobs.idle();
  check('two completed events for one key apply once', mock.renames.length === renames + 3 && mock.acks.filter((k) => k === recC.key).length === 1);
  check('… and the doc got exactly one more Generate entry', a.history.peekUndoLabel() === 'Generate' && hasJobResult(a.state.value, recC.frameUids));

  section('jobs: re-run after a crash between apply and ack');
  const recD = completedFor(mock, a.id, a.rel.value, a.state.value);
  // Simulate the earlier run: files already moved and the result applied
  for (let i = 0; i < recD.frameUids.length; i++) {
    mock.files.delete(recD.stagedFiles?.[i] ?? '');
    mock.files.add(`${CHAR}/Walk.${recD.frameUids[i]}.png`);
  }
  a.apply('Generate', (s) => withJobResult(s, recD.snapshot, recD.frameUids));
  const undoCount = a.history.undoCount;
  mock.emit(toEvent(recD));
  await jobs.idle();
  check('already moved files are accepted', mock.acks.includes(recD.key));
  check('an already applied result is not applied twice', a.history.undoCount === undoCount);

  section('jobs: discarded results');
  toasts.clear();
  const ghost = makeRecord(uid(), animJsonRel(CHAR, 'Gone'), [uid(), uid(), uid()], recA.snapshot, 'completed');
  mock.full.set(ghost.key, ghost);
  for (const f of ghost.stagedFiles ?? [])
    mock.files.add(f);
  mock.emit(toEvent(ghost));
  await jobs.idle();
  check('a job of a deleted animation is discarded with a warning', mock.acks.includes(ghost.key) && toasts.list.some((t) => t.kind === 'warning'));
  check('… and its staged images go to the Recycle Bin', mock.trashed.includes(jobStageDirRel(ghost.key)));
  jobs.dispose();
}

// ---------- estimate and submit ----------

async function testEstimateAndSubmit(): Promise<void> {
  section('jobs: estimate');
  toasts.clear();
  const { mock, documents, tabs, jobs } = setup();
  const a = documents.open(makeMeta(3), 'Walk');
  tabs.order.push(a.id);
  tabs.activeDocId = a.id;
  await jobs.init();
  const refUid = a.state.value.reference.image;

  const first = await jobs.estimate(a.id);
  check('no cache → one API call on the reference image path', mock.estimateCalls.length === 1 && mock.estimateCalls[0] === `${CHAR}/Walk.${refUid}.png`, mock.estimateCalls.join());
  check('returns the keypoints', first?.length === 18);
  const cachedBase = documents.charDisk.get(CHAR)?.baseImages[0].estimate;
  check('caches the estimate on the source base image', cachedBase?.keypoints.length === 18 && cachedBase.at !== '');
  const second = await jobs.estimate(a.id);
  check('cached estimate → no API call', mock.estimateCalls.length === 1 && second?.length === 18);
  check('cached result is a copy', second !== cachedBase?.keypoints && second?.[0] !== cachedBase?.keypoints[0]);
  await jobs.estimate(a.id, { force: true });
  check('force → API call', mock.estimateCalls.length === 2);

  const gate = deferred<Result<EstimateResult>>();
  mock.estimateAnswer = () => gate.promise;
  const pending = jobs.estimate(a.id, { force: true });
  await tick();
  check('busy while estimating', jobs.busy(a.id) && jobs.busyUnder('Town') && jobs.busyUnder('town/merchant') && jobs.busyUnder(a.rel.value) && !jobs.busyUnder('Other'));
  check('only one estimate per doc at a time', await jobs.estimate(a.id, { force: true }) === null && mock.estimateCalls.length === 3);
  a.apply('Reference Image', (s) => withReferenceImage(s, { image: uid(), sourceBaseUid: null, width: 64, height: 64 }));
  gate.resolve({ ok: true, data: { keypoints: fakeKeypoints(0.25), usage: null } });
  check('reference image changed during the call → null (stale)', await pending === null);
  check('… with an "Estimate discarded" note', toastTitles().includes('Estimate discarded'));
  check('not busy afterwards', !jobs.busy(a.id) && !jobs.busyUnder('Town'));

  mock.estimateAnswer = async () => ({ ok: false, status: 401, error: 'Invalid API key' });
  check('failure → null', await jobs.estimate(a.id) === null);
  check('failure → error toast', toasts.list.some((t) => t.kind === 'error' && t.title === 'Skeleton estimate failed' && t.message === 'Invalid API key'));

  section('jobs: submit');
  a.undo(); // back to the base-image reference
  const res = await jobs.submitGenerate(a.id);
  const input = mock.submits[0];
  check('submit ok', res.ok && mock.submits.length === 1);
  check('submit paths come from the doc', input.animRel === a.rel.value && input.refImageRel === `${CHAR}/Walk.${refUid}.png`);
  check('one fresh image uid per frame', input.frameUids.length === 3 && new Set(input.frameUids).size === 3);
  check('snapshot = current track', input.snapshot.frames.every((f, i) => f.uid === a.state.value.frames[i].uid));
  check('request: one keypoint set per frame, character description fallback kept', input.request.keypoints.length === 3 && input.request.description === 'a merchant');
  const key = res.ok ? res.data.key : '';
  check('record stored → busy', jobs.busy(a.id) && jobs.activeJob(a.id)?.key === key);
  check('pendingUnder / busyUnder by character and folder', jobs.pendingUnder(CHAR).length === 1 && jobs.pendingUnder('Town').length === 1 && jobs.pendingUnder('Elsewhere').length === 0 && jobs.busyUnder('Town'));
  const again = await jobs.submitGenerate(a.id);
  check('a second submit while busy is refused', !again.ok && mock.submits.length === 1);

  await jobs.cancel(key);
  check('cancel → api.jobs.cancel', mock.cancels[0] === key);
  const rec = mock.full.get(key);
  if (rec)
    mock.emit({ ...toEvent(rec), status: 'cancelled', updatedAt: rec.updatedAt + 1 });
  await jobs.idle();
  check('cancelled update → acked, not busy', mock.acks.includes(key) && !jobs.busy(a.id) && jobs.records.value.length === 0);

  section('jobs: unconfirmed submit (PixelLab may have billed it)');
  toasts.clear();
  mock.submitFailure = (inp) => {
    const error = 'PixelLab did not confirm the submission (timeout). It is unknown whether it accepted and billed the job.';
    const failed = makeRecord(inp.docId, inp.animRel, inp.frameUids, inp.snapshot, 'failed', { jobId: null, error });
    mock.full.set(failed.key, failed);
    return { ok: false, error, record: toEvent(failed) };
  };
  const unconfirmed = await jobs.submitGenerate(a.id);
  await jobs.idle();
  const record = unconfirmed.ok ? null : unconfirmed.record ?? null;
  const errors = toasts.list.filter((t) => t.kind === 'error');
  check('the failed record comes back with the result', !!record);
  check('… one sticky "not confirmed" toast that mentions billing', errors.length === 1 && errors[0].title.startsWith('Generation not confirmed')
    && /billed/.test(errors[0].message ?? '') && errors[0].timeoutMs === 0, errors.map((t) => t.title).join(' | '));
  check('… and the record is acked, not busy', !!record && mock.acks.includes(record.key) && !jobs.busy(a.id));
  mock.submitFailure = (inp) => {
    const failed = makeRecord(inp.docId, inp.animRel, inp.frameUids, inp.snapshot, 'failed', { error: 'Content policy violation' });
    return { ok: false, error: 'nope', record: toEvent(failed) };
  };
  toasts.clear();
  await jobs.submitGenerate(a.id);
  await jobs.idle();
  check('a failed record with a job id names it', toasts.list.length === 1 && toasts.list[0].title.startsWith('Generation failed')
    && (toasts.list[0].message ?? '').includes('PixelLab job: job-1'), toasts.list[0]?.message);
  jobs.dispose();
}

/** This file is type-checked by the web project (no node types). */
const exit = (code: number): void => (globalThis as unknown as { process: { exit(code: number): void } }).process.exit(code);

async function main(): Promise<void> {
  testPlayback();
  testProducer();
  await testApply();
  await testEstimateAndSubmit();
  toasts.clear();
  console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: ${passes} passed, ${failures} failed`);
  exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  exit(1);
});
