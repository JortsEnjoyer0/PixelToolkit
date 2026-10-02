// Control-panel commands with IO, dialogs and API calls: pick / import the reference image, Estimate, Generate.
// UI-free apart from the global services, so other entry points (shortcuts, menus) can reuse them.
import { shallowReactive } from 'vue';
import type { ImportedImage } from '@shared/api';
import { baseImageFileName } from '@shared/dataPaths';
import type { JobUpdateEvent } from '@shared/jobs';
import { ESTIMATE_COST, generationCost } from '@shared/pixellab';
import { withEstimate, withReferenceImage, type EstimateReport } from '../../../core/docState';
import { buildGeneration, generationProblems, generationWarnings } from '../../../core/generate';
import type { BaseImage } from '../../../core/model';
import { dialogs } from '../../../services/dialogs';
import { cancelEditorInteraction } from '../../../services/editorState';
import { errorMessage } from '../../../services/errors';
import { toasts } from '../../../services/toasts';
import { useDocumentsStore } from '../../../stores/documents';
import { useJobsStore } from '../../../stores/jobs';
import { useSettingsStore } from '../../../stores/settings';
import type { DocHandle } from '../../../stores/types';

/** Docs whose reference image is being copied / imported (spinner; a second pick waits for the IO queue anyway). */
export const referenceIoDocs = shallowReactive(new Set<string>());
/** Docs with an Estimate started from the panel (button spinner; jobs.busy() does the disabling). */
export const estimatingDocs = shallowReactive(new Set<string>());
/** Docs between the Generate confirm and the submit result. */
export const submittingDocs = shallowReactive(new Set<string>());

async function withFlag<T>(set: Set<string>, docId: string, run: () => Promise<T>): Promise<T> {
  set.add(docId);
  try {
    return await run();
  } finally {
    set.delete(docId);
  }
}

/** Copy a character base image into the animation ("<anim>.<uid>.png") and make it the reference ('Pick Reference'). */
export async function pickBaseImage(doc: DocHandle, base: BaseImage): Promise<void> {
  const ref = doc.state.value.reference;
  if (ref.image && ref.sourceBaseUid === base.uid)
    return;
  await withFlag(referenceIoDocs, doc.id, async () => {
    const { uid } = await doc.runIo((p) => window.api.images.copyToAnimation(p.charRel, baseImageFileName(base.uid), p.name));
    doc.noteCreatedImage(uid);
    doc.apply('Pick Reference', (s) => withReferenceImage(s, { image: uid, sourceBaseUid: base.uid, width: base.width, height: base.height }));
  });
}

/** File dialog → padded "<anim>.<uid>.png" → reference ('Import Reference'). Invalid files get an error toast. */
export async function importReferenceImage(doc: DocHandle): Promise<void> {
  await withFlag(referenceIoDocs, doc.id, async () => {
    let img: ImportedImage | null;
    try {
      img = await doc.runIo((p) => window.api.images.importReference(p.charRel, p.name));
    } catch (e) {
      toasts.push({ kind: 'error', title: 'Could not import the image', message: errorMessage(e) });
      return;
    }
    if (!img)
      return;
    const { uid, width, height } = img;
    doc.noteCreatedImage(uid);
    doc.apply('Import Reference', (s) => withReferenceImage(s, { image: uid, sourceBaseUid: null, width, height }));
  });
}

/**
 * "Estimate reference skeleton": confirm when a reference pose or frames exist (checkbox: restart the track), get the
 * 2D estimate (the base image's cache unless `force`), then one 'Estimate Skeleton' undo entry (withEstimate).
 */
