// npm run test:main (or npx tsx scripts/test-jobs.ts)
// The main-process job service (src/main/core/jobService.ts) against a FAKE PixelLab (fake fetch + fake clock):
// queued → processing → completed for every result image shape, 429 / 5xx / network backoff, failures, 404s, the
// deadline, cancel, ack, retarget, POST failures and a restart that resumes from the journal without resubmitting.
// No network, no Electron, no generations spent. Temp dirs go under PT_TEST_TMP (default: os.tmpdir()).
import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JOBS_JOURNAL_REL, animImageFileName, jobStageDirRel, jobStageFileRel } from '../src/shared/dataPaths';
import type { JobUpdateEvent, SubmitAnimateInput } from '../src/shared/jobs';
import { SKELETON_LABELS, type AnimateV3Request, type Keypoint } from '../src/shared/pixellab';
import { uid } from '../src/shared/uid';
import { setDataRoot } from '../src/main/core/dataFs';
import { JobService, MAX_BACKOFF_MS, POLL_MS } from '../src/main/core/jobService';
import { PixelLabClient, type FetchLike, type FetchResponseLike } from '../src/main/core/pixellabClient';
import { decodePng, encodePng } from '../src/main/png';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_128 = path.join(ROOT, 'testbed', 'fixtures', 'merchant_rightfacing_truepixel_128.png');
const CANVAS = 128;

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

// ---------- fake PixelLab ----------

/** One scripted poll answer: an HTTP response, or a thrown network error. */
type Step = { status: number; body: unknown } | 'network';

const ok = (body: unknown): Step => ({ status: 200, body });
const queued = ok({ id: 'x', status: 'processing', created_at: '2026-10-02T00:00:00Z', last_response: { queue_position: 3, estimated_wait_seconds: 120 } });
const processing = ok({ id: 'x', status: 'processing', created_at: '2026-10-02T00:00:00Z', last_response: { progress: 0.4 } });
const completed = (images: unknown[]): Step => ok({ status: 'completed', last_response: { images }, usage: { type: 'generations', generations: 2 } });

class FakePixelLab {
  posts: { auth: string; body: Record<string, unknown> }[] = [];
  gets = new Map<string, number>();
  deletes: string[] = [];
  /** Scripts handed to the next created jobs, in order. */
  scripts: Step[][] = [];
  /** When set, the next POST answers this instead of creating a job. */
  postFailure: { status: number; body: unknown } | null = null;
  /** When set, POSTs never answer (simulates a crash mid-submit). */
  hangPosts = false;
  jobs = new Map<string, { script: Step[]; i: number }>();
  private n = 0;

  getCount(jobId: string | null): number {
    return jobId ? this.gets.get(jobId) ?? 0 : 0;
  }

  fetch: FetchLike = async (url, init) => {
    const res = (status: number, body: unknown): FetchResponseLike => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    const p = new URL(url).pathname.replace(/^\/v2/, '');
    if (init.method === 'POST' && p === '/animate-with-skeleton-v3') {
      if (this.hangPosts)
        return new Promise<FetchResponseLike>(() => undefined);
      this.posts.push({ auth: init.headers.Authorization, body: JSON.parse(init.body ?? '{}') as Record<string, unknown> });
      if (this.postFailure) {
        const f = this.postFailure;
        this.postFailure = null;
        return res(f.status, f.body);
      }
      const id = `123e4567-e89b-12d3-a456-${String(++this.n).padStart(12, '0')}`;
      this.jobs.set(id, { script: this.scripts.shift() ?? [processing], i: 0 });
      return res(200, { background_job_id: id, status: 'processing', usage: null });
    }
    const m = /^\/background-jobs\/(.+)$/.exec(p);
    const job = m ? this.jobs.get(m[1]) : undefined;
    if (m && init.method === 'DELETE') {
      this.deletes.push(m[1]);
      return job ? res(200, { id: m[1], status: 'failed', message: 'Cancelled by user', usage: { type: 'generations', generations: 0 } }) : res(404, { detail: 'Not found' });
    }
    if (m && init.method === 'GET') {
      this.gets.set(m[1], (this.gets.get(m[1]) ?? 0) + 1);
      if (!job)
        return res(404, { detail: 'Job not found' });
      const step = job.script[Math.min(job.i++, job.script.length - 1)];
      if (step === 'network')
        throw new Error('ECONNRESET');
      return res(step.status, step.body);
    }
    return res(404, { detail: 'Not Found' });
  };
}

