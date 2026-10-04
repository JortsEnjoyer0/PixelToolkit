// window.api contract: IPC channel names, invoke methods and the main → renderer event map.
// Shared by main, preload and renderer. Types and constants only (no runtime deps).
import type { AppSettings, SettingsPatch } from './settings';
import type { RgbaImage } from './image';
import type { KeypointOut, Usage } from './pixellab';
import type { JobRecord, JobUpdateEvent, SubmitAnimateInput, SubmitAnimateResult } from './jobs';

export const IPC = {
  fsReadJson: 'fs:readJson',
  fsWriteJson: 'fs:writeJson',
  fsReadBinary: 'fs:readBinary',
  fsWriteBinary: 'fs:writeBinary',
  fsRename: 'fs:rename',
  fsMkdir: 'fs:mkdir',
  fsTrash: 'fs:trash',
  fsDeleteFiles: 'fs:deleteFiles',
  fsExists: 'fs:exists',
  fsScanData: 'fs:scanData',
  fsListDir: 'fs:listDir',
  settingsRead: 'settings:read',
  settingsWrite: 'settings:write',
  imagesImportBase: 'images:importBase',
  imagesImportReference: 'images:importReference',
  imagesCopyToAnimation: 'images:copyToAnimation',
  filesOpenImage: 'files:openImage',
  filesSavePng: 'files:savePng',
  plBalance: 'pixellab:balance',
  plEstimateSkeleton: 'pixellab:estimateSkeleton',
  jobsSubmitAnimate: 'jobs:submitAnimate',
  jobsList: 'jobs:list',
  jobsGet: 'jobs:get',
  jobsAck: 'jobs:ack',
  jobsCancel: 'jobs:cancel',
  jobsRetarget: 'jobs:retarget',
  jobsRekey: 'jobs:rekey',
  /** event, main → renderer: a job record changed (payload JobUpdateEvent) */
  jobsUpdate: 'jobs:update',
  /** event, main → renderer: the window wants to close; flush/prompt, then call closeReady() */
  appBeforeClose: 'app:before-close',
  /** renderer → main (internal, sent by the preload): before-close was received by a listener */
  appCloseAck: 'app:close-ack',
  /** renderer → main: the renderer is done, destroy the window */
  appCloseReady: 'app:close-ready',
  appRevealInExplorer: 'app:reveal-in-explorer',
  appFlashFrame: 'app:flash-frame',
  appGetInfo: 'app:get-info'
} as const;

/** URL scheme serving files below the data root: ptk-asset://data/<rel>. Image files are immutable (new pixels = new uid). */
export const ASSET_SCHEME = 'ptk-asset';

export const assetUrl = (rel: string, version?: number): string =>
  `${ASSET_SCHEME}://data/${rel.split('/').map(encodeURIComponent).join('/')}${version === undefined ? '' : `?v=${version}`}`;

/**
 * Electron's prefix on the message of a rejected invoke: "Error invoking remote method '<channel>': Error: ". The
 * renderer strips it from user-facing text (services/errors.ts errorMessage).
 */
export const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

/** Outcome of an operation that can fail for expected reasons (network, PixelLab, validation). Never rejects. */
export type Result<T> = { ok: true; data: T } | { ok: false; status?: number; error: string };

/**
 * folder: root-level dir without a sibling json (contains characters only).
 * character: dir + sibling json. brokenCharacter: json without its dir (offer repair). animation: json in a character dir.
 */
export type ScanKind = 'folder' | 'character' | 'animation' | 'brokenCharacter';

export interface ScanNode {
  kind: ScanKind;
  name: string;
  /** Key. folder: dir rel; character / brokenCharacter: charRel (dir path, no ".json"); animation: json rel. */
  rel: string;
  /** mtime of the entity's json (characters and animations); null for folders. */
  mtimeMs: number | null;
  /** folder → characters, character → animations, otherwise []. Sorted by name (natural order). */
  children: ScanNode[];
}

export interface DirEntry { name: string; kind: 'file' | 'dir' }

/** An imported PNG after padding: the padded canvas plus where the source sprite sits in it. */
export interface ImportedImage {
  uid: string;
  /** Padded square canvas size (one of ESTIMATE_CANVAS_SIZES). */
  width: number;
  height: number;
  srcWidth: number;
  srcHeight: number;
  /** Top-left of the source sprite inside the canvas, px. */
  offset: [number, number];
  /** Source file name without extension (default label). */
  sourceName: string;
}

/** An image file picked in the open dialog (any folder), undecoded. */
export interface OpenedImageFile {
  /** File name with extension. */
  name: string;
  bytes: Uint8Array;
}

/** GET /balance: subscription.generations (remaining) / subscription.total, credits.usd. */
export interface Balance { generations: number | null; total: number | null; usd: number | null }

export interface EstimateResult {
  /** All 18, reordered by main into SKELETON_LABELS order (the API response is not); z_index still float. */
  keypoints: KeypointOut[];
  usage: Usage | null;
}

export interface AppInfo {
  /** Absolute data root. */
  dataRoot: string;
  /** Absolute dir holding appSettings.config (project root in dev). */
  appRoot: string;
  isDev: boolean;
}

/** Main → renderer events. Keys are IPC channel names. */
export interface ApiEvents {
  'app:before-close': void;
  'jobs:update': JobUpdateEvent;
}
export type ApiEventName = keyof ApiEvents;

