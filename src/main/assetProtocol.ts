import { net, protocol } from 'electron';
import { promises as fsp } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ASSET_SCHEME } from '../shared/api';
import { assetRelFromUrl, isImmutableAsset } from './core/assetPath';
import { resolveChecked } from './core/dataFs';

/** Call at module top level (before app 'ready'). */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ]);
}

const text = (status: number, body: string): Response => new Response(body, { status, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });

/**
 * Call after 'ready'. Serves files below the data root: ptk-asset://data/<rel>[?v=n]. Segments are decoded one by one;
 * the path must stay inside the data root after realpath (junctions included) → otherwise 403; missing → 404.
 * "<owner>.<uid>.png" files are immutable (new pixels = new uid), so they are cached for a year.
 */
export function handleAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return text(405, 'method not allowed');
    const rel = assetRelFromUrl(req.url);
    if (rel === null)
      return text(404, 'not found');
    let abs: string;
    try {
      abs = await resolveChecked(rel);
    } catch {
      return text(403, 'forbidden');
    }
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile())
      return text(404, 'not found');
    let file: Response;
    try {
      file = await net.fetch(pathToFileURL(abs).toString());
    } catch {
      return text(404, 'not found');
    }
    if (!file.ok)
      return text(file.status === 403 ? 403 : 404, 'not found');
    // CORS header so WebGL can sample the images (three.js loads them with crossOrigin = 'anonymous')
    const headers = new Headers(file.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', isImmutableAsset(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (!headers.has('Content-Type') && /\.png$/i.test(rel))
      headers.set('Content-Type', 'image/png');
    return new Response(req.method === 'HEAD' ? null : file.body, { status: 200, headers });
  });
}