// ---------- fixtures ----------

const frame = (dx: number): Keypoint[] => SKELETON_LABELS.map((label, i) => ({ label, x: 0.3 + 0.02 * (i % 9) + dx, y: 0.2 + 0.03 * i, z_index: i % 3 }));

const request = (): AnimateV3Request => ({
  description: 'knight in silver plate armour', action: 'walk', direction: 'south', view: 'low top-down',
  first_frame_keypoints: frame(0), keypoints: [frame(0), frame(0.01), frame(0.02)], template_id: 'mannequin', seed: 0, no_background: true
});

const pose = { root: [0, 0.35, 0], rot: {} };

function submitInput(refImageRel: string, animRel = 'Town/Merchant/Walk.json'): SubmitAnimateInput {
  return {
    docId: 'doc00001', animRel, refImageRel, request: request(), frameUids: [uid(), uid(), uid()],
    snapshot: { frames: [0, 1, 2].map((i) => ({ uid: `frame00${i}`, pose })), direction: 'south', view: 'low top-down', pitchDeg: 20 }
  } as unknown as SubmitAnimateInput;
}

/** Frame i of a result is a solid colour (40·(i+1), 7, 99, 255) so order and decoding can be verified. */
const rgba = (i: number, w = CANVAS, h = CANVAS): Uint8Array => {
  const data = new Uint8Array(w * h * 4);
  for (let p = 0; p < data.length; p += 4)
    data.set([40 * (i + 1), 7, 99, 255], p);
  return data;
};
const pngB64 = (i: number): string => Buffer.from(encodePng({ width: CANVAS, height: CANVAS, data: rgba(i) })).toString('base64');
const rawB64 = (i: number, w = CANVAS, h = CANVAS): string => Buffer.from(rgba(i, w, h)).toString('base64');

/** Every result image shape of docs/pixellab.md "Background jobs" (U2), plus a nested object. */
const SHAPES: { name: string; image(i: number): unknown; size?: number }[] = [
  { name: 'bare base64 PNG string', image: (i) => pngB64(i) },
  { name: 'data: URI string', image: (i) => `data:image/png;base64,${pngB64(i)}` },
  { name: '{type: base64} PNG', image: (i) => ({ type: 'base64', base64: pngB64(i), format: 'png' }) },
  { name: '{type: base64} with data: prefix and size', image: (i) => ({ type: 'base64', base64: `data:image/png;base64,${pngB64(i)}`, width: CANVAS, height: CANVAS }) },
  { name: '{type: rgba_bytes} with width/height', image: (i) => ({ type: 'rgba_bytes', base64: rawB64(i, 16, 16), width: 16, height: 16 }), size: 16 },
  { name: '{type: rgba_bytes} without size (first_frame fallback)', image: (i) => ({ type: 'rgba_bytes', base64: rawB64(i) }) },
  { name: 'untyped raw RGBA of the canvas size', image: (i) => ({ base64: rawB64(i) }) },
  { name: 'nested {image: {base64}}', image: (i) => ({ image: { base64: pngB64(i) } }) },
  { name: 'mixed shapes', image: (i) => [pngB64(0), { type: 'rgba_bytes', base64: rawB64(1) }, { base64: `data:image/png;base64,${pngB64(2)}` }][i] }
];

