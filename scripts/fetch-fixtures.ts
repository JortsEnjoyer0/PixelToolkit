// npm run fixtures
// Pads every assets/test_imgs/*.png onto its square canvas (testbed/fixtures/<name>.png) and, ONLY when
// testbed/fixtures/<name>.estimate.json is missing, calls POST /estimate-skeleton once for it (≈0.1 generation).
// Existing estimates are never re-fetched: delete a json file on purpose to pay for a new one.
// `npm run fixtures -- --dry` pads and reports without calling the API.
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { parseJsonText } from '../src/main/core/dataFs';
import { PixelLabClient, type PixelLabConfig } from '../src/main/core/pixellabClient';
import { decodePng, encodePng, padToSquare } from '../src/main/png';
import { formatJson, isObj } from '../src/shared/json';
import { SKELETON_LABELS, type EstimateFixtureFile, type EstimateSkeletonResponse, type KeypointOut } from '../src/shared/pixellab';
import { DEFAULT_SETTINGS } from '../src/shared/settings';

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'test_imgs');
const OUT_DIR = path.join(ROOT, 'testbed', 'fixtures');
const SETTINGS_PATH = path.join(ROOT, 'appSettings.config');
const TIMEOUT_MS = 120_000;
const DRY = process.argv.includes('--dry');

/** pixellab.* from appSettings.config (the app's file, BOM tolerated); the client checks the key and base URL. */
async function readApiConfig(): Promise<PixelLabConfig> {
  const raw = parseJsonText(await fsp.readFile(SETTINGS_PATH, 'utf8'));
  const pl = isObj(raw) && isObj(raw.pixellab) ? raw.pixellab : {};
  return {
    apiKey: typeof pl.apiKey === 'string' ? pl.apiKey : '',
    baseUrl: typeof pl.baseUrl === 'string' && pl.baseUrl ? pl.baseUrl : DEFAULT_SETTINGS.pixellab.baseUrl
  };
}

/** The app's transport (key and host checks, timeout, error text), but the RAW response: keypoints are kept in API order. */
const client = new PixelLabClient({ fetch, getConfig: readApiConfig });

async function estimate(png: Uint8Array): Promise<EstimateSkeletonResponse> {
  const body = { image: { type: 'base64', base64: Buffer.from(png).toString('base64'), format: 'png' } };
  const res = await client.request({ method: 'POST', path: '/estimate-skeleton', body, timeoutMs: TIMEOUT_MS });
  if (!res.ok)
    throw new Error(res.error ?? `HTTP ${res.status}`);
  if (!isObj(res.data) || !Array.isArray(res.data.keypoints))
    throw new Error('estimate-skeleton returned no keypoints');
  return res.data as unknown as EstimateSkeletonResponse;
}

function summarize(name: string, fx: EstimateFixtureFile): void {
  const byLabel = new Map<string, KeypointOut>(fx.keypoints.map((k) => [k.label, k]));
  const labelsOk = SKELETON_LABELS.every((l) => byLabel.has(l)) && fx.keypoints.length === SKELETON_LABELS.length;
  const zs = fx.keypoints.map((k) => k.z_index);
  const px = (k: KeypointOut | undefined): [number, number] => k ? [k.x * fx.canvas.width, k.y * fx.canvas.height] : [NaN, NaN];
  const [nx, ny] = px(byLabel.get('NECK'));
  const [rx, ry] = px(byLabel.get('RIGHT SHOULDER'));
  const [lx, ly] = px(byLabel.get('LEFT SHOULDER'));
  const neckErr = Math.hypot(nx - (rx + lx) / 2, ny - (ry + ly) / 2);
  const uniqueZ = [...new Set(zs)].sort((a, b) => a - b);
  console.log(`  ${name}: ${fx.keypoints.length} keypoints (${labelsOk ? 'all 18 labels' : 'LABELS MISMATCH'}), canvas ${fx.canvas.width}x${fx.canvas.height}, offset ${fx.offset.join(',')}`);
  console.log(`    z_index range [${Math.min(...zs)}, ${Math.max(...zs)}], distinct values ${uniqueZ.join(' ')}`);
  console.log(`    NECK vs shoulder midpoint: ${neckErr.toFixed(3)} px`);
}

async function main(): Promise<void> {
  await fsp.mkdir(OUT_DIR, { recursive: true });
  const files = (await fsp.readdir(SRC_DIR)).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  let calls = 0;
  let spent = 0;
  let failures = 0;
  for (const file of files) {
    const name = file.replace(/\.png$/i, '');
    const src = decodePng(new Uint8Array(await fsp.readFile(path.join(SRC_DIR, file))));
    const padded = padToSquare(src);
    const png = encodePng(padded.img);
    await fsp.writeFile(path.join(OUT_DIR, `${name}.png`), png);
    const jsonPath = path.join(OUT_DIR, `${name}.estimate.json`);
    if (existsSync(jsonPath)) {
      console.log(`${file}: ${src.width}x${src.height} → ${padded.width}x${padded.height}; estimate exists, not re-fetched`);
      continue;
    }
    if (DRY) {
      console.log(`${file}: ${src.width}x${src.height} → ${padded.width}x${padded.height}; offset ${padded.offset.join(',')}; would call estimate-skeleton (--dry)`);
      continue;
    }
    console.log(`${file}: ${src.width}x${src.height} → ${padded.width}x${padded.height}; calling estimate-skeleton...`);
    calls++;
    try {
      const res = await estimate(png);
      const fx: EstimateFixtureFile = {
        ...res,
        source: { file, width: src.width, height: src.height },
        canvas: { width: padded.width, height: padded.height },
        offset: padded.offset
      };
      await fsp.writeFile(jsonPath, formatJson(fx) + '\n');
      const gen = res.usage?.generations ?? 0;
      spent += gen;
      console.log(`  usage: ${JSON.stringify(res.usage ?? null)}`);
    } catch (e) {
      failures++;
      console.error(`  FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`\nEstimate calls this run: ${calls}, reported spend: ${spent.toFixed(2)} generations${failures ? `, ${failures} failed` : ''}`);
  console.log('\nFixtures:');
  for (const file of files) {
    const name = file.replace(/\.png$/i, '');
    const jsonPath = path.join(OUT_DIR, `${name}.estimate.json`);
    if (existsSync(jsonPath))
      summarize(name, parseJsonText(await fsp.readFile(jsonPath, 'utf8')) as EstimateFixtureFile);
  }
  if (failures)
    process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});