export interface PixelToolkitApi {
  /**
   * Sandboxed to the data root: paths are POSIX, relative, and may not escape it (rejects otherwise).
   * Unexpected failures reject with an Error (handled globally).
   */
  fs: {
    readJson<T = unknown>(rel: string): Promise<T>;
    /**
     * Atomic (temp + fsync + rename). Written with formatJson. Fails if the parent dir is missing unless createDirs.
     * Resolves the file's new mtimeMs (the value scanData reports for it).
     */
    writeJson(rel: string, data: unknown, opts?: { createDirs?: boolean }): Promise<number>;
    readBinary(rel: string): Promise<Uint8Array>;
    /** Atomic; same parent-dir rule as writeJson. */
    writeBinary(rel: string, bytes: Uint8Array, opts?: { createDirs?: boolean }): Promise<void>;
    /**
     * File or dir. Retries EPERM/EBUSY/EACCES with backoff. Rejects if `toRel` exists, compared case-insensitively
     * (a case-only rename of the same entry is allowed). Never creates parent dirs: rejects when toRel's parent is missing.
     */
    rename(fromRel: string, toRel: string): Promise<void>;
    /** Creates one dir. Its parent must exist (never recursive, so a late call cannot resurrect a deleted folder); an existing dir is fine. */
    mkdir(rel: string): Promise<void>;
    /** User deletes: moves to the Recycle Bin (shell.trashItem). */
    trash(rel: string): Promise<void>;
    /** Image GC: permanent unlink of files (never dirs). A missing file counts as deleted. */
    deleteFiles(rels: string[]): Promise<{ deleted: string[]; failed: string[] }>;
    exists(rel: string): Promise<boolean>;
    /**
     * Folders, characters and animations only (no stat of PNGs; skips dot entries, *.tmp, *.png and links/junctions).
     * Top level: folders first, then characters and broken characters, each in natural name order.
     */
    scanData(): Promise<ScanNode[]>;
    /** Direct children of a dir ('' = data root), no stat; skips dot entries, *.tmp and links. A missing dir lists as []. */
    listDir(rel: string): Promise<DirEntry[]>;
  };
  /** appSettings.config. Secrets come back as SECRET_MASK (see settings.ts). */
  settings: {
    read(): Promise<AppSettings>;
    /** Deep-merges the patch; returns the new (masked) settings. */
    write(patch: SettingsPatch): Promise<AppSettings>;
  };
  /**
   * PNG import: file dialog, validate (PNG, ≤ 256 px per side), pad to a square canvas (never scaled), write.
   * Resolve null when the dialog is cancelled; reject with a user-facing message on invalid files.
   * Every file written here is also appended to SESSION_CREATED_REL (shared/dataPaths.ts).
   */
  images: {
    /** Writes "<charRel>/base.<uid>.png". */
    importBase(charRel: string): Promise<ImportedImage | null>;
    /** Writes "<charRel>/<animName>.<uid>.png" (animation-owned reference image). */
    importReference(charRel: string, animName: string): Promise<ImportedImage | null>;
    /** Copies the file `srcFile` (a file name inside charRel, e.g. "base.<uid>.png") to "<animName>.<newUid>.png". */
    copyToAnimation(charRel: string, srcFile: string, animName: string): Promise<{ uid: string }>;
  };
  /**
   * Files outside the data root (Img to PixelArt), only ever through a native dialog the user confirms. Unexpected
   * failures reject with a user-facing Error.
   */
  files: {
    /** Open dialog (OPEN_IMAGE_EXTENSIONS); the file's name and bytes, or null when cancelled. Rejects above MAX_OPEN_IMAGE_BYTES. */
    openImage(): Promise<OpenedImageFile | null>;
    /**
     * Save dialog (PNG filter, `suggestedName` in the last used folder); encodes `img` losslessly as 8-bit RGBA PNG and
     * writes it atomically. Resolves the absolute path written, or null when cancelled.
     */
    savePng(img: RgbaImage, suggestedName: string): Promise<string | null>;
  };
  /** Typed PixelLab operations; the key never leaves main. Never reject. */
  pixellab: {
    balance(): Promise<Result<Balance>>;
    /** Sends the PNG at imageRel (must be a padded square canvas). ≈0.1 generation. */
    estimateSkeleton(imageRel: string): Promise<Result<EstimateResult>>;
  };
  /** Main-process generation jobs (journaled, polled independently of tabs). */
  jobs: {
    /** Validates (validateSubmitInput), journals, POSTs. See SubmitAnimateResult. */
    submitAnimate(input: SubmitAnimateInput): Promise<SubmitAnimateResult>;
    list(): Promise<JobUpdateEvent[]>;
    get(key: string): Promise<JobRecord | null>;
    /** The renderer applied (or discarded) the result: remove the record and its staging dir. */
    ack(key: string): Promise<void>;
    /** DELETE /background-jobs/{id}, then status 'cancelled'. */
    cancel(key: string): Promise<Result<void>>;
    /**
     * The animation was renamed or moved (animation / character / folder rename): update the record's animRel and
     * push 'jobs:update'. Keeps headless apply and explorer busy flags working for docs that are not open.
     */
    retarget(key: string, animRel: string): Promise<void>;
    /** The animation got a fresh id (a copied json shared its original's): update the record's docId, push 'jobs:update'. */
    rekey(key: string, docId: string): Promise<void>;
  };
  app: {
    /** The renderer finished its close work; main destroys the window. */
    closeReady(): Promise<void>;
    /** Show a data-root item in Windows Explorer ('' = the data root). */
    revealInExplorer(rel: string): Promise<void>;
    /** Flash the taskbar button (when the window is unfocused). */
    flashFrame(): Promise<void>;
    getInfo(): Promise<AppInfo>;
  };
  /** Subscribe to a main → renderer event; returns the unsubscribe function. */
  on<K extends ApiEventName>(event: K, cb: (payload: ApiEvents[K]) => void): () => void;
}