async function main(): Promise<void> {
  const base = await fsp.mkdtemp(path.join(process.env['PT_TEST_TMP'] || os.tmpdir(), 'ptk-jobs-'));
  const root = await setDataRoot(path.join(base, 'data'));
  const abs = (rel: string): string => path.join(root, ...rel.split('/'));
  await fsp.mkdir(abs('Town/Merchant'), { recursive: true });
  const refUid = uid();
  const refRel = `Town/Merchant/${animImageFileName('Walk', refUid)}`;
  await fsp.copyFile(FIXTURE_128, abs(refRel));

  const fake = new FakePixelLab();
  const client = new PixelLabClient({ fetch: fake.fetch, getConfig: async () => ({ apiKey: 'test-key', baseUrl: 'https://api.pixellab.ai/v2' }) });
  let clock = 1_000_000;
  const events: JobUpdateEvent[] = [];
  const logs: string[] = [];
  const makeService = (): JobService => new JobService({
    request: (r) => client.request(r), emit: (ev) => events.push(ev), now: () => clock, log: (m) => logs.push(m)
  });
  const svc = makeService();
  await svc.load();
  const advance = async (ms: number, s = svc): Promise<void> => {
    clock += ms;
    await s.tick();
  };
  const journal = (): { jobs: { key: string; status: string; jobId: string | null }[] } => JSON.parse(readFileSync(abs(JOBS_JOURNAL_REL), 'utf8'));
  const statusesOf = (key: string): string[] => events.filter((e) => e.key === key).map((e) => e.status);

  // ---- validation and POST failures: nothing journaled, nothing spent ----
  console.log('submit validation');
  const bad = submitInput(refRel);
  bad.request.keypoints[1][3].z_index = 0.5;
  const badRes = await svc.submitAnimate(bad);
  check('invalid request refused before the POST', !badRes.ok && /z_index must be an integer/.test(badRes.error) && fake.posts.length === 0, JSON.stringify(badRes));
  const badRef = await svc.submitAnimate(submitInput('Town/Merchant/missing.png'));
  check('missing reference refused', !badRef.ok && fake.posts.length === 0);
  fake.postFailure = { status: 422, body: { detail: [{ loc: ['body', 'keypoints'], msg: 'bad keypoints' }] } };
  const postFail = await svc.submitAnimate(submitInput(refRel));
  check('POST failure → ok:false with the detail', !postFail.ok && postFail.status === 422 && /body\.keypoints: bad keypoints/.test(postFail.error), JSON.stringify(postFail));
  check('POST failure removes the intent', journal().jobs.length === 0 && svc.list().length === 0 && events.length === 0);

  // ---- every result image shape: queued → processing → completed ----
  console.log('R7 shapes: queued → processing → completed');
  const shapeJobs: { shape: typeof SHAPES[number]; ev: JobUpdateEvent }[] = [];
  for (const shape of SHAPES) {
    fake.scripts.push([queued, processing, completed([0, 1, 2].map((i) => shape.image(i)))]);
    const res = await svc.submitAnimate(submitInput(refRel));
    check(`submit (${shape.name})`, res.ok && res.data.status === 'processing' && !!res.data.jobId, JSON.stringify(res));
    if (res.ok)
      shapeJobs.push({ shape, ev: res.data });
  }
  const post = fake.posts[1];
  const firstFrame = post.body.first_frame as { type: string; base64: string; format: string };
  check('POST auth header', post.auth === 'Bearer test-key');
  check('POST body has exactly the wire keys', JSON.stringify(Object.keys(post.body).sort()) === JSON.stringify(
    ['action', 'description', 'direction', 'first_frame', 'first_frame_keypoints', 'keypoints', 'no_background', 'seed', 'template_id', 'view']));
  check('first_frame is the reference PNG', firstFrame.type === 'base64' && firstFrame.format === 'png'
    && Buffer.from(firstFrame.base64, 'base64').equals(readFileSync(abs(refRel))));
  check('journal holds the job ids', journal().jobs.length === SHAPES.length && journal().jobs.every((j) => !!j.jobId && j.status === 'processing'));
  await advance(POLL_MS - 1);
  check('no poll before 6 s', shapeJobs.every((j) => fake.getCount(j.ev.jobId) === 0));
  await advance(1);
  check('queued after the first poll', shapeJobs.every((j) => svc.get(j.ev.key)?.status === 'queued' && svc.get(j.ev.key)?.queuePosition === 3 && svc.get(j.ev.key)?.etaSec === 120));
  await advance(POLL_MS);
  check('processing after the second poll', shapeJobs.every((j) => svc.get(j.ev.key)?.status === 'processing' && svc.get(j.ev.key)?.queuePosition === null));
  await advance(POLL_MS);
  for (const { shape, ev } of shapeJobs) {
    const rec = svc.get(ev.key);
    const want = ev.frameUids.map((u) => jobStageFileRel(ev.key, u));
    check(`completed (${shape.name})`, rec?.status === 'completed' && JSON.stringify(rec.stagedFiles) === JSON.stringify(want), JSON.stringify(rec && { ...rec, snapshot: undefined }));
    check(`status sequence (${shape.name})`, statusesOf(ev.key).join() === 'processing,queued,processing,completed', statusesOf(ev.key).join());
    check(`usage (${shape.name})`, rec?.usage?.generations === 2);
    let pixelsOk = true;
    for (let i = 0; i < want.length; i++) {
      const img = decodePng(new Uint8Array(readFileSync(abs(want[i]))));
      const size = shape.size ?? CANVAS;
      pixelsOk = pixelsOk && img.width === size && img.height === size && img.data[0] === 40 * (i + 1) && img.data[1] === 7 && img.data[3] === 255;
    }
    check(`staged PNGs decode in order (${shape.name})`, pixelsOk);
  }
  check('events never carry the snapshot', events.every((e) => !('snapshot' in e) && !('canvas' in e)));
  check('list() has no snapshot', svc.list().every((e) => !('snapshot' in e) && !('canvas' in e)));
  const pollsAfter = shapeJobs.map((j) => fake.getCount(j.ev.jobId));
  await advance(POLL_MS);
  check('completed jobs are not polled again', shapeJobs.every((j, i) => fake.getCount(j.ev.jobId) === pollsAfter[i]));
  const live = svc.referencedUids();
  check('referencedUids: frame uids and the reference image', shapeJobs.every((j) => j.ev.frameUids.every((u) => live.has(u))) && live.has(refUid));

  // ---- ack ----
  const acked = shapeJobs[0].ev;
  await svc.ack(acked.key);
  check('ack removes the record and the staging dir', svc.get(acked.key) === null && !existsSync(abs(jobStageDirRel(acked.key)))
    && journal().jobs.every((j) => j.key !== acked.key));

  // ---- backoff ----
  console.log('backoff on 429 / 5xx / network');
  fake.scripts.push([{ status: 429, body: { detail: 'Too many concurrent background jobs' } }, { status: 429, body: { detail: 'busy' } }, processing,
    completed([0, 1, 2].map(pngB64))]);
  const r429 = await svc.submitAnimate(submitInput(refRel));
  const k429 = r429.ok ? r429.data : null;
  fake.scripts.push([{ status: 503, body: { detail: 'unavailable' } }, 'network', completed([0, 1, 2].map(pngB64))]);
  const r5xx = await svc.submitAnimate(submitInput(refRel));
  const k5xx = r5xx.ok ? r5xx.data : null;
  const gets = (): string => `${fake.getCount(k429?.jobId ?? null)}/${fake.getCount(k5xx?.jobId ?? null)}`;
  await advance(POLL_MS); // t=6: 429 / 503 → backoff 12 s
  check('first errors', gets() === '1/1', gets());
  await advance(POLL_MS); // t=12: waiting
  check('no poll during the 12 s backoff', gets() === '1/1', gets());
  await advance(POLL_MS); // t=18: 429 again → 24 s; network error → 24 s
  check('re-polled after the backoff', gets() === '2/2', gets());
  check('still pending during backoff', svc.get(k429?.key ?? '')?.status === 'processing' && svc.get(k5xx?.key ?? '')?.status === 'processing');
  await advance(POLL_MS * 3); // t=36: 6 s short of the 24 s backoff
  check('no poll during the 24 s backoff', gets() === '2/2', gets());
  await advance(POLL_MS); // t=42
  check('third poll after the longer backoff', gets() === '3/3', gets());
  check('network error recovered → completed', svc.get(k5xx?.key ?? '')?.status === 'completed');
  await advance(POLL_MS);
  check('429 recovered → completed', svc.get(k429?.key ?? '')?.status === 'completed', svc.get(k429?.key ?? '')?.status);
  check('backoff never resubmits', fake.posts.length === 1 + SHAPES.length + 2);
  check('backoff is logged', logs.some((l) => /retrying in 12 s/.test(l)));

  // ---- failure, 404s, incomplete results, too many images ----
  console.log('failures');
  fake.scripts.push([queued, ok({ status: 'failed', last_response: { detail: 'Content policy violation' } })]);
  const rf = await svc.submitAnimate(submitInput(refRel));
  fake.scripts.push([completed([pngB64(0)]), completed([0, 1, 2].map(pngB64))]);
  const ri = await svc.submitAnimate(submitInput(refRel));
  fake.scripts.push([completed([0, 1, 2, 3].map(pngB64))]);
  const rm = await svc.submitAnimate(submitInput(refRel));
  fake.scripts.push([completed([pngB64(0), { type: 'rgba_bytes', base64: 'AAAA' }, pngB64(2)])]);
  const rg = await svc.submitAnimate(submitInput(refRel));
  const [kf, ki, km, kg] = [rf, ri, rm, rg].map((r) => r.ok ? r.data.key : '');
  await advance(POLL_MS);
  await advance(POLL_MS);
  check('failed with last_response.detail', svc.get(kf)?.status === 'failed' && svc.get(kf)?.error === 'Content policy violation', JSON.stringify(svc.get(kf)?.error));
  check('too few images: re-polled, then completed', svc.get(ki)?.status === 'completed', svc.get(ki)?.status);
  check('too many images → failed with the job id', svc.get(km)?.status === 'failed' && /expected 3 images, got 4/.test(svc.get(km)?.error ?? '')
    && (svc.get(km)?.error ?? '').includes(svc.get(km)?.jobId ?? '?'), svc.get(km)?.error ?? '');
  check('undecodable image → failed', svc.get(kg)?.status === 'failed' && /image 2/.test(svc.get(kg)?.error ?? ''), svc.get(kg)?.error ?? '');

  // ---- an ambiguous POST failure (5xx, timeout, reset: PixelLab may have billed it) is a failed record, never resubmitted ----
  fake.postFailure = { status: 502, body: 'Bad Gateway' };
  const postsBefore502 = fake.posts.length;
  const r502 = await svc.submitAnimate(submitInput(refRel));
  const rec502 = svc.list().find((e) => e.status === 'failed' && /did not confirm the submission/.test(e.error ?? ''));
  check('5xx on submit → failed record saying it may be billed', !r502.ok && /unknown whether it accepted/.test(r502.error) && !!rec502
    && journal().jobs.some((j) => j.key === rec502.key) && events.some((e) => e.key === rec502.key && e.status === 'failed') && fake.posts.length === postsBefore502 + 1, JSON.stringify(r502));
  check('… returned with the result (the renderer reports it once)', !r502.ok && r502.record?.key === rec502?.key && r502.record?.jobId === null);
  if (rec502)
    await svc.ack(rec502.key);
  fake.postFailure = { status: 200, body: { status: 'processing', usage: null } };
  const rNoId = await svc.submitAnimate(submitInput(refRel));
  const noIdRec = rNoId.ok ? null : rNoId.record ?? null;
  check('2xx without a job id → failed record saying it may be billed', !rNoId.ok && /no job id/.test(rNoId.error) && /billed/.test(rNoId.error)
    && !!noIdRec && svc.get(noIdRec.key)?.status === 'failed' && journal().jobs.some((j) => j.key === noIdRec.key), JSON.stringify(rNoId));
  if (noIdRec)
    await svc.ack(noIdRec.key);
  fake.postFailure = { status: 200, body: { background_job_id: '../../etc' } };
  const rOdd = await svc.submitAnimate(submitInput(refRel));
  const oddRec = rOdd.ok ? null : rOdd.record ?? null;
  check('unexpected job id → failed record naming it, never polled', !rOdd.ok && rOdd.error.includes('../../etc') && /billed/.test(rOdd.error)
    && oddRec?.jobId === null && svc.get(oddRec.key)?.status === 'failed', JSON.stringify(rOdd));
  if (oddRec)
    await svc.ack(oddRec.key);

  // ---- submits in flight are tracked (app quit waits for them) ----
  fake.scripts.push([processing]);
  const inFlight = svc.submitAnimate(submitInput(refRel));
  check('a running submit is pending', svc.pendingSubmits() === 1);
  await svc.submitsSettled();
  const settledRes = await inFlight;
  check('submitsSettled waits for it to be journaled', svc.pendingSubmits() === 0 && settledRes.ok && journal().jobs.some((j) => j.key === settledRes.data.key && !!j.jobId));
  if (settledRes.ok)
    await svc.cancel(settledRes.data.key).then(() => svc.ack(settledRes.data.key));

  // ---- staging failures back off (12 s, 24 s), then fail with the local error instead of re-downloading for an hour ----
  fake.scripts.push([completed([0, 1, 2].map(pngB64))]);
  const rs = await svc.submitAnimate(submitInput(refRel));
  const ks = rs.ok ? rs.data : null;
  await fsp.mkdir(abs('.ptk/jobs'), { recursive: true });
  await fsp.writeFile(abs(jobStageDirRel(ks?.key ?? '')), 'a file where the staging dir goes');
  const sgets = (): number => fake.getCount(ks?.jobId ?? null);
  await advance(POLL_MS); // staging fails → 12 s
  await advance(POLL_MS);
  check('staging failure: pending, backed off 12 s', sgets() === 1 && svc.get(ks?.key ?? '')?.status === 'processing', `${sgets()}`);
  await advance(POLL_MS); // second failure → 24 s
  await advance(POLL_MS * 3);
  check('staging failure: backoff grows to 24 s', sgets() === 2, `${sgets()}`);
  await advance(POLL_MS); // third failure → failed
  const staging = svc.get(ks?.key ?? '');
  check('third staging failure → failed with the local error and the job id', sgets() === 3 && staging?.status === 'failed'
    && /saving its images failed/.test(staging.error ?? '') && (staging.error ?? '').includes(ks?.jobId ?? '?'), staging?.error ?? '');
  await fsp.rm(abs(jobStageDirRel(ks?.key ?? '')), { force: true });

  // ---- cancel ----
  console.log('cancel / retarget / deadline');
  fake.scripts.push([processing]);
  const rc = await svc.submitAnimate(submitInput(refRel));
  const kc = rc.ok ? rc.data : null;
  const cancelled = await svc.cancel(kc?.key ?? '');
  check('cancel → DELETE and cancelled', cancelled.ok && fake.deletes.includes(kc?.jobId ?? '?') && svc.get(kc?.key ?? '')?.status === 'cancelled');
  const pollsAtCancel = fake.getCount(kc?.jobId ?? null);
  await advance(POLL_MS);
  check('cancelled jobs are not polled', fake.getCount(kc?.jobId ?? null) === pollsAtCancel);
  const again = await svc.cancel(kc?.key ?? '');
  check('cancel of a final job is refused', !again.ok && /already cancelled/.test(again.error));

  // ---- retarget ----
  fake.scripts.push([processing]);
  const rt = await svc.submitAnimate(submitInput(refRel));
  const kt = rt.ok ? rt.data.key : '';
  await svc.retarget(kt, 'Folder/Merchant/Run.json');
  const moved = svc.get(kt);
  check('retarget updates animRel and the owned reference name', moved?.animRel === 'Folder/Merchant/Run.json'
    && moved.refImageRel === `Folder/Merchant/${animImageFileName('Run', refUid)}` && events.at(-1)?.animRel === 'Folder/Merchant/Run.json', JSON.stringify(moved?.refImageRel));
  await svc.rekey(kt, 'doc00002');
  check('rekey updates docId, journals and emits it', svc.get(kt)?.docId === 'doc00002' && events.at(-1)?.docId === 'doc00002'
    && (JSON.parse(readFileSync(abs(JOBS_JOURNAL_REL), 'utf8')) as { jobs: { key: string; docId: string }[] }).jobs.some((j) => j.key === kt && j.docId === 'doc00002'));
  let rekeyRefused = false;
  await svc.rekey(kt, '').catch(() => {
    rekeyRefused = true;
  });
  check('rekey refuses an empty docId', rekeyRefused && svc.get(kt)?.docId === 'doc00002');

  // ---- 404s ----
  fake.scripts.push([processing]);
  const r404 = await svc.submitAnimate(submitInput(refRel));
  const k404 = r404.ok ? r404.data : null;
  fake.jobs.delete(k404?.jobId ?? ''); // PixelLab forgets the job
  await advance(POLL_MS);
  await advance(POLL_MS * 2);
  await advance(POLL_MS * 4);
  check('three 404s → failed', svc.get(k404?.key ?? '')?.status === 'failed' && /404/.test(svc.get(k404?.key ?? '')?.error ?? ''), svc.get(k404?.key ?? '')?.error ?? '');

  // ---- deadline: a stalled job is never failed or cancelled; it is polled every 5 min and says so ----
  fake.scripts.push([processing, processing, completed([0, 1, 2].map(pngB64))]);
  const rd = await svc.submitAnimate(submitInput(refRel));
  const kd = rd.ok ? rd.data : null;
  await advance(POLL_MS);
  check('still running before the deadline', svc.get(kd?.key ?? '')?.status === 'processing' && svc.get(kd?.key ?? '')?.error === null);
  await advance(61 * 60 * 1000);
  const stalled = svc.get(kd?.key ?? '');
  check('deadline → still pending, stalled message with the job id', stalled?.status === 'processing' && /No result after 60 min/.test(stalled.error ?? '')
    && (stalled.error ?? '').includes(kd?.jobId ?? '?') && stalled.jobId === kd?.jobId && events.at(-1)?.error === stalled.error, stalled?.error ?? '');
  check('the retargeted job is stalled too, not failed', svc.get(kt)?.status === 'processing' && /No result after/.test(svc.get(kt)?.error ?? ''));
  const pollsStalled = fake.getCount(kd?.jobId ?? null);
  await advance(MAX_BACKOFF_MS - POLL_MS);
  check('a stalled job is polled slowly', fake.getCount(kd?.jobId ?? null) === pollsStalled);
  await advance(POLL_MS);
  const late = svc.get(kd?.key ?? '');
  check('a stalled job still completes', late?.status === 'completed' && late.error === null && fake.getCount(kd?.jobId ?? null) === pollsStalled + 1, late?.status);

  // ---- restart: a new service resumes from the journal, never resubmits ----
  console.log('restart');
  fake.scripts.push([processing, processing, completed([0, 1, 2].map(pngB64))]);
  const rr = await svc.submitAnimate(submitInput(refRel));
  const kr = rr.ok ? rr.data : null;
  fake.scripts.push([processing, 'network', completed([0, 1, 2].map(pngB64))]);
  const rn = await svc.submitAnimate(submitInput(refRel));
  const kn = rn.ok ? rn.data : null;
  await advance(POLL_MS);
  check('running before the restart', svc.get(kr?.key ?? '')?.status === 'processing' && fake.getCount(kr?.jobId ?? null) === 1);
  svc.stop();
  const postsBefore = fake.posts.length;
  // a crash in the middle of a submit leaves a 'submitting' intent in the journal
  fake.hangPosts = true;
  void svc.submitAnimate(submitInput(refRel));
  for (let i = 0; i < 100 && !journal().jobs.some((j) => j.status === 'submitting'); i++)
    await new Promise((r) => setTimeout(r, 10));
  check('intent journaled before the POST', journal().jobs.some((j) => j.status === 'submitting' && j.jobId === null));
  fake.hangPosts = false;

  // the app stays closed for 2 h; a staging dir without a journal entry was left behind (an ack whose delete failed)
  clock += 2 * 60 * 60 * 1000;
  const orphanDir = jobStageDirRel('orphan01');
  await fsp.mkdir(abs(orphanDir), { recursive: true });
  await fsp.writeFile(abs(`${orphanDir}/p0a9s8d7.png`), 'x');
  const svc2 = makeService();
  await svc2.load();
  const resumed = svc2.get(kr?.key ?? '');
  check('journal reloaded', resumed?.status === 'processing' && resumed.jobId === kr?.jobId && resumed.snapshot.frames.length === 3);
  const interrupted = svc2.list().find((e) => e.status === 'failed' && /closed while this job was being submitted/.test(e.error ?? ''));
  check('interrupted submit → failed, not resubmitted', !!interrupted && interrupted.jobId === null);
  check('acked jobs stay gone', svc2.get(acked.key) === null);
  check('orphaned staging dirs are removed, live ones kept', !existsSync(abs(orphanDir))
    && (svc2.get(shapeJobs[1].ev.key)?.stagedFiles ?? ['?']).every((f) => existsSync(abs(f))));
  await svc2.tick();
  check('restart polls immediately', fake.getCount(kr?.jobId ?? null) === 2);
  const afterError = svc2.get(kn?.key ?? '');
  check('a transient error on the first poll after 2 h closed: still pending, no deadline', afterError?.status === 'processing' && afterError.error === null, afterError?.error ?? '');
  check('a new session restarts the deadline: the stalled job is not stalled any more', svc2.get(kt)?.status === 'processing' && svc2.get(kt)?.error === null);
  await advance(POLL_MS, svc2);
  const done = svc2.get(kr?.key ?? '');
  check('resumed job completes', done?.status === 'completed' && (done.stagedFiles ?? []).every((f) => existsSync(abs(f))));
  await advance(POLL_MS, svc2);
  check('the job behind the transient error completes after the backoff', svc2.get(kn?.key ?? '')?.status === 'completed', svc2.get(kn?.key ?? '')?.status);
  check('restart never resubmits', fake.posts.length === postsBefore);
  svc2.stop();

  // ---- an invalid journal is copied aside before the service starts empty (and nothing is swept then) ----
  await fsp.writeFile(abs(JOBS_JOURNAL_REL), '{ "jobs": [ broken');
  const svc3 = makeService();
  await svc3.load();
  const backups = (await fsp.readdir(abs('.ptk'))).filter((n) => /^jobs\.corrupt-\d+\.json$/.test(n));
  check('invalid journal: a copy is kept, started empty', backups.length === 1 && svc3.list().length === 0
    && readFileSync(abs(`.ptk/${backups[0]}`), 'utf8').includes('broken') && logs.some((l) => l.includes('kept a copy')), backups.join());
  check('invalid journal: staging dirs are left alone', (done?.stagedFiles ?? ['?']).every((f) => existsSync(abs(f))));

  await fsp.rm(base, { recursive: true, force: true });
  console.log(`${passes} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0); // the hung fake POST keeps a timer alive
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
