// Node environment for selftest.ts: a stubbed browser (window, document, element classes) and an in-memory window.api
// whose fs mimics main's rules (non-recursive writes and mkdir, case-insensitive rename conflicts, scanData shape).
// Imported FIRST by the self-test so services that touch window / document at load time see the stubs.
import { formatJson } from '@shared/json';
import type { DirEntry, ImportedImage, PixelToolkitApi, ScanNode } from '@shared/api';
import { joinRel, parentRel, baseNameRel } from '@shared/dataPaths';
import type { JobUpdateEvent } from '@shared/jobs';
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '@shared/settings';
import { uid } from '@shared/uid';

type Entry = { kind: 'dir' } | { kind: 'file'; data: string | Uint8Array; mtime: number };

const enoent = (rel: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${rel}'`), { code: 'ENOENT' });

export class MemFs {
  /** lowercase rel → actual rel + entry. The root '' always exists. */
  readonly entries = new Map<string, { rel: string; e: Entry }>();
  clock = 1000;
  /** Test hook: rename() rejects when the target matches. */
  failRename: RegExp | null = null;
  readonly writes: string[] = [];

  get(rel: string): Entry | undefined {
    return this.entries.get(rel.toLowerCase())?.e;
  }

  isDir(rel: string): boolean {
    return rel === '' || this.get(rel)?.kind === 'dir';
  }

  has(rel: string): boolean {
    return rel === '' || this.entries.has(rel.toLowerCase());
  }

  /** Exact-case file name present (for case-only rename checks). */
  actual(rel: string): string | undefined {
    return this.entries.get(rel.toLowerCase())?.rel;
  }

  mkdirp(rel: string): void {
    if (rel === '' || this.isDir(rel))
      return;
    this.mkdirp(parentRel(rel));
    this.entries.set(rel.toLowerCase(), { rel, e: { kind: 'dir' } });
  }

  put(rel: string, data: string | Uint8Array): void {
    if (!this.isDir(parentRel(rel)))
      throw enoent(parentRel(rel));
    this.entries.set(rel.toLowerCase(), { rel, e: { kind: 'file', data, mtime: ++this.clock } });
  }

  putJson(rel: string, data: unknown): void {
    this.put(rel, formatJson(data) + '\n');
  }

  text(rel: string): string {
    const e = this.get(rel);
    if (!e || e.kind !== 'file' || typeof e.data !== 'string')
      throw enoent(rel);
    return e.data;
  }

  json<T = unknown>(rel: string): T {
    return JSON.parse(this.text(rel)) as T;
  }

  remove(rel: string): void {
    const k = rel.toLowerCase();
    for (const key of [...this.entries.keys()]) {
      if (key === k || key.startsWith(k + '/'))
        this.entries.delete(key);
    }
  }

  children(rel: string): { name: string; rel: string; e: Entry }[] {
    const k = rel.toLowerCase();
    return [...this.entries.values()].filter((x) => parentRel(x.rel).toLowerCase() === k)
      .map((x) => ({ name: baseNameRel(x.rel), rel: x.rel, e: x.e }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }

  files(dir: string): string[] {
    return this.children(dir).filter((c) => c.e.kind === 'file').map((c) => c.name);
  }

  private rename(from: string, to: string): void {
    const src = this.entries.get(from.toLowerCase());
    if (!src)
      throw enoent(from);
    if (!this.isDir(parentRel(to)))
      throw Object.assign(new Error(`Cannot rename to "${to}": the target folder does not exist`), { code: 'ENOENT' });
    if (this.failRename?.test(to))
      throw new Error(`EBUSY: simulated failure renaming to "${to}"`);
    const same = from.toLowerCase() === to.toLowerCase();
    if (!same && this.has(to))
      throw Object.assign(new Error(`"${to}" already exists`), { code: 'EEXIST' });
    const prefix = from.toLowerCase();
    const moved = [...this.entries.values()].filter((x) => x.rel.toLowerCase() === prefix || x.rel.toLowerCase().startsWith(prefix + '/'));
    for (const x of moved)
      this.entries.delete(x.rel.toLowerCase());
    for (const x of moved) {
      const rel = to + x.rel.slice(from.length);
      this.entries.set(rel.toLowerCase(), { rel, e: x.e });
    }
  }

  private scanCharacter(charRel: string, jsonRel: string): ScanNode {
    const anims = this.children(charRel).filter((c) => c.e.kind === 'file' && /\.json$/i.test(c.name))
      .map((c): ScanNode => ({ kind: 'animation', name: c.name.slice(0, -5), rel: c.rel, mtimeMs: (c.e as { mtime: number }).mtime, children: [] }));
    return { kind: 'character', name: baseNameRel(charRel), rel: charRel, mtimeMs: (this.get(jsonRel) as { mtime: number }).mtime, children: anims };
  }

  private scanLevel(rel: string, folders: boolean): ScanNode[] {
    const kids = this.children(rel).filter((c) => !c.name.startsWith('.'));
    const jsons = new Map(kids.filter((c) => c.e.kind === 'file' && /\.json$/i.test(c.name)).map((c) => [c.name.slice(0, -5).toLowerCase(), c]));
    const out: ScanNode[] = [];
    for (const d of kids.filter((c) => c.e.kind === 'dir')) {
      const json = jsons.get(d.name.toLowerCase());
      if (json) {
        jsons.delete(d.name.toLowerCase());
        out.push(this.scanCharacter(d.rel, json.rel));
      } else if (folders) {
        out.push({ kind: 'folder', name: d.name, rel: d.rel, mtimeMs: null, children: this.scanLevel(d.rel, false) });
      }
    }
    for (const j of jsons.values())
      out.push({ kind: 'brokenCharacter', name: j.name.slice(0, -5), rel: joinRel(rel, j.name.slice(0, -5)), mtimeMs: (j.e as { mtime: number }).mtime, children: [] });
    return out;
  }

  api(): PixelToolkitApi['fs'] {
    return {
      readJson: async <T>(rel: string): Promise<T> => this.json<T>(rel),
      writeJson: async (rel, data, opts) => {
        const copy = structuredClone(data); // like IPC: proxies / functions throw
        if (opts?.createDirs)
          this.mkdirp(parentRel(rel));
        if (!this.isDir(parentRel(rel)))
          throw Object.assign(new Error(`Cannot write "${baseNameRel(rel)}": its folder no longer exists`), { code: 'ENOENT' });
        this.putJson(rel, copy);
        this.writes.push(rel);
        return (this.get(rel) as { mtime: number }).mtime;
      },
      readBinary: async (rel) => {
        const e = this.get(rel);
        if (!e || e.kind !== 'file')
          throw enoent(rel);
        return typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data;
      },
      writeBinary: async (rel, bytes, opts) => {
        if (opts?.createDirs)
          this.mkdirp(parentRel(rel));
        this.put(rel, bytes);
      },
      rename: async (from, to) => this.rename(from, to),
      mkdir: async (rel) => {
        if (!this.isDir(parentRel(rel)))
          throw enoent(parentRel(rel));
        this.mkdirp(rel);
      },
      trash: async (rel) => {
        if (!this.has(rel))
          throw enoent(rel);
        this.remove(rel);
      },
      deleteFiles: async (rels) => {
        const deleted: string[] = [];
        const failed: string[] = [];
        for (const rel of rels) {
          const e = this.get(rel);
          if (e?.kind === 'dir') {
            failed.push(rel);
            continue;
          }
          this.remove(rel);
          deleted.push(rel);
        }
        return { deleted, failed };
      },
      exists: async (rel) => this.has(rel),
      scanData: async () => this.scanLevel('', true),
      listDir: async (rel): Promise<DirEntry[]> => this.children(rel).filter((c) => !c.name.startsWith('.') && !/\.tmp$/i.test(c.name))
        .map((c) => ({ name: c.name, kind: c.e.kind === 'dir' ? 'dir' : 'file' }))
    };
  }
}

export const memFs = new MemFs();

/** Fake jobs store (deps.jobs is pointed at it): records the test edits directly, plus retarget / rekey calls. */
export const fakeJobs = {
  records: [] as JobUpdateEvent[],
  retargets: [] as { key: string; animRel: string }[],
  rekeys: [] as { key: string; docId: string }[],
  busy(docId: string): boolean {
    return fakeJobs.records.some((r) => r.docId === docId && !['completed', 'failed', 'cancelled'].includes(r.status));
  }
};

export function fakeJob(docId: string, animRel: string, frameUids: string[], status: JobUpdateEvent['status'] = 'processing'): JobUpdateEvent {
  const rec: JobUpdateEvent = {
    key: uid(), docId, animRel, refImageRel: '', status, jobId: 'pl-1', submittedAt: 0, updatedAt: 0, frameUids,
    stagedFiles: null, error: null, queuePosition: null, etaSec: null, usage: null
  };
  fakeJobs.records.push(rec);
  return rec;
}

let settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
settings.app.autoSaveIntervalSec = 0;

const api: PixelToolkitApi = {
  fs: memFs.api(),
  settings: {
    read: async () => structuredClone(settings),
    write: async (patch: SettingsPatch) => {
      const next = structuredClone(settings) as unknown as Record<string, Record<string, unknown>>;
      for (const [k, v] of Object.entries(patch))
        next[k] = { ...next[k], ...v };
      settings = next as unknown as AppSettings;
      return structuredClone(settings);
    }
  },
  images: {
    importBase: async () => null,
    importReference: async (charRel: string, animName: string): Promise<ImportedImage> => {
      const id = uid();
      memFs.put(joinRel(charRel, `${animName}.${id}.png`), new Uint8Array([1, 2, 3]));
      return { uid: id, width: 64, height: 64, srcWidth: 64, srcHeight: 64, offset: [0, 0], sourceName: 'x' };
    },
    copyToAnimation: async () => ({ uid: uid() })
  },
  files: {
    openImage: async () => null,
    savePng: async () => null
  },
  pixellab: {
    balance: async () => ({ ok: false, error: 'offline' }),
    estimateSkeleton: async () => ({ ok: false, error: 'offline' })
  },
  jobs: {
    submitAnimate: async () => ({ ok: false, error: 'offline' }),
    list: async () => [],
    get: async () => null,
    ack: async () => undefined,
    cancel: async () => ({ ok: false, error: 'offline' }),
    retarget: async (key: string, animRel: string) => {
      fakeJobs.retargets.push({ key, animRel });
      const r = fakeJobs.records.find((x) => x.key === key);
      if (r)
        r.animRel = animRel;
    },
    rekey: async (key: string, docId: string) => {
      fakeJobs.rekeys.push({ key, docId });
      const r = fakeJobs.records.find((x) => x.key === key);
      if (r)
        r.docId = docId;
    }
  },
  app: {
    closeReady: async () => undefined,
    revealInExplorer: async () => undefined,
    flashFrame: async () => undefined,
    getInfo: async () => ({ dataRoot: '/data', appRoot: '/', isDev: true })
  },
  on: () => () => undefined
};

// ---------- browser stubs ----------

type Listener = (e: unknown) => void;
export const windowListeners = new Map<string, Listener[]>();

class StubNode {}
class StubElement extends StubNode {}
class StubHTMLElement extends StubElement {
  isContentEditable = false;
  isConnected = true;
  blurred = 0;
  blur(): void {
    this.blurred++;
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = null;
  }
  focus(): void {
    (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = this;
  }
  closest(): null {
    return null;
  }
}
class StubHTMLInputElement extends StubHTMLElement {
  type = 'text';
}
class StubHTMLTextAreaElement extends StubHTMLElement {}
class StubHTMLSelectElement extends StubHTMLElement {}

const g = globalThis as unknown as Record<string, unknown>;
g.Node = StubNode;
g.Element = StubElement;
g.HTMLElement = StubHTMLElement;
g.HTMLInputElement = StubHTMLInputElement;
g.HTMLTextAreaElement = StubHTMLTextAreaElement;
g.HTMLSelectElement = StubHTMLSelectElement;
g.document = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined, createElement: () => ({}) };
g.window = {
  api,
  innerWidth: 800,
  innerHeight: 600,
  addEventListener: (type: string, cb: Listener) => {
    windowListeners.set(type, [...windowListeners.get(type) ?? [], cb]);
  },
  removeEventListener: (type: string, cb: Listener) => {
    windowListeners.set(type, (windowListeners.get(type) ?? []).filter((x) => x !== cb));
  }
};

export const StubInput = StubHTMLInputElement;

/** Dispatch a fake keydown to the window listeners (services/shortcuts). */
export function keydown(combo: { key: string; ctrl?: boolean; shift?: boolean; target?: unknown }): boolean {
  let prevented = false;
  const e = {
    key: combo.key, ctrlKey: !!combo.ctrl, shiftKey: !!combo.shift, altKey: false, metaKey: false, repeat: false,
    isComposing: false, defaultPrevented: false, target: combo.target ?? null,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => undefined
  };
  for (const cb of windowListeners.get('keydown') ?? [])
    cb(e);
  return prevented;
}

/** Fire a fake beforeunload; true when a listener prevented it. */
export function beforeUnload(): boolean {
  let prevented = false;
  const e = {
    returnValue: undefined as unknown,
    preventDefault: () => {
      prevented = true;
    }
  };
  for (const cb of windowListeners.get('beforeunload') ?? [])
    cb(e);
  return prevented;
}
