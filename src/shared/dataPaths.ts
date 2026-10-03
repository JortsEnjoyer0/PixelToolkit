// Data-root-relative path conventions (docs/architecture.md "Data root and files"). POSIX separators, no leading slash.
//   folder:     "Townsfolk"
//   character:  charRel = "Townsfolk/Merchant" (dir); meta = charRel + ".json"; base images "base.<uid>.png" inside
//   animation:  animRel = "Townsfolk/Merchant/Walk South.json"; images "<animName>.<uid>.png" beside it

/** Internal app dir under the data root (skipped by scanData). */
export const PTK_DIR = '.ptk';
export const JOBS_JOURNAL_REL = '.ptk/jobs.json';
export const WORKSPACE_REL = '.ptk/workspace.json';
export const SESSION_CREATED_REL = '.ptk/session-created.json';

/**
 * SESSION_CREATED_REL contents (the session sweep, docs/architecture.md "Data root and files"): data-root-relative
 * image files main wrote this session (base / reference imports, copies). A file left over from a crashed session is
 * deleted at startup unless its owner json (or the jobs journal) references its uid. The owner follows from the name:
 * "base.<uid>.png" → the character json, "<anim>.<uid>.png" → "<anim>.json".
 */
export interface SessionCreatedList {
  version: 1;
  files: string[];
  /** Same files with their uid and owner json at write time (main writes both; readers prefer this when present). */
  entries?: SessionCreatedEntry[];
}

/** One image file main wrote (or moved out of .ptk/jobs) this session. */
export interface SessionCreatedEntry {
  uid: string;
  /** Data-root-relative file as written. */
  file: string;
  /** Owner json at write time: the character json for "base.<uid>.png", otherwise "<anim>.json" beside the file. */
  ownerRel: string;
}

/** Image file names: exactly "<owner>.<uid>.png" (owner "base" = a character base image). */
export const IMAGE_FILE_RE = /^(.+)\.([0-9a-z]{8})\.png$/;

/** "<owner>.<uid>.png" → { owner, uid }; null for any other file name. */
export function parseImageFileName(name: string): { owner: string; uid: string } | null {
  const m = IMAGE_FILE_RE.exec(name);
  return m ? { owner: m[1], uid: m[2] } : null;
}

/** Parent of the per-job staging dirs ("<JOBS_STAGE_DIR_REL>/<key>"). */
export const JOBS_STAGE_DIR_REL = `${PTK_DIR}/jobs`;
export const jobStageDirRel = (key: string): string => `${JOBS_STAGE_DIR_REL}/${key}`;
export const jobStageFileRel = (key: string, uid: string): string => `${JOBS_STAGE_DIR_REL}/${key}/${uid}.png`;

export const joinRel = (...parts: string[]): string => parts.filter((p) => p !== '').join('/');
/** '' for a root-level entry. */
export const parentRel = (rel: string): string => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
export const baseNameRel = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

export const charJsonRel = (charRel: string): string => `${charRel}.json`;
export const charNameFromRel = (charRel: string): string => baseNameRel(charRel);

export const animJsonRel = (charRel: string, animName: string): string => joinRel(charRel, `${animName}.json`);
export const animNameFromRel = (animRel: string): string => baseNameRel(animRel).replace(/\.json$/i, '');
export const charRelFromAnimRel = (animRel: string): string => parentRel(animRel);

/** Character base image file name: "base.<uid>.png" ("base" is a reserved entity name). */
export const baseImageFileName = (uid: string): string => `base.${uid}.png`;
/** Animation-owned image file name: exactly "<animName>.<uid>.png" (ownership is an exact match, never a pattern). */
export const animImageFileName = (animName: string, uid: string): string => `${animName}.${uid}.png`;

export const baseImageRel = (charRel: string, uid: string): string => joinRel(charRel, baseImageFileName(uid));
export const animImageRel = (charRel: string, animName: string, uid: string): string => joinRel(charRel, animImageFileName(animName, uid));
