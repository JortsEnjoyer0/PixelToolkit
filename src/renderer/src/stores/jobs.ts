// Jobs store (JobsStoreApi, PLAN §5 Jobs): mirrors main's generation job records ('jobs:update' + api.jobs.list()),
// tracks in-flight estimates per doc, submits generations and applies finished results (open docs as one "Generate"
// undo entry, closed docs headless: load, apply, save, unload). Logic lives in stores/job/jobsCore.ts.
// App.vue calls initJobs() once after the settings load and restoreWorkspace(), so results for docs about to open are
// applied to the open tab instead of headless.
import { defineStore } from 'pinia';
import { createJobs } from './job/jobsCore';
import { useDocumentsStore } from './documents';
import { useTabsStore } from './tabs';
import type { JobsStoreApi } from './types';

export const useJobsStore = defineStore('jobs', () => {
  // Resolved lazily: the documents / tabs stores may use this one in their own setup
  const core = createJobs({ documents: () => useDocumentsStore(), tabs: () => useTabsStore() });
  return {
    records: core.records,
    busy: core.busy,
    busyUnder: core.busyUnder,
    pendingUnder: core.pendingUnder,
    activeJob: core.activeJob,
    estimate: core.estimate,
    submitGenerate: core.submitGenerate,
    cancel: core.cancel,
    init: core.init,
    idle: core.idle
  };
});

/** Subscribe to job updates, load the journal and apply results that finished while the app was closed. Idempotent. */
export function initJobs(): Promise<void> {
  return useJobsStore().init();
}

/** The store typed as its public API (also a compile-time check that it satisfies JobsStoreApi). */
export function useJobsApi(): JobsStoreApi {
  return useJobsStore();
}
