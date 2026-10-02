// Generation job service (PLAN §7, resolved-facts R2, R3, R7): journal, submit, poll, decode, stage, push.
// Electron-free: main injects the PixelLab transport and the push function; scripts/test-jobs.ts drives it with a
// fake fetch and a fake clock. Paid jobs are never resubmitted: the journal is written before the POST.
import { promises as fsp } from 'node:fs';
import type { Result } from '../../shared/api';
import {
  JOBS_JOURNAL_REL, JOBS_STAGE_DIR_REL, animImageRel, animNameFromRel, baseNameRel, charRelFromAnimRel, jobStageDirRel,
  jobStageFileRel, parseImageFileName
} from '../../shared/dataPaths';
import {
  FINAL_JOB_STATUSES, validateSubmitInput, type JobRecord, type JobStatus, type JobUpdateEvent, type SubmitAnimateInput,
  type SubmitAnimateResult, type SubmittedSnapshot
} from '../../shared/jobs';
import { finiteOrNull, formatJson, isObj, plainCopy, posInt, type Obj } from '../../shared/json';
import type { AnimateV3Body, AnimateV3Request, Keypoint, Usage } from '../../shared/pixellab';
import { isUid, uid } from '../../shared/uid';
import { atomicWrite, errCode, parseJsonText, resolveChecked, resolveInside, retry } from './dataFs';
import { readCanvasPng } from './imageImport';
import { parseUsage, type PixelLabRequest, type PixelLabResponse } from './pixellabClient';
import { IncompleteResultError, decodeResultImages } from './resultImages';

export const POLL_MS = 6000;
/**
 * Still running this long after submit (time before this session or asleep does not count): the job is stalled. It is
 * never failed or cancelled for that (R3.5): it keeps its id, is polled every MAX_BACKOFF_MS and its error says so.
 */
export const JOB_DEADLINE_MS = 60 * 60 * 1000;
export const MAX_BACKOFF_MS = 5 * 60 * 1000;
export const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;
/** Consecutive 404s before a job counts as gone (PixelLab cleans jobs up some time after completion). */
const MAX_NOT_FOUND = 3;
/** Polls that report 'completed' without all images before giving up (the status can lead the result). */
const MAX_INCOMPLETE = 5;
/** Consecutive failures to stage a finished result (disk full, locked .ptk/jobs) before the job fails with that error. */
const MAX_LOCAL_FAILURES = 3;
const JOB_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
const JOB_STATUSES: readonly JobStatus[] = ['submitting', 'queued', 'processing', 'completed', 'failed', 'cancelled'];
const INTERRUPTED_SUBMIT = 'The app closed while this job was being submitted, so it is unknown whether PixelLab accepted it. '
  + 'It was not resubmitted; check your PixelLab account before generating again.';
const NOT_RESUBMITTED = 'It was not resubmitted; check your PixelLab account before generating again.';

/** Journal entry: the contract record plus main-only bookkeeping (stripped before anything reaches the renderer). */
interface Entry extends JobRecord {
  /** first_frame canvas: the R7 fallback size for raw RGBA results. */
  canvas: { width: number; height: number };
}

interface PollState { nextAt: number; failures: number; notFound: number; incomplete: number; localFailures: number; stalled: boolean; inFlight: boolean }

const newPollState = (nextAt: number): PollState =>
  ({ nextAt, failures: 0, notFound: 0, incomplete: 0, localFailures: 0, stalled: false, inFlight: false });

export interface JobServiceDeps {
  request(req: PixelLabRequest): Promise<PixelLabResponse>;
  /** Push 'jobs:update' to the renderer. */
  emit(ev: JobUpdateEvent): void;
  now?: () => number;
  log?: (msg: string) => void;
  pollMs?: number;
  deadlineMs?: number;
}

