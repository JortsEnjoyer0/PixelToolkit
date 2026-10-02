import { BrowserWindow } from 'electron';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const DEV_SCREENSHOT_PORT = 47321;

/** PT_SCREENSHOT_PORT overrides the default port (e.g. a second checkout running at the same time). */
export function devScreenshotPort(): number {
  const port = Number(process.env['PT_SCREENSHOT_PORT']);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEV_SCREENSHOT_PORT;
}

/**
 * Requests from tools (curl, scripts) only. A Host other than our loopback address (DNS rebinding) or browser fetch
 * metadata (Origin, a Sec-Fetch-Site other than a typed URL's 'none') means a web page is asking: refused.
 */
function isLocalToolRequest(req: http.IncomingMessage, port: number): boolean {
  const host = req.headers.host ?? '';
  const site = req.headers['sec-fetch-site'];
  return (host === `127.0.0.1:${port}` || host === `localhost:${port}`) && req.headers.origin === undefined && (site === undefined || site === 'none');
}

/**
 * Dev, or a packaged build started with PT_DEV_SCREENSHOT=1 (opt-in for automation). Binds to loopback.
 *   GET http://127.0.0.1:47321/health                  -> { ok: true }
 *   GET http://127.0.0.1:47321/screenshot              -> image/png body, also written to <outDir>/shot-<ts>.png
 *   GET http://127.0.0.1:47321/screenshot?file=a.png   -> writes <outDir>/a.png
 */
export function startDevScreenshotServer(getWin: () => BrowserWindow | null, outDir: string, port = devScreenshotPort()): void {
  const server = http.createServer(async (req, res) => {
    if (!isLocalToolRequest(req, port)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname !== '/screenshot') {
        res.writeHead(404).end();
        return;
      }
      const win = getWin();
      if (!win || win.isDestroyed())
        throw new Error('no window');
      if (win.isMinimized())
        win.restore(); // minimized windows capture as empty images
      const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (img.isEmpty())
        throw new Error('captured an empty image (window hidden or occluded?)');
      const png = img.toPNG();
      const name = path.basename(url.searchParams.get('file') || `shot-${Date.now()}.png`); // no dirs
      const file = path.join(outDir, name.endsWith('.png') ? name : `${name}.png`);
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(file, png);
      const { width, height } = img.getSize();
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'X-Screenshot-Path': encodeURIComponent(file),
        'X-Size': `${width}x${height}`
      });
      res.end(png);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String((e as Error).message));
    }
  });
  server.on('error', (e) => {
    console.warn(`[devScreenshot] not started on 127.0.0.1:${port}: ${e.message}`);
  });
  server.listen(port, '127.0.0.1');
}
