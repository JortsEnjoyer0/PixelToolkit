// The renderer only sees the typed operations below (window.api.pixellab.*) and the job service (main/jobs.ts);
// the API key never leaves main. Transport and response mapping: core/pixellabClient.ts.
import { net } from 'electron';
import { IPC } from '../../shared/api';
import { readCanvasPng } from '../core/imageImport';
import { PixelLabClient } from '../core/pixellabClient';
import { loadSettings } from './settings';
import { handleResult } from './handle';

/** net.fetch uses Chromium's network stack (system proxy and certificates). Key + base URL read at call time. */
export const pixelLab = new PixelLabClient({
  fetch: (url, init) => net.fetch(url, init),
  getConfig: async () => (await loadSettings()).pixellab
});

export function registerPixelLabIpc(): void {
  handleResult(IPC.plBalance, () => pixelLab.balance());
  handleResult(IPC.plEstimateSkeleton, async (imageRel: string) => pixelLab.estimateSkeleton((await readCanvasPng(imageRel)).bytes));
}
