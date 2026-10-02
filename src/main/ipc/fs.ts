// Sandboxed fs IPC (PLAN §2 ipc/fs.ts). The logic lives in core/dataFs.ts (electron-free, tested by scripts/).
import { shell } from 'electron';
import { IPC } from '../../shared/api';
import { PTK_DIR } from '../../shared/dataPaths';
import {
  deleteFiles, exists, listDir, makeDir, readBinary, readJson, renameEntry, resolveChecked, scanData, writeBinary, writeJson
} from '../core/dataFs';
import { noteCreatedImages } from '../core/sessionCreated';
import { handle } from './handle';

const fromPtk = (rel: unknown): boolean => typeof rel === 'string' && rel.startsWith(PTK_DIR + '/');

export function registerFsIpc(): void {
  handle(IPC.fsReadJson, async (rel: string) => readJson(rel));
  handle(IPC.fsWriteJson, async (rel: string, data: unknown, opts?: { createDirs?: boolean }) => writeJson(rel, data, opts));
  handle(IPC.fsReadBinary, async (rel: string) => readBinary(rel)); // arrives as Uint8Array in the renderer
  handle(IPC.fsWriteBinary, async (rel: string, bytes: Uint8Array, opts?: { createDirs?: boolean }) => {
    await writeBinary(rel, bytes, opts);
    await noteCreatedImages([rel]); // only "<owner>.<uid>.png" files outside .ptk are recorded
  });
  handle(IPC.fsRename, async (fromRel: string, toRel: string) => {
    await renameEntry(fromRel, toRel);
    if (fromPtk(fromRel))
      await noteCreatedImages([toRel]); // a staged job result moved into a character dir
  });
  handle(IPC.fsMkdir, async (rel: string) => makeDir(rel));
  handle(IPC.fsTrash, async (rel: string) => {
    await shell.trashItem(await resolveChecked(rel)); // Recycle Bin: recoverable
  });
  handle(IPC.fsDeleteFiles, async (rels: string[]) => deleteFiles(rels));
  handle(IPC.fsExists, async (rel: string) => exists(rel));
  handle(IPC.fsScanData, async () => scanData());
  handle(IPC.fsListDir, async (rel: string) => listDir(rel));
}
