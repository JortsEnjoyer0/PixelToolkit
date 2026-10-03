// Image GC (docs/skelanim/skelanim.md "Saving, DocIO and image GC"). Candidates are the uids a doc ever referenced or
// created; a candidate is deleted when it is not live. Ownership is by exact file name "<anim>.<uid>.png" (never a
// pattern), so base.* files are never hit.
import { animImageRel, baseNameRel, parseImageFileName } from '@shared/dataPaths';
import type { JobUpdateEvent } from '@shared/jobs';
import { referencedImages } from '../../core/docState';
import type { UndoableState } from '../../core/model';
import { sameRel } from '../../core/util/relPath';
import type { DocPaths } from '../types';
import type { DocInternal } from './handle';

/**
 * What stays live besides pending jobs:
 * - 'history': current, saved and every undo / redo state, plus created images not applied yet (eviction GC);
 * - 'saved': only what the file references (unload: the history and unsaved edits are discarded);
 * - 'savedAndCurrent': app close (main's session sweep removes unsaved files created this session).
 */
export type GcKeep = 'history' | 'saved' | 'savedAndCurrent';

/** Image uids the doc's unfinished jobs still need: result frameUids plus the submitted reference when it is the doc's own file. */
export function jobImages(doc: DocInternal, records: readonly JobUpdateEvent[], paths: DocPaths): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (r.docId !== doc.id && !sameRel(r.animRel, paths.rel))
      continue;
    for (const u of r.frameUids)
      out.add(u);
    const ref = parseImageFileName(baseNameRel(r.refImageRel));
    if (ref && sameRel(ref.owner, paths.name))
      out.add(ref.uid);
  }
  return out;
}

/** Candidates that are not live (pure; see GcKeep). */
export function garbageUids(doc: DocInternal, keep: GcKeep, live: ReadonlySet<string>): string[] {
  const keepSet = new Set(live);
  const add = (s: UndoableState): void => {
    for (const u of referencedImages(s))
      keepSet.add(u);
  };
  add(doc.savedState());
  if (keep !== 'saved')
    add(doc.state.value);
  if (keep === 'history') {
    for (const s of doc.history.allStates())
      add(s);
    for (const u of doc.created) {
      if (!doc.seen.has(u))
        keepSet.add(u);
    }
  }
  return [...doc.candidates].filter((u) => !keepSet.has(u));
}

/** Delete the doc's garbage images (run inside its IO queue with the paths current then). Returns the deleted uids. */
export async function collectGarbage(doc: DocInternal, paths: DocPaths, keep: GcKeep, jobUids: ReadonlySet<string>): Promise<string[]> {
  if (doc.deleted || paths.name.toLowerCase() === 'base')
    return [];
  const uids = garbageUids(doc, keep, jobUids);
  if (uids.length === 0)
    return [];
  const rels = uids.map((u) => animImageRel(paths.charRel, paths.name, u));
  const res = await window.api.fs.deleteFiles(rels);
  const deleted = new Set(res.deleted);
  const out: string[] = [];
  uids.forEach((u, i) => {
    if (!deleted.has(rels[i]))
      return;
    doc.candidates.delete(u);
    doc.created.delete(u);
    doc.seen.delete(u);
    out.push(u);
  });
  if (res.failed.length > 0)
    console.warn('[documents] image GC could not delete', res.failed);
  return out;
}
