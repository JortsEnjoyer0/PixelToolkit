// Generation job contract between the main-process job service (main/jobs.ts) and the renderer jobs store.
import { validateAnimateRequest, type AnimateV3Request, type CameraView, type Direction, type Usage } from './pixellab';
import type { Pose } from './pose';
import { isUid } from './uid';

/**
 * submitting: journal intent written, POST in flight. queued / processing: polled every ~6 s.
 * completed: result PNGs staged, waiting for ack(). failed / cancelled: final, waiting for ack().
 */
export type JobStatus = 'submitting' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

/** Statuses main no longer polls. */
export const FINAL_JOB_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

/** What was submitted, so the result can be applied even if the track was edited meanwhile. */
export interface SubmittedSnapshot {
  /** One entry per submitted track frame, in order. `uid` = FrameData.uid at submit time (detects track changes). */
  frames: { uid: string; pose: Pose }[];
  direction: Direction;
  view: CameraView;
  pitchDeg: number;
}

/** One entry of the job journal (data/.ptk/jobs.json). */
export interface JobRecord {
  /** Local journal key (uid), stable from submit to ack. Not the PixelLab id. */
  key: string;
  docId: string;
  /** Animation json path at submit time. Informational: the renderer resolves the doc by docId. */
  animRel: string;
  /** Reference PNG sent as first_frame (data-root-relative). */
  refImageRel: string;
  status: JobStatus;
  /** PixelLab background_job_id; null until the POST returns. */
  jobId: string | null;
  /** Epoch ms. */
  submittedAt: number;
  /** Epoch ms of the last status change or poll result. */
  updatedAt: number;
  /**
   * IMAGE uids preallocated for the results, one per submitted frame, in order (GC treats them as live). Result i is
   * staged as jobStageFileRel(key, frameUids[i]) and becomes "<anim>.<frameUids[i]>.png". Not FrameData.uid values.
   */
  frameUids: string[];
  snapshot: SubmittedSnapshot;
  /** Data-root-relative staged PNGs (data/.ptk/jobs/<key>/<uid>.png), same order as frameUids; set when completed. */
  stagedFiles: string[] | null;
  /** Failure text (last_response.detail or the transport error). */
  error: string | null;
  queuePosition: number | null;
  etaSec: number | null;
  /** Billed amount, once known. */
  usage: Usage | null;
}

/** Pushed on 'jobs:update' and returned by list(): the record without the (large) snapshot. */
export type JobUpdateEvent = Omit<JobRecord, 'snapshot'>;

/**
 * jobs.submitAnimate outcome. ok → the new record (status 'queued' or 'processing'). A failure after which PixelLab may
 * still have accepted (and billed) the job carries the failed `record` main journaled for it (also pushed on
 * 'jobs:update'): the renderer reports that record once instead of the submit error.
 */
export type SubmitAnimateResult = { ok: true; data: JobUpdateEvent } | { ok: false; status?: number; error: string; record?: JobUpdateEvent };

export interface SubmitAnimateInput {
  docId: string;
  animRel: string;
  /** Reference PNG to send as first_frame; must be a square canvas from ESTIMATE_CANVAS_SIZES. */
  refImageRel: string;
  /** Wire body minus first_frame; main validates it (validateAnimateRequest) before spending anything. */
  request: AnimateV3Request;
  /** Fresh image uids (uid()), one per request.keypoints frame; see JobRecord.frameUids. */
  frameUids: string[];
  /** snapshot.frames must have the same length as request.keypoints. */
  snapshot: SubmittedSnapshot;
}

/** Main-side check of untrusted submit input (R8 request rules plus the record invariants). Empty when valid. */
export function validateSubmitInput(input: SubmitAnimateInput): string[] {
  const v: unknown = input;
  if (!v || typeof v !== 'object')
    return ['input must be an object'];
  const errors: string[] = [];
  const nonEmpty = (s: unknown): boolean => typeof s === 'string' && s !== '';
  if (!nonEmpty(input.docId) || !nonEmpty(input.animRel) || !nonEmpty(input.refImageRel))
    errors.push('docId, animRel and refImageRel must be non-empty strings');
  errors.push(...validateAnimateRequest(input.request));
  const n = Array.isArray(input.request?.keypoints) ? input.request.keypoints.length : -1;
  const uids = Array.isArray(input.frameUids) ? input.frameUids : [];
  if (uids.length !== n || !uids.every(isUid) || new Set(uids).size !== uids.length)
    errors.push('frameUids must be unique uids, one per keypoints frame');
  if (!Array.isArray(input.snapshot?.frames) || input.snapshot.frames.length !== n)
    errors.push('snapshot.frames must have one entry per keypoints frame');
  return errors;
}
