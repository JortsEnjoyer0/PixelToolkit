// Image files outside the data root (files.*, Img to PixelArt): the native open and save dialogs. Paths come only from
// these dialogs (or, unpackaged, the PT_TEST_* env hooks), never from the renderer. Reading, argument checks and the
// PNG write live in core/imageFiles.ts.
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import path from 'node:path';
import { IPC, type OpenedImageFile } from '../../shared/api';
import { OPEN_IMAGE_EXTENSIONS } from '../../shared/image';
import { checkRgbaImage, pngFileName, readImageFile, writePngFile } from '../core/imageFiles';
import { handleWithEvent } from './handle';

let lastOpenDir: string | undefined;
let lastSaveDir: string | undefined;

/**
 * DEV ONLY (automation): an absolute path in the env var `name` replaces a dialog in unpackaged builds:
 * PT_TEST_IMPORT_FILE the open dialog (shared with image import, ipc/images.ts), PT_TEST_SAVE_FILE the save dialog.
 */
function testPath(name: 'PT_TEST_IMPORT_FILE' | 'PT_TEST_SAVE_FILE'): string | null {
  const file = process.env[name];
  return !app.isPackaged && file && path.isAbsolute(file) ? file : null;
}

/** Native image picker parented to the sender's window; null when cancelled. */
async function pickImage(e: IpcMainInvokeEvent): Promise<string | null> {
  const testFile = testPath('PT_TEST_IMPORT_FILE');
  if (testFile)
    return testFile;
  const opts: OpenDialogOptions = {
    title: 'Open image', defaultPath: lastOpenDir, filters: [{ name: 'Images', extensions: [...OPEN_IMAGE_EXTENSIONS] }], properties: ['openFile']
  };
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  const file = res.canceled ? undefined : res.filePaths[0];
  if (!file)
    return null;
  lastOpenDir = path.dirname(file);
  return file;
}

/** Native PNG save dialog parented to the sender's window, suggesting `fileName` in the last used folder; null when cancelled. */
async function pickSavePath(e: IpcMainInvokeEvent, fileName: string): Promise<string | null> {
  const testFile = testPath('PT_TEST_SAVE_FILE');
  if (testFile)
    return testFile;
  const dir = lastSaveDir ?? lastOpenDir;
  const opts: SaveDialogOptions = {
    title: 'Save PNG', defaultPath: dir ? path.join(dir, fileName) : fileName, filters: [{ name: 'PNG image', extensions: ['png'] }],
    properties: ['showOverwriteConfirmation']
  };
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (res.canceled || !res.filePath)
    return null;
  lastSaveDir = path.dirname(res.filePath);
  return res.filePath;
}

export function registerFilesIpc(): void {
  // Dialog → check extension and size → name + bytes (the renderer decodes)
  handleWithEvent(IPC.filesOpenImage, async (e): Promise<OpenedImageFile | null> => {
    const file = await pickImage(e);
    return file ? readImageFile(file) : null;
  });
  // Check the arguments → dialog → encode → atomic write; resolves the path written
  handleWithEvent(IPC.filesSavePng, async (e, img: unknown, suggestedName: unknown): Promise<string | null> => {
    const image = checkRgbaImage(img);
    if (typeof suggestedName !== 'string')
      throw new TypeError('savePng: suggestedName must be a string');
    const file = await pickSavePath(e, pngFileName(suggestedName));
    return file ? writePngFile(file, image) : null;
  });
}