const isFinal = (s: JobStatus): boolean => FINAL_JOB_STATUSES.includes(s);
const message = (e: unknown): string => (e as Error)?.message ?? String(e);
const sameUsage = (a: Usage | null, b: Usage | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The record without the snapshot (and without main-only fields). */
function toEvent(e: Entry): JobUpdateEvent {
  return {
    key: e.key, docId: e.docId, animRel: e.animRel, refImageRel: e.refImageRel, status: e.status, jobId: e.jobId,
    submittedAt: e.submittedAt, updatedAt: e.updatedAt, frameUids: [...e.frameUids], stagedFiles: e.stagedFiles ? [...e.stagedFiles] : null,
    error: e.error, queuePosition: e.queuePosition, etaSec: e.etaSec, usage: e.usage
  };
}

/** Untrusted journal json → entry, or null when it cannot be used. */
function sanitizeEntry(v: unknown): Entry | null {
  if (!isObj(v) || !isUid(v.key) || typeof v.docId !== 'string' || typeof v.animRel !== 'string' || typeof v.refImageRel !== 'string')
    return null;
  const frameUids = Array.isArray(v.frameUids) && v.frameUids.every(isUid) ? [...v.frameUids] : null;
  if (!JOB_STATUSES.includes(v.status as JobStatus) || !frameUids || !isObj(v.snapshot) || !Array.isArray(v.snapshot.frames))
    return null;
  const canvas = isObj(v.canvas) ? v.canvas : {};
  const staged = Array.isArray(v.stagedFiles) && v.stagedFiles.every((s) => typeof s === 'string') ? [...v.stagedFiles] : null;
  return {
    key: v.key, docId: v.docId, animRel: v.animRel, refImageRel: v.refImageRel, status: v.status as JobStatus,
    jobId: typeof v.jobId === 'string' && JOB_ID_RE.test(v.jobId) ? v.jobId : null,
    submittedAt: finiteOrNull(v.submittedAt) ?? 0, updatedAt: finiteOrNull(v.updatedAt) ?? 0,
    frameUids, snapshot: v.snapshot as unknown as SubmittedSnapshot, stagedFiles: staged,
    error: typeof v.error === 'string' ? v.error : null,
    queuePosition: finiteOrNull(v.queuePosition), etaSec: finiteOrNull(v.etaSec), usage: parseUsage(v.usage),
    canvas: { width: posInt(canvas.width) ?? 0, height: posInt(canvas.height) ?? 0 }
  };
}

const wireKeypoint = (k: Keypoint): Keypoint =>
  k.depth === undefined ? { label: k.label, x: k.x, y: k.y, z_index: k.z_index } : { label: k.label, x: k.x, y: k.y, z_index: k.z_index, depth: k.depth };

/** Exactly the wire fields (validateAnimateRequest already rejected extra keys; this keeps the body clean regardless). */
function wireRequest(r: AnimateV3Request): AnimateV3Request {
  return {
    description: r.description, action: r.action, direction: r.direction, view: r.view,
    first_frame_keypoints: r.first_frame_keypoints.map(wireKeypoint), keypoints: r.keypoints.map((f) => f.map(wireKeypoint)),
    template_id: r.template_id, seed: r.seed, no_background: r.no_background
  };
}

/** last_response.detail (string or structured), else other message fields. */
function failureText(body: Obj, last: Obj): string {
  for (const v of [last.detail, last.error, last.message, body.detail, body.message]) {
    if (typeof v === 'string' && v.trim() !== '')
      return v;
    if (v !== undefined && v !== null && typeof v === 'object')
      return JSON.stringify(v).slice(0, 1000);
  }
  return 'PixelLab reported the job as failed';
}

export class JobService {
  private entries: Entry[] = [];
  private readonly poll = new Map<string, PollState>();
  private writes: Promise<void> = Promise.resolve();
  /** submitAnimate() calls still running (POST in flight or its answer not journaled yet). */
  private readonly submits = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly pollMs: number;
  private readonly deadlineMs: number;
  /** Start of this session or the last wake from sleep: the stall deadline never counts time before it. */
  private activeSince: number;

  constructor(private readonly deps: JobServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((msg) => console.log(`[jobs] ${msg}`));
    this.pollMs = deps.pollMs ?? POLL_MS;
    this.deadlineMs = deps.deadlineMs ?? JOB_DEADLINE_MS;
    this.activeSince = this.now();
  }

  /**
   * Read the journal (call once, after the data root is set). Interrupted submissions become failed (never resubmitted).
   * A journal that cannot be read rejects (the app does not start), so pending paid jobs are never dropped; an invalid
   * one is copied aside first, then replaced.
   */
  async load(): Promise<void> {
    this.activeSince = this.now();
    const abs = await resolveChecked(JOBS_JOURNAL_REL);
    const text = await this.readJournal(abs);
    let list: unknown[] | null = null;
    if (text !== null) {
      let raw: unknown = null;
      let problem = 'no "jobs" list';
      try {
        raw = parseJsonText(text);
      } catch (e) {
        problem = message(e);
      }
      if (isObj(raw) && Array.isArray(raw.jobs)) {
        list = raw.jobs;
      } else {
        const backup = abs.replace(/\.json$/i, `.corrupt-${this.now()}.json`);
        await retry(() => fsp.copyFile(abs, backup)); // no copy, no reset: the start fails instead
        this.log(`journal unreadable (${problem}); kept a copy at ${backup} and started empty`);
      }
    }
    this.entries = (list ?? []).map(sanitizeEntry).filter((e): e is Entry => e !== null);
    let changed = list !== null && this.entries.length !== list.length;
    if (changed)
      this.log(`dropped ${(list?.length ?? 0) - this.entries.length} unreadable journal entries`);
    for (const e of this.entries) {
      if (e.status === 'submitting' || (!isFinal(e.status) && !e.jobId)) {
        Object.assign(e, { status: 'failed', error: INTERRUPTED_SUBMIT, updatedAt: this.now(), queuePosition: null, etaSec: null });
        changed = true;
      }
    }
    if (changed)
      await this.persist();
    if (list !== null)
      await this.removeOrphanStaging();
  }

  /** The machine woke from sleep: the time asleep does not count toward the stall deadline, and stalled jobs are due now. */
  resetDeadlines(): void {
    this.activeSince = this.now();
    for (const st of this.poll.values()) {
      if (st.stalled)
        st.nextAt = Math.min(st.nextAt, this.activeSince);
    }
  }

  /** Poll now and then every pollMs (6 s) until stop(). */
  start(): void {
    if (this.timer)
      return;
    const run = (): void => {
      this.tick().catch((e) => this.log(`poll round failed: ${message(e)}`));
    };
    this.timer = setInterval(run, this.pollMs);
    run();
  }

  stop(): void {
    if (this.timer)
      clearInterval(this.timer);
    this.timer = null;
  }

  /** One polling round: every non-final job whose backoff has elapsed (the timer calls this; tests call it directly). */
  async tick(): Promise<void> {
    const now = this.now();
    const due = this.entries.filter((e) => {
      const st = this.state(e.key);
      return !isFinal(e.status) && e.status !== 'submitting' && e.jobId !== null && !st.inFlight && st.nextAt <= now;
    });
    await Promise.all(due.map((e) => this.pollOne(e.key)));
  }

  list(): JobUpdateEvent[] {
    return this.entries.filter((e) => e.status !== 'submitting').map(toEvent);
  }

  get(key: string): JobRecord | null {
    const e = this.find(key);
    return e ? { ...toEvent(e), snapshot: e.snapshot } : null;
  }

  /** Image uids pending jobs need (frameUids and reference images): live for the session-created sweep. */
  referencedUids(): Set<string> {
    const out = new Set<string>();
    for (const e of this.entries) {
      for (const u of e.frameUids)
        out.add(u);
      const ref = parseImageFileName(baseNameRel(e.refImageRel));
      if (ref)
        out.add(ref.uid);
    }
    return out;
  }

  /**
   * Validate, journal the intent, POST, then journal the job id. A definite POST failure removes the intent. When
   * PixelLab may have accepted it (timeout, connection lost after connecting, 5xx, or an answer without a usable job id)
   * it becomes a failed record saying so, returned as `record`.
   */
  submitAnimate(input: SubmitAnimateInput): Promise<SubmitAnimateResult> {
    const p = this.submitOnce(input);
    this.submits.add(p);
    const drop = (): void => {
      this.submits.delete(p);
    };
    p.then(drop, drop);
    return p;
  }

  /** Submits still running (app quit waits for them, so an accepted job's id is journaled). */
  pendingSubmits(): number {
    return this.submits.size;
  }

  /** Resolves when every submit running now has finished (each is bounded by its POST timeout). */
  async submitsSettled(): Promise<void> {
    await Promise.allSettled([...this.submits]);
  }

  private async submitOnce(input: SubmitAnimateInput): Promise<SubmitAnimateResult> {
    const errors = validateSubmitInput(input);
    if (errors.length > 0)
      return { ok: false, error: `Invalid generation request: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ''}` };
    if (!/\.json$/i.test(input.animRel) || input.docId.length > 128)
      return { ok: false, error: 'Invalid generation request: animRel must be an animation json path' };
    let ref: { bytes: Uint8Array; width: number; height: number };
    try {
      resolveInside(input.animRel);
      ref = await readCanvasPng(input.refImageRel);
    } catch (e) {
      return { ok: false, error: `Invalid generation request: ${message(e)}` };
    }
    const now = this.now();
    let key = uid();
    while (this.find(key))
      key = uid();
    const entry: Entry = {
      key, docId: input.docId, animRel: input.animRel, refImageRel: input.refImageRel, status: 'submitting', jobId: null,
      submittedAt: now, updatedAt: now, frameUids: [...input.frameUids], snapshot: plainCopy(input.snapshot),
      stagedFiles: null, error: null, queuePosition: null, etaSec: null, usage: null,
      canvas: { width: ref.width, height: ref.height }
    };
    this.entries.push(entry);
    try {
      await this.persist();
    } catch (e) {
      this.remove(key);
      return { ok: false, error: `Could not write the job journal, nothing was sent: ${message(e)}` };
    }

    const body: AnimateV3Body = { ...wireRequest(input.request), first_frame: { type: 'base64', base64: Buffer.from(ref.bytes).toString('base64'), format: 'png' } };
    const res = await this.deps.request({ method: 'POST', path: '/animate-with-skeleton-v3', body, timeoutMs: SUBMIT_TIMEOUT_MS });
    const data = isObj(res.data) ? res.data : {};
    const jobId = data.background_job_id;
    if (!res.ok && !res.maybeSent) {
      this.remove(key);
      await this.persistLogged();
      return { ok: false, status: res.status || undefined, error: res.error ?? `HTTP ${res.status}` };
    }
    let unconfirmed: string | null = null;
    if (!res.ok)
      unconfirmed = `PixelLab did not confirm the submission (${res.error ?? `HTTP ${res.status}`}). It is unknown whether it accepted and billed the job.`;
    else if (typeof jobId !== 'string' || jobId === '')
      unconfirmed = 'PixelLab accepted the submission (it may have been billed) but returned no job id, so its result cannot be fetched.';
    else if (!JOB_ID_RE.test(jobId))
      unconfirmed = `PixelLab accepted the submission (it may have been billed) but returned an unexpected job id (${jobId.slice(0, 200)}), so its result cannot be fetched.`;
    if (unconfirmed !== null) {
      const error = `${unconfirmed} ${NOT_RESUBMITTED}`;
      await this.finish(entry, 'failed', { error });
      return { ok: false, status: res.status || undefined, error, record: toEvent(entry) };
    }
    Object.assign(entry, { jobId, status: 'processing', usage: parseUsage(data.usage), updatedAt: this.now() });
    this.poll.set(key, newPollState(this.now() + this.pollMs));
    await this.persistLogged();
    this.emit(entry);
    return { ok: true, data: toEvent(entry) };
  }

  /** The renderer applied (or discarded) the result: forget the record and delete its staging dir. */
  async ack(key: string): Promise<void> {
    if (!isUid(key))
      throw new Error(`Invalid job key: ${String(key)}`);
    if (this.remove(key))
      await this.persist();
    // The record is gone either way: a dir that cannot be removed now (open handle) is swept at the next start
    await this.removeStaging(key).catch((e) => this.log(`could not remove the staging dir of job ${key}: ${message(e)}`));
  }

  /** DELETE /background-jobs/{id}; a job PixelLab no longer knows (404) counts as cancelled. */
  async cancel(key: string): Promise<Result<void>> {
    const e = this.find(key);
    if (!e)
      return { ok: false, error: 'Unknown job' };
    if (isFinal(e.status))
      return { ok: false, error: `The job is already ${e.status}` };
    if (!e.jobId)
      return { ok: false, error: 'The job is still being submitted; try again in a moment' };
    const res = await this.deps.request({ method: 'DELETE', path: `/background-jobs/${e.jobId}`, timeoutMs: POLL_TIMEOUT_MS });
    const cur = this.find(key);
    if (!cur)
      return { ok: true, data: undefined };
    if (res.ok || res.status === 404) {
      if (!isFinal(cur.status))
        await this.finish(cur, 'cancelled', { usage: parseUsage(isObj(res.data) ? res.data.usage : null) ?? cur.usage });
      return { ok: true, data: undefined };
    }
    if (res.status === 400 || res.status === 409) {
      this.state(key).nextAt = 0;
      await this.pollOne(key); // it finished meanwhile: fetch the final state now
      return { ok: false, status: res.status, error: 'The job already finished on PixelLab' };
    }
    return { ok: false, status: res.status || undefined, error: res.error ?? 'Cancel failed' };
  }

  /** The animation got a fresh id (a json copied outside the app shared its original's): follow it. */
  async rekey(key: string, docId: string): Promise<void> {
    if (typeof docId !== 'string' || docId === '' || docId.length > 128)
      throw new Error('rekey: docId must be a non-empty string');
    const e = this.find(key);
    if (!e || e.docId === docId)
      return;
    e.docId = docId;
    e.updatedAt = this.now();
    await this.persist();
    this.emit(e);
  }

  /** The animation was renamed or moved: follow it (and its animation-owned reference image name). */
  async retarget(key: string, animRel: string): Promise<void> {
    if (typeof animRel !== 'string' || !/\.json$/i.test(animRel))
      throw new Error('retarget: animRel must be an animation json path');
    resolveInside(animRel);
    const e = this.find(key);
    if (!e || e.animRel === animRel)
      return;
    const ref = parseImageFileName(baseNameRel(e.refImageRel));
    if (ref && ref.owner === animNameFromRel(e.animRel))
      e.refImageRel = animImageRel(charRelFromAnimRel(animRel), animNameFromRel(animRel), ref.uid);
    e.animRel = animRel;
    e.updatedAt = this.now();
    await this.persist();
    this.emit(e);
  }

  // ---------- internals ----------

  private find(key: string): Entry | undefined {
    return this.entries.find((e) => e.key === key);
  }

  private remove(key: string): boolean {
    const i = this.entries.findIndex((e) => e.key === key);
    this.poll.delete(key);
    if (i < 0)
      return false;
    this.entries.splice(i, 1);
    return true;
  }

  private state(key: string): PollState {
    let st = this.poll.get(key);
    if (!st) {
      st = newPollState(0);
      this.poll.set(key, st);
    }
    return st;
  }

  private backoff(failures: number): number {
    return Math.min(this.pollMs * 2 ** failures, MAX_BACKOFF_MS);
  }

  /** Atomic journal write of the current entries; writes run one at a time and each rejects on its own failure. */
  private persist(): Promise<void> {
    const run = this.writes.then(async () => {
      const text = formatJson({ version: 1, jobs: this.entries }) + '\n';
      await atomicWrite(await resolveChecked(JOBS_JOURNAL_REL), text, { createDirs: true });
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async persistLogged(): Promise<void> {
    await this.persist().catch((e) => this.log(`journal write failed: ${message(e)}`));
  }

  private emit(e: Entry): void {
    try {
      this.deps.emit(toEvent(e));
    } catch (err) {
      this.log(`emit failed: ${message(err)}`);
    }
  }

  private async finish(e: Entry, status: JobStatus, patch: Partial<Pick<Entry, 'error' | 'stagedFiles' | 'usage'>>): Promise<void> {
    Object.assign(e, { status, queuePosition: null, etaSec: null, updatedAt: this.now() }, patch);
    await this.persistLogged();
    this.emit(e);
  }

  private async removeStaging(key: string): Promise<void> {
    const dir = await resolveChecked(jobStageDirRel(key));
    await retry(() => fsp.rm(dir, { recursive: true, force: true }));
  }

  /** The journal text; null when there is none. Other errors (a lock outlasting retry()) reject: never start empty. */
  private async readJournal(abs: string): Promise<string | null> {
    try {
      return await retry(() => fsp.readFile(abs, 'utf8'));
    } catch (e) {
      if (errCode(e) === 'ENOENT')
        return null;
      throw new Error(`Could not read the job journal ${abs} (${message(e)}). Close programs that may lock it, then start PixelToolkit again.`);
    }
  }

  /** Staging dirs without a journal entry (an ack whose delete failed, or an older journal reset). Best effort, logged. */
  private async removeOrphanStaging(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(await resolveChecked(JOBS_STAGE_DIR_REL));
    } catch (e) {
      if (errCode(e) !== 'ENOENT')
        this.log(`could not list the staging dirs: ${message(e)}`);
      return;
    }
    for (const key of names.filter((n) => isUid(n) && !this.find(n))) {
      await this.removeStaging(key).then(
        () => this.log(`removed the orphaned staging dir of job ${key}`),
        (e) => this.log(`could not remove the orphaned staging dir of job ${key}: ${message(e)}`));
    }
  }

  private async pollOne(key: string): Promise<void> {
    const entry = this.find(key);
    if (!entry || !entry.jobId || isFinal(entry.status))
      return;
    const st = this.state(key);
    st.inFlight = true;
    try {
      const res = await this.deps.request({ method: 'GET', path: `/background-jobs/${entry.jobId}`, timeoutMs: POLL_TIMEOUT_MS });
      const e = this.find(key);
      if (!e || isFinal(e.status))
        return;
      if (!res.ok) {
        await this.onPollError(e, st, res);
        return;
      }
      st.notFound = 0;
      await this.applyPoll(e, st, res.data);
      // Reset only once the answer was handled: a staging failure (catch below) keeps growing the backoff
      Object.assign(st, { failures: 0, localFailures: 0, nextAt: this.now() + (st.stalled ? MAX_BACKOFF_MS : this.pollMs) });
    } catch (err) {
      st.failures++;
      st.nextAt = this.now() + this.backoff(st.failures);
      this.log(`job ${key}: handling the poll result failed (${message(err)}); retrying in ${Math.round(this.backoff(st.failures) / 1000)} s`);
    } finally {
      st.inFlight = false;
    }
  }

  private async onPollError(e: Entry, st: PollState, res: PixelLabResponse): Promise<void> {
    st.notFound = res.status === 404 ? st.notFound + 1 : 0;
    if (st.notFound >= MAX_NOT_FOUND) {
      await this.finish(e, 'failed', { error: `PixelLab no longer has job ${e.jobId} (404 Not Found)` });
      return;
    }
    st.failures++;
    const wait = this.backoff(st.failures);
    st.nextAt = this.now() + wait;
    this.log(`job ${e.key}: poll failed (${res.status || 'no response'}: ${res.error ?? ''}); retrying in ${Math.round(wait / 1000)} s`);
  }

  private async applyPoll(e: Entry, st: PollState, data: unknown): Promise<void> {
    const body = isObj(data) ? data : {};
    const status = typeof body.status === 'string' ? body.status.toLowerCase() : '';
    const last = isObj(body.last_response) ? body.last_response : {};
    const usage = parseUsage(body.usage) ?? parseUsage(last.billing_usage) ?? e.usage;
    st.stalled = false;
    if (status === 'completed') {
      await this.complete(e, st, last, usage);
      return;
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled') {
      await this.finish(e, 'failed', { error: failureText(body, last), usage });
      return;
    }
    const queuePosition = finiteOrNull(last.queue_position);
    const etaSec = finiteOrNull(last.estimated_wait_seconds);
    const next: JobStatus = queuePosition !== null ? 'queued' : 'processing';
    // The deadline only counts PixelLab saying "still running" (never a transport error, a 404 or an incomplete result)
    st.stalled = this.now() - Math.max(e.submittedAt, this.activeSince) > this.deadlineMs;
    const error = st.stalled
      ? `No result after ${Math.round(this.deadlineMs / 60_000)} min. PixelLab job ${e.jobId} was not cancelled and may still finish; `
        + `it is now checked every ${Math.round(MAX_BACKOFF_MS / 60_000)} min (cancel it to stop).`
      : null;
    if (next === e.status && queuePosition === e.queuePosition && etaSec === e.etaSec && sameUsage(usage, e.usage) && error === e.error)
      return;
    Object.assign(e, { status: next, queuePosition, etaSec, usage, error, updatedAt: this.now() });
    await this.persistLogged();
    this.emit(e);
  }

  private async complete(e: Entry, st: PollState, last: Obj, usage: Usage | null): Promise<void> {
    let pngs: Uint8Array[];
    try {
      pngs = decodeResultImages(last.images, e.frameUids.length, e.canvas);
    } catch (err) {
      if (err instanceof IncompleteResultError && ++st.incomplete < MAX_INCOMPLETE) {
        this.log(`job ${e.key}: completed but ${err.message}; polling again`);
        return;
      }
      await this.finish(e, 'failed', { error: `PixelLab finished job ${e.jobId}, but its images could not be read: ${message(err)}`, usage });
      return;
    }
    const staged = e.frameUids.map((u) => jobStageFileRel(e.key, u));
    try {
      for (let i = 0; i < staged.length; i++)
        await atomicWrite(await resolveChecked(staged[i]), pngs[i], { createDirs: true });
    } catch (err) {
      if (++st.localFailures < MAX_LOCAL_FAILURES)
        throw err; // pollOne backs off (12 s, 24 s) and re-polls
      await this.finish(e, 'failed', { error: `PixelLab finished job ${e.jobId}, but saving its images failed: ${message(err)}`, usage });
      return;
    }
    const cur = this.find(e.key);
    if (!cur) {
      await this.removeStaging(e.key); // acked while staging
      return;
    }
    if (!isFinal(cur.status))
      await this.finish(cur, 'completed', { stagedFiles: staged, usage, error: null });
  }
}
