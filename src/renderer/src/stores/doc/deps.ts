// What the document core reads from the jobs store, behind one indirection so the self-test can run
// without it. Production code always goes through useJobsStore().
import type { JobUpdateEvent } from '@shared/jobs';
import { useJobsStore } from '../jobs';

export interface JobsView {
  readonly records: readonly JobUpdateEvent[];
  busy(docId: string): boolean;
}

export const deps = {
  jobs: (): JobsView => useJobsStore()
};
