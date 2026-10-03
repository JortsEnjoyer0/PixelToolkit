// PNG import and copies (docs/architecture.md "Data root and files"). The dialog lives here; validation, padding, the
// atomic write and the session-created record live in core/imageImport.ts.
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';
import path from 'node:path';
import { IPC, type ImportedImage } from '../../shared/api';
import { animImageFileName, baseImageFileName } from '../../shared/dataPaths';
import { assertCharacterDir, checkEntityName, copyToAnimation, importImageFile } from '../core/imageImport';
import { handle, handleWithEvent } from './handle';

let lastDir: string | undefined;

/** DEV ONLY (automation): an absolute PNG path in PT_TEST_IMPORT_FILE replaces the file dialog in unpackaged builds. */
function testImportFile(): string | null {
  const file = process.env['PT_TEST_IMPORT_FILE'];
  return !app.isPackaged && file && path.isAbsolute(file) ? file : null;
}

/** Native PNG picker parented to the sender's window; null when cancelled. */
async function pickPng(e: IpcMainInvokeEvent, title: string): Promise<string | null> {
  const testFile = testImportFile();
  if (testFile)
    return testFile;
  const opts: OpenDialogOptions = { title, defaultPath: lastDir, filters: [{ name: 'PNG images', extensions: ['png'] }], properties: ['openFile'] };
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const file = res.canceled ? undefined : res.filePaths[0];
  if (!file)
    return null;
  lastDir = path.dirname(file);
  return file;
}

export function registerImagesIpc(): void {
  // Dialog → validate (PNG, ≤ 256 px) → pad → write "<charRel>/base.<uid>.png"
  handleWithEvent(IPC.imagesImportBase, async (e, charRel: string): Promise<ImportedImage | null> => {
    await assertCharacterDir(charRel);
    const file = await pickPng(e, 'Import base image');
    return file ? importImageFile(file, charRel, baseImageFileName) : null;
  });
  // Dialog → validate → pad → write "<charRel>/<animName>.<uid>.png"
  handleWithEvent(IPC.imagesImportReference, async (e, charRel: string, animName: string): Promise<ImportedImage | null> => {
    const name = checkEntityName(animName, 'animation');
    await assertCharacterDir(charRel);
    const file = await pickPng(e, 'Import reference image');
    return file ? importImageFile(file, charRel, (u) => animImageFileName(name, u)) : null;
  });
  // Byte copy "<charRel>/<srcFile>" → "<charRel>/<animName>.<newUid>.png"
  handle(IPC.imagesCopyToAnimation, async (charRel: string, srcFile: string, animName: string) => copyToAnimation(charRel, srcFile, animName));
}