export async function estimateReference(doc: DocHandle, opts: { force?: boolean } = {}): Promise<void> {
  const jobs = useJobsStore();
  const s = doc.state.value;
  if (!s.reference.image || jobs.busy(doc.id))
    return;
  let resetFrames = false;
  if (s.reference.pose || s.frames.length > 0) {
    const n = s.frames.length;
    const res = await dialogs.confirm({
      title: 'Replace the reference skeleton?',
      message: 'The reference pose, rig proportions and framing are replaced by the new estimate.',
      detail: n > 0 ? `The ${n} track frame${n === 1 ? '' : 's'} keep their poses unless you delete them.` : undefined,
      checkbox: { label: 'Delete all frames and start from the new reference', value: false },
      okLabel: opts.force ? `Re-estimate (≈${ESTIMATE_COST} gen)` : 'Estimate'
    });
    if (!res.ok || jobs.busy(doc.id))
      return;
    resetFrames = res.checked;
  }
  const kps = await withFlag(estimatingDocs, doc.id, () => jobs.estimate(doc.id, { force: opts.force }));
  if (!kps)
    return;
  cancelEditorInteraction();
  const out: { report: EstimateReport | null } = { report: null };
  doc.apply('Estimate Skeleton', (st) => {
    const r = withEstimate(st, kps, { resetFrames });
    out.report = r.report;
    return r.state;
  });
  const warnings = out.report?.warnings ?? [];
  if (warnings.length > 0)
    toasts.push({ kind: 'warning', title: 'Skeleton estimated, with warnings', message: warnings.join('\n') });
  else
    toasts.push({ kind: 'success', title: 'Reference skeleton estimated', message: resetFrames ? 'The track restarts from the new reference.' : undefined });
}

/** Preflight (core/generate), cost confirm, then jobs.submitGenerate. Problems and submit failures become toasts. */
export async function generateAnimation(doc: DocHandle): Promise<void> {
  const jobs = useJobsStore();
  if (jobs.busy(doc.id) || submittingDocs.has(doc.id))
    return;
  const documents = useDocumentsStore();
  const settings = useSettingsStore();
  const character = documents.characters.get(doc.charRel.value) ?? await documents.loadCharacter(doc.charRel.value);
  const s = doc.state.value;
  const problems = generationProblems(s, character.description, { hasApiKey: settings.hasPixelLabKey });
  if (problems.length > 0) {
    toasts.push({ kind: 'warning', title: 'Not ready to generate', message: problems.map((p) => `• ${p}`).join('\n') });
    return;
  }
  const n = s.frames.length;
  const plan = buildGeneration(s, character.description);
  const detail = ['When the job finishes, the frame track is replaced by the generated frames (undoable).'];
  if (plan.clamped)
    detail.push('Some joints fall outside the canvas and are clamped to its edge.');
  detail.push(...generationWarnings(s, character.baseImages));
  const res = await dialogs.confirm({
    title: 'Generate new animation?',
    message: `Send ${n} frames to PixelLab? This costs about ${generationCost(n)} generations.`,
    detail: detail.join('\n'),
    okLabel: 'Generate'
  });
  if (!res.ok || jobs.busy(doc.id))
    return;
  const r = await withFlag(submittingDocs, doc.id, () => jobs.submitGenerate(doc.id));
  // A failure that left a record (PixelLab may have accepted and billed it) is reported once, by the jobs store
  if (!r.ok && !r.record)
    toasts.push({ kind: 'error', title: 'Could not start the generation', message: r.error });
}

const formatEta = (sec: number): string => {
  const t = Math.max(0, Math.round(sec));
  return t < 60 ? `${t} s` : `${Math.floor(t / 60)} min ${t % 60} s`;
};

/** Status line of an unfinished generation job: "Queued · #3 · ETA 1 min 20 s". */
export function jobStatusText(job: JobUpdateEvent): string {
  const parts: string[] = [];
  switch (job.status) {
    case 'submitting':
      parts.push('Submitting…');
      break;
    case 'queued':
      parts.push('Queued');
      if (job.queuePosition !== null)
        parts.push(`#${job.queuePosition} in line`);
      break;
    case 'processing':
      parts.push('Generating…');
      break;
    default:
      parts.push(job.status);
  }
  if (job.etaSec !== null && job.etaSec > 0)
    parts.push(`ETA ${formatEta(job.etaSec)}`);
  if (job.error)
    parts.push(job.error); // e.g. main's stall note on a job still running past the deadline
  return parts.join(' · ');
}
