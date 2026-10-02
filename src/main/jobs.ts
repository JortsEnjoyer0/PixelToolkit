// Generation jobs (PLAN §7): electron glue around core/jobService.ts (journal, submit, 6 s polling with backoff, R7
// decoding, staging). Records are pushed to every window as 'jobs:update' (no snapshot).
import { BrowserWindow, powerMonitor } from 'electron';
import { IPC } from '../shared/api';
import type { JobUpdateEvent, SubmitAnimateInput } from '../shared/jobs';
import { JobService } from './core/jobService';
import { handle, handleResult } from './ipc/handle';
import { pixelLab } from './ipc/pixellab';

let service: JobService | null = null;

function pushUpdate(ev: JobUpdateEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed())
      win.webContents.send(IPC.jobsUpdate, ev);
  }
}

const jobs = (): JobService => {
  if (!service)
    throw new Error('Job service not started');
  return service;
};

/** Load the journal (after the data root is set). Polling starts with startJobPolling(). */
export async function initJobs(): Promise<JobService> {
  service = new JobService({ request: (req) => pixelLab.request(req), emit: pushUpdate });
  await service.load();
  powerMonitor.on('resume', () => service?.resetDeadlines()); // time asleep is not "no result yet"
  return service;
}

export const startJobPolling = (): void => jobs().start();

export const stopJobPolling = (): void => service?.stop();

/** Image uids the journal still needs (live for the session-created sweep). */
export const jobReferencedUids = (): Set<string> => service?.referencedUids() ?? new Set();

/** Generation submits still running (their POST in flight, or its answer not journaled yet). */
export const pendingJobSubmits = (): number => service?.pendingSubmits() ?? 0;

/** Resolves when the submits running now have finished (each is bounded by its POST timeout). */
export const jobSubmitsSettled = (): Promise<void> => service?.submitsSettled() ?? Promise.resolve();

export function registerJobsIpc(): void {
  handleResult(IPC.jobsSubmitAnimate, (input: SubmitAnimateInput) => jobs().submitAnimate(input));
  handle(IPC.jobsList, async () => jobs().list());
  handle(IPC.jobsGet, async (key: string) => jobs().get(key));
  handle(IPC.jobsAck, (key: string) => jobs().ack(key));
  handleResult(IPC.jobsCancel, (key: string) => jobs().cancel(key));
  handle(IPC.jobsRetarget, (key: string, animRel: string) => jobs().retarget(key, animRel));
  handle(IPC.jobsRekey, (key: string, docId: string) => jobs().rekey(key, docId));
}
