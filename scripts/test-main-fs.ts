// npm run test:main (or npx tsx scripts/test-main-fs.ts)
// Node checks for the electron-free main-process cores: sandboxed fs (atomic writes, renames, deleteFiles, scanData,
// listDir, temp cleanup, junction guard), the asset URL parser, PNG import / copy, image files outside the data root
// (open limits, RGBA checks, save names, PNG writes), the session-created sweep and the PixelLab client mapping (fake
// fetch). No Electron, no network. Temp dirs go under PT_TEST_TMP (default: os.tmpdir()).
import { promises as fsp, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_ERROR_PREFIX, type ScanNode } from '../src/shared/api';
import { SESSION_CREATED_REL, animImageFileName, baseImageFileName } from '../src/shared/dataPaths';
import { MAX_IMAGE_SIDE, MAX_OPEN_IMAGE_BYTES } from '../src/shared/image';
import { SKELETON_LABELS } from '../src/shared/pixellab';
import { assetRelFromUrl, isImmutableAsset } from '../src/main/core/assetPath';
import {
  cleanupStaleTmp, deleteFiles, listDir, makeDir, readJson, renameEntry, resolveChecked, scanData, setDataRoot, writeBinary, writeJson
} from '../src/main/core/dataFs';
import { checkRgbaImage, pngFileName, readImageFile, writePngFile } from '../src/main/core/imageFiles';
import { copyToAnimation, importImageFile, prepareImport, readCanvasPng } from '../src/main/core/imageImport';
import { PixelLabClient, type FetchLike } from '../src/main/core/pixellabClient';
import { listSessionCreated, sweepSessionCreated } from '../src/main/core/sessionCreated';
import { decodePng, encodePng } from '../src/main/png';

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_128 = path.join(ROOT, 'testbed', 'fixtures', 'merchant_rightfacing_truepixel_128.png');
const SOURCE_162 = path.join(ROOT, 'assets', 'test_imgs', 'peasantboy2_facingcamera_turepixel_162x151.png');

let failures = 0;
let passes = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++;
    return;
  }
  failures++;
  console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

async function rejects(name: string, p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
    check(name, false, 'did not reject');
  } catch (e) {
    check(name, re.test((e as Error).message), (e as Error).message);
  }
}

const write = async (abs: string, data: string | Uint8Array): Promise<void> => {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data);
};

const solidPng = (w: number, h: number): Uint8Array => encodePng({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(200) });

async function testFs(base: string): Promise<void> {
  console.log('fs core');
  const root = await setDataRoot(path.join(base, 'data'));
  const abs = (rel: string): string => path.join(root, ...rel.split('/'));

  // atomic, non-recursive writes
  const writtenMtime = await writeJson('a.json', { x: [1, 2, 3], s: 'v' });
  check('writeJson resolves the new mtime (as scanData reports it)', writtenMtime === (await fsp.stat(abs('a.json'))).mtimeMs);
  check('writeJson formats', readFileSync(abs('a.json'), 'utf8') === '{\n  "x": [1, 2, 3],\n  "s": "v"\n}\n');
  check('writeJson leaves no temp file', (await fsp.readdir(root)).every((n) => !n.endsWith('.tmp')));
  await rejects('write into a missing dir fails', writeJson('Missing/a.json', {}), /no longer exists/);
  check('write never creates the missing dir', !existsSync(abs('Missing')));
  await writeJson('Made/a.json', {}, { createDirs: true });
  check('createDirs creates the dir', existsSync(abs('Made/a.json')));
  await writeBinary('Made/b.bin', new Uint8Array([1, 2, 3]));
  check('writeBinary', readFileSync(abs('Made/b.bin')).equals(Buffer.from([1, 2, 3])));
  check('readJson tolerates a BOM', await (async () => {
    await write(abs('bom.json'), '\uFEFF{"k":1}');
    return (await readJson('bom.json') as { k: number }).k === 1;
  })());
  await rejects('escape is rejected', readJson('../outside.json'), /escapes the data root/);
  await rejects('absolute is rejected', readJson('C:/Windows/win.ini'), /Absolute paths/);

  // stale temp cleanup: only atomicWrite's own "<name>.<12 hex>.tmp", down to the job staging dirs
  const stale = ['x.json.0123456789ab.tmp', '.ptk/jobs.json.a1b2c3d4e5f6.tmp', 'Folder/Char/Walk.json.ffffffffffff.tmp',
    '.ptk/jobs/k3j9x2a1/p0a9s8d7.png.00aa11bb22cc.tmp'];
  const foreign = ['Made/deep/y.tmp', '~WRL0001.tmp', 'Made/x.json.abc123.tmp', 'Deep/a/b/c/e.json.0123456789ab.tmp', 'Made/keep.json'];
  for (const rel of [...stale, ...foreign])
    await write(abs(rel), '');
  check('cleanupStaleTmp count', await cleanupStaleTmp() === stale.length);
  check('cleanupStaleTmp removes atomic temp files', stale.every((rel) => !existsSync(abs(rel))));
  check('cleanupStaleTmp keeps other temp files and files below the data layout', foreign.every((rel) => existsSync(abs(rel))));
  await fsp.rm(abs('Deep'), { recursive: true });

  // renames
  await write(abs('Char/Walk.json'), '{}');
  await write(abs('Char/Run.json'), '{}');
  await rejects('rename onto an existing file', renameEntry('Char/Walk.json', 'Char/Run.json'), /already exists/);
  await rejects('rename onto a case-insensitive clash', renameEntry('Char/Walk.json', 'Char/run.json'), /already exists/);
  await renameEntry('Char/Walk.json', 'Char/walk.json');
  check('case-only rename of itself', (await fsp.readdir(abs('Char'))).includes('walk.json'));
  await rejects('rename never creates parent dirs', renameEntry('Char/walk.json', 'Nope/walk.json'), /does not exist/);
  check('rename did not create the parent', !existsSync(abs('Nope')));
  await rejects('rename of a missing source', renameEntry('Char/missing.json', 'Char/other.json'), /ENOENT/);
  await renameEntry('Char', 'Char2');
  check('dir rename', existsSync(abs('Char2/walk.json')) && !existsSync(abs('Char')));
  await renameEntry('Char2', 'char2');
  check('case-only dir rename', (await fsp.readdir(root)).includes('char2'));

  // deleteFiles
  await write(abs('char2/a.k3j9x2a1.png'), 'x');
  const del = await deleteFiles(['char2/a.k3j9x2a1.png', 'char2/missing.png', 'char2']);
  check('deleteFiles deleted', JSON.stringify(del.deleted) === JSON.stringify(['char2/a.k3j9x2a1.png', 'char2/missing.png']), JSON.stringify(del));
  check('deleteFiles never deletes dirs', JSON.stringify(del.failed) === JSON.stringify(['char2']) && existsSync(abs('char2')));
  await rejects('deleteFiles rejects escapes', deleteFiles(['char2/../../x.png']), /escapes/);

  // mkdir
  await makeDir('NewFolder');
  await makeDir('NewFolder');
  check('makeDir (and again)', existsSync(abs('NewFolder')));
  await rejects('makeDir is not recursive', makeDir('Nope/Sub'), /parent folder does not exist/);

  // junction guard
  const outside = path.join(base, 'outside');
  await write(path.join(outside, 'secret.json'), '{"secret":true}');
  await fsp.symlink(outside, abs('link'), 'junction');
  await rejects('read through a junction', readJson('link/secret.json'), /escapes/);
  await rejects('write through a junction', writeJson('link/new.json', {}), /escapes/);
  check('nothing written outside', !existsSync(path.join(outside, 'new.json')));
  await rejects('resolveChecked of a missing file below a junction', resolveChecked('link/sub/x.png'), /escapes/);
  check('listDir skips links', (await listDir('')).every((d) => d.name !== 'link'));
}

async function testScan(base: string): Promise<void> {
  console.log('scanData / listDir');
  const root = await setDataRoot(path.join(base, 'scan'));
  const abs = (rel: string): string => path.join(root, ...rel.split('/'));
  await write(abs('Townsfolk/Merchant.json'), '{}');
  await write(abs('Townsfolk/Merchant/Walk South.json'), '{}');
  await write(abs('Townsfolk/Merchant/Walk 10.json'), '{}');
  await write(abs('Townsfolk/Merchant/Walk 9.json'), '{}');
  await write(abs('Townsfolk/Merchant/Walk South.k3j9x2a1.png'), 'x');
  await write(abs('Townsfolk/Merchant/base.p0a9s8d7.png'), 'x');
  await write(abs('Townsfolk/Merchant/Walk South.json.abc.tmp'), '');
  await write(abs('Townsfolk/Merchant/Sub/Nested.json'), '{}');
  await write(abs('Townsfolk/Orphan.json'), '{}');
  await fsp.mkdir(abs('Townsfolk/Stray Dir'), { recursive: true });
  await write(abs('Peasant Boy.json'), '{}');
  await fsp.mkdir(abs('peasant boy'), { recursive: true });
  await write(abs('Broken.json'), '{}');
  await fsp.mkdir(abs('Empty Folder'), { recursive: true });
  await write(abs('.ptk/jobs.json'), '{}');
  await write(abs('stray.png'), 'x');
  await write(abs('a.json.123.tmp'), '');
  const nodes = await scanData();
  const brief = (n: ScanNode): unknown => [n.kind, n.name, n.rel, n.mtimeMs === null ? null : 'm', n.children.map(brief)];
  const want = [
    ['folder', 'Empty Folder', 'Empty Folder', null, []],
    ['folder', 'Townsfolk', 'Townsfolk', null, [
      ['character', 'Merchant', 'Townsfolk/Merchant', 'm', [
        ['animation', 'Walk 9', 'Townsfolk/Merchant/Walk 9.json', 'm', []],
        ['animation', 'Walk 10', 'Townsfolk/Merchant/Walk 10.json', 'm', []],
        ['animation', 'Walk South', 'Townsfolk/Merchant/Walk South.json', 'm', []]
      ]],
      ['brokenCharacter', 'Orphan', 'Townsfolk/Orphan', 'm', []]
    ]],
    ['brokenCharacter', 'Broken', 'Broken', 'm', []],
    ['character', 'peasant boy', 'peasant boy', 'm', []]
  ];
  check('scanData tree', JSON.stringify(nodes.map(brief)) === JSON.stringify(want), JSON.stringify(nodes.map(brief)));
  const list = await listDir('Townsfolk/Merchant');
  check('listDir', JSON.stringify(list) === JSON.stringify([
    { name: 'base.p0a9s8d7.png', kind: 'file' }, { name: 'Sub', kind: 'dir' }, { name: 'Walk 9.json', kind: 'file' },
    { name: 'Walk 10.json', kind: 'file' }, { name: 'Walk South.json', kind: 'file' }, { name: 'Walk South.k3j9x2a1.png', kind: 'file' }
  ]), JSON.stringify(list));
  check('listDir root hides .ptk and temp files', (await listDir('')).every((d) => d.name !== '.ptk' && !d.name.endsWith('.tmp')));
  check('listDir of a missing dir', (await listDir('Nope')).length === 0);
}

function testAssetUrls(): void {
  console.log('asset URLs');
  check('asset url decode', assetRelFromUrl('ptk-asset://data/Townsfolk/Merchant/Walk%20South.k3j9x2a1.png?v=3') === 'Townsfolk/Merchant/Walk South.k3j9x2a1.png');
  check('asset url unicode', assetRelFromUrl(`ptk-asset://data/${encodeURIComponent('Zwölf')}/a.png`) === 'Zwölf/a.png');
  check('asset url encoded slash', assetRelFromUrl('ptk-asset://data/a%2F..%2F..%2Fx.png') === null);
  check('asset url encoded backslash', assetRelFromUrl('ptk-asset://data/a%5C..%5Cx.png') === null);
  // URL parsing already resolves (encoded) dot segments, and never above the host
  check('asset url dot segments', assetRelFromUrl('ptk-asset://data/a/%2e%2e/x.png') === 'x.png' && assetRelFromUrl('ptk-asset://data/../../x.png') === 'x.png');
  check('asset url encoded dots plus slash', assetRelFromUrl('ptk-asset://data/a/%2E%2E%2Fx.png') === null);
  check('asset url bad escape', assetRelFromUrl('ptk-asset://data/a%E0%A4%A.png') === null);
  check('asset url wrong host', assetRelFromUrl('ptk-asset://other/a.png') === null);
  check('asset url empty', assetRelFromUrl('ptk-asset://data/') === null);
  check('immutable image', isImmutableAsset('A/B/Walk.k3j9x2a1.png') && !isImmutableAsset('A/B/Walk.json') && !isImmutableAsset('A/x.png'));
  const stripped = (msg: string): string => msg.replace(IPC_ERROR_PREFIX, '');
  check('IPC_ERROR_PREFIX matches the Electron prefix', stripped('Error invoking remote method \'images:importBase\': Error: "a.png" is not a PNG file') === '"a.png" is not a PNG file'
    && stripped('plain') === 'plain');
}

async function testImages(base: string): Promise<void> {
  console.log('image import');
  const root = await setDataRoot(path.join(base, 'images'));
  await fsp.mkdir(path.join(root, 'Town', 'Merchant'), { recursive: true });
  const p = prepareImport(new Uint8Array(readFileSync(SOURCE_162)), 'peasant.png');
  check('pad 162x151 → 256', p.width === 256 && p.height === 256 && p.srcWidth === 162 && p.srcHeight === 151 && p.offset[0] === 47 && p.offset[1] === 52, JSON.stringify({ ...p, png: undefined }));
  const src = decodePng(new Uint8Array(readFileSync(SOURCE_162)));
  const out = decodePng(p.png);
  let same = true;
  for (let y = 0; y < src.height && same; y++) {
    for (let x = 0; x < src.width && same; x++) {
      const a = (y * src.width + x) * 4;
      const b = ((y + 52) * 256 + x + 47) * 4;
      same = src.data[a] === out.data[b] && src.data[a + 3] === out.data[b + 3];
    }
  }
  check('padding keeps pixels', same && out.data[3] === 0);
  let threw = '';
  try {
    prepareImport(solidPng(300, 10), 'wide.png');
  } catch (e) {
    threw = (e as Error).message;
  }
  check('reject > 256 px', /longest side cannot exceed 256px/.test(threw), threw);
  try {
    prepareImport(new Uint8Array([1, 2, 3, 4]), 'fake.png');
  } catch (e) {
    threw = (e as Error).message;
  }
  check('reject non-PNG', /not a PNG/.test(threw), threw);

  const img = await importImageFile(FIXTURE_128, 'Town/Merchant', baseImageFileName);
  check('importImageFile shape', img.width === 128 && img.height === 128 && img.srcWidth === 128 && img.offset[0] === 0
    && img.sourceName === 'merchant_rightfacing_truepixel_128' && existsSync(path.join(root, 'Town', 'Merchant', `base.${img.uid}.png`)), JSON.stringify(img));
  await rejects('import into a missing character dir', importImageFile(FIXTURE_128, 'Town/Nobody', baseImageFileName), /does not exist/);
  const copy = await copyToAnimation('Town/Merchant', `base.${img.uid}.png`, 'Walk South');
  const copied = path.join(root, 'Town', 'Merchant', animImageFileName('Walk South', copy.uid));
  check('copyToAnimation is a byte copy', readFileSync(copied).equals(readFileSync(path.join(root, 'Town', 'Merchant', `base.${img.uid}.png`))));
  await rejects('copyToAnimation rejects path tricks', copyToAnimation('Town/Merchant', '../x.png', 'Walk'), /Invalid source/);
  await rejects('copyToAnimation rejects bad names', copyToAnimation('Town/Merchant', `base.${img.uid}.png`, 'base'), /Invalid animation name/);
  check('readCanvasPng 128', (await readCanvasPng(`Town/Merchant/base.${img.uid}.png`)).width === 128);
  await fsp.copyFile(SOURCE_162, path.join(root, 'Town', 'Merchant', 'raw.png'));
  await rejects('readCanvasPng rejects non-square', readCanvasPng('Town/Merchant/raw.png'), /square/);
  const listed = await listSessionCreated();
  check('session-created records imports', listed.length === 2 && listed[0].ownerRel === 'Town/Merchant.json'
    && listed[1].ownerRel === 'Town/Merchant/Walk South.json' && listed[1].uid === copy.uid, JSON.stringify(listed));
}

/** The message `fn` throws, or '' when it returns. */
function thrown(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

async function testImageFiles(base: string): Promise<void> {
  console.log('image files (outside the data root)');
  const dir = path.join(base, 'files');
  const at = (name: string): string => path.join(dir, name);
  await fsp.mkdir(dir, { recursive: true });

  // readImageFile: the extension (any case) and the size are checked before reading
  const png = solidPng(3, 2);
  await write(at('sprite.PNG'), png);
  const opened = await readImageFile(at('sprite.PNG'));
  check('readImageFile name and bytes', opened.name === 'sprite.PNG' && opened.bytes instanceof Uint8Array && Buffer.from(opened.bytes).equals(Buffer.from(png)));
  await write(at('scan.tiff'), png);
  await rejects('readImageFile rejects other extensions', readImageFile(at('scan.tiff')), /^Could not open "scan\.tiff": \.tiff files are not supported/);
  await write(at('noext'), png);
  await rejects('readImageFile rejects a missing extension', readImageFile(at('noext')), /^Could not open "noext": files without an extension/);
  const fh = await fsp.open(at('huge.webp'), 'w');
  await fh.truncate(MAX_OPEN_IMAGE_BYTES + 1); // extends without writing the bytes
  await fh.close();
  await rejects('readImageFile rejects files above MAX_OPEN_IMAGE_BYTES', readImageFile(at('huge.webp')), /^Could not open "huge\.webp": the file is too large/);
  await fsp.rm(at('huge.webp'));
  await write(at('empty.gif'), '');
  await rejects('readImageFile rejects an empty file', readImageFile(at('empty.gif')), /^Could not open "empty\.gif": the file is empty/);
  await fsp.mkdir(at('folder.png'));
  await rejects('readImageFile rejects a dir', readImageFile(at('folder.png')), /^Could not open "folder\.png": not a file/);
  await rejects('readImageFile of a missing file', readImageFile(at('gone.jpg')), /^Could not open "gone\.jpg": the file no longer exists/);

  // checkRgbaImage: untrusted IPC input
  const valid = { width: 2, height: 1, data: new Uint8Array(8), extra: 'x' };
  const checked = checkRgbaImage(valid);
  check('checkRgbaImage accepts a valid image (other fields dropped)', checked.width === 2 && checked.height === 1 && checked.data === valid.data && !('extra' in checked));
  check('checkRgbaImage accepts MAX_IMAGE_SIDE', checkRgbaImage({ width: MAX_IMAGE_SIDE, height: 1, data: new Uint8Array(MAX_IMAGE_SIDE * 4) }).width === MAX_IMAGE_SIDE);
  const invalid: [string, unknown, RegExp][] = [
    ['a wrong data length', { width: 2, height: 2, data: new Uint8Array(8) }, /expected 16/],
    ['a non-integer width', { width: 1.5, height: 2, data: new Uint8Array(12) }, /whole numbers/],
    ['a zero height', { width: 2, height: 0, data: new Uint8Array(0) }, /whole numbers/],
    ['an oversize side', { width: MAX_IMAGE_SIDE + 1, height: 1, data: new Uint8Array((MAX_IMAGE_SIDE + 1) * 4) }, /whole numbers/],
    ['a string width', { width: '2', height: 1, data: new Uint8Array(8) }, /whole numbers/],
    ['number array data', { width: 1, height: 1, data: [0, 0, 0, 0] }, /must be a Uint8Array/],
    ['Uint8ClampedArray data', { width: 1, height: 1, data: new Uint8ClampedArray(4) }, /must be a Uint8Array/],
    ['null', null, /expected \{ width/],
    ['an array', [2, 1], /expected \{ width/],
    ['a typed array', new Uint8Array(8), /expected \{ width/]
  ];
  for (const [what, v, re] of invalid) {
    const msg = thrown(() => checkRgbaImage(v));
    check(`checkRgbaImage rejects ${what}`, re.test(msg), msg);
  }

  // pngFileName: the save dialog's default name
  const names: [string, string][] = [
    ['sprite', 'sprite.png'], ['sprite.png', 'sprite.png'], ['Sprite.PNG', 'Sprite.png'], ['photo.jpeg', 'photo.png'],
    ['archive.tar', 'archive.tar.png'], ['a<b>c:d"e/f\\g|h?i*j', 'abcdefghij.png'], ['bad\u0000na\u001fme\u007f', 'badname.png'],
    ['  name . . ', 'name.png'], ['name .png. ', 'name.png'], ['..hidden', 'hidden.png'], ['', 'pixelart.png'],
    ['   ', 'pixelart.png'], ['.png', 'pixelart.png'], ['???', 'pixelart.png'], ['CON', '_CON.png'], ['nul.png', '_nul.png'],
    ['com1.tar', '_com1.tar.png'], ['console', 'console.png'], ['Zwölf ✨', 'Zwölf ✨.png']
  ];
  for (const [input, want] of names)
    check(`pngFileName(${JSON.stringify(input)})`, pngFileName(input) === want, pngFileName(input));
  const long = pngFileName('a'.repeat(300));
  check('pngFileName caps the length', /^a+\.png$/.test(long) && long.length < 200, long);
  const cut = pngFileName(`${'a'.repeat(long.length - 5)} ${'b'.repeat(50)}`);
  check('pngFileName trims edge spaces after the cut', cut === long.slice(1), cut);
  const emoji = pngFileName('😀'.repeat(300));
  check('pngFileName cuts whole code points', Array.from(emoji.slice(0, -4)).every((ch) => ch === '😀'), emoji);

  // writePngFile: lossless RGBA PNG, atomic, never creates folders
  const px = new Uint8Array([255, 0, 0, 255, 10, 20, 30, 0, 40, 50, 60, 128, 1, 2, 3, 254]);
  const img = { width: 2, height: 2, data: px };
  check('writePngFile resolves the path written', await writePngFile(at('out.png'), img) === at('out.png'));
  const back = decodePng(new Uint8Array(readFileSync(at('out.png'))));
  check('writePngFile round-trip is exact (incl. alpha 0 and 128)', back.width === 2 && back.height === 2 && Buffer.from(back.data).equals(Buffer.from(px)));
  await writePngFile(at('out.png'), { width: 1, height: 1, data: new Uint8Array([9, 9, 9, 9]) });
  check('writePngFile replaces the chosen file', decodePng(new Uint8Array(readFileSync(at('out.png')))).width === 1);
  const appended = await writePngFile(at('plain'), img);
  check('writePngFile appends .png to a name without extension', appended === at('plain.png') && existsSync(appended) && !existsSync(at('plain')));
  check('writePngFile leaves no temp file', (await fsp.readdir(dir)).every((n) => !n.endsWith('.tmp')));
  await rejects('writePngFile never creates folders', writePngFile(path.join(dir, 'missing', 'x.png'), img), /no longer exists/);
  check('writePngFile did not create the folder', !existsSync(at('missing')));
  await rejects('writePngFile needs an absolute path', writePngFile('relative.png', img), /absolute path/);
  check('writePngFile drops trailing dots and spaces like Windows', await writePngFile(at('dots.png. '), img) === at('dots.png') && existsSync(at('dots.png')));
  check('…and appends .png after them', await writePngFile(at('bare. '), img) === at('bare.png') && existsSync(at('bare.png')));
  check('…without leaving a temp file', (await fsp.readdir(dir)).every((n) => !n.endsWith('.tmp')));
  await writePngFile(at('ro.png'), img);
  await fsp.chmod(at('ro.png'), 0o444);
  await rejects('a failed save names the file and the reason, not the temp file', writePngFile(at('ro.png'), img), /^Could not save "ro\.png": the file is read-only/);
  await fsp.chmod(at('ro.png'), 0o666);
  const t0 = performance.now();
  const spaced = pngFileName(`a${' '.repeat(200000)}b`);
  check('pngFileName bounds untrusted input (no quadratic backtracking)', performance.now() - t0 < 500 && spaced === 'a.png', spaced);
}

async function testSweep(base: string): Promise<void> {
  console.log('session-created sweep');
  const root = await setDataRoot(path.join(base, 'sweep'));
  const abs = (rel: string): string => path.join(root, ...rel.split('/'));
  await fsp.mkdir(abs('Town/Merchant'), { recursive: true });
  await fsp.mkdir(abs('Town/Smith'), { recursive: true });
  const ref = (anim: string): (u: string) => string => (u) => animImageFileName(anim, u);
  const b1 = await importImageFile(FIXTURE_128, 'Town/Merchant', baseImageFileName); // referenced by the character json
  const b2 = await importImageFile(FIXTURE_128, 'Town/Merchant', baseImageFileName); // orphan
  const r1 = await importImageFile(FIXTURE_128, 'Town/Merchant', ref('Walk')); // referenced by Walk.json
  const r2 = await importImageFile(FIXTURE_128, 'Town/Merchant', ref('Walk')); // orphan
  const r3 = await importImageFile(FIXTURE_128, 'Town/Merchant', ref('Old')); // owner renamed Old → Run, referenced
  const r4 = await importImageFile(FIXTURE_128, 'Town/Merchant', ref('Old')); // owner renamed, orphan
  const c1 = await copyToAnimation('Town/Merchant', baseImageFileName(b1.uid), 'Walk'); // only a pending job needs it
  const x1 = await importImageFile(FIXTURE_128, 'Town/Smith', ref('Bad')); // beside an unparsable json
  await writeJson('Town/Merchant.json', { baseImages: [{ uid: b1.uid }] });
  await writeJson('Town/Merchant/Walk.json', { reference: { image: r1.uid }, frames: [] });
  await writeJson('Town/Smith.json', { baseImages: [] });
  await write(abs('Town/Smith/Bad.json'), '{ not json');
  await renameEntry(`Town/Merchant/${animImageFileName('Old', r3.uid)}`, `Town/Merchant/${animImageFileName('Run', r3.uid)}`);
  await renameEntry(`Town/Merchant/${animImageFileName('Old', r4.uid)}`, `Town/Merchant/${animImageFileName('Run', r4.uid)}`);
  await writeJson('Town/Merchant/Run.json', { frames: [{ uid: 'fr000001', image: r3.uid }] });
  check('8 images listed', (await listSessionCreated()).length === 8);

  const report = await sweepSessionCreated([c1.uid]);
  const has = (rel: string): boolean => existsSync(abs(rel));
  check('referenced base kept', has(`Town/Merchant/${baseImageFileName(b1.uid)}`));
  check('orphan base deleted', !has(`Town/Merchant/${baseImageFileName(b2.uid)}`));
  check('referenced reference kept', has(`Town/Merchant/${animImageFileName('Walk', r1.uid)}`));
  check('orphan reference deleted', !has(`Town/Merchant/${animImageFileName('Walk', r2.uid)}`));
  check('renamed owner, referenced: kept', has(`Town/Merchant/${animImageFileName('Run', r3.uid)}`));
  check('renamed owner, orphan: deleted', !has(`Town/Merchant/${animImageFileName('Run', r4.uid)}`));
  check('job-referenced kept', has(`Town/Merchant/${animImageFileName('Walk', c1.uid)}`));
  check('beside an unparsable json: kept', has(`Town/Smith/${animImageFileName('Bad', x1.uid)}`));
  check('sweep report', report.listed === 8 && report.deleted.length === 3 && report.kept === 2, JSON.stringify(report));
  const after = (await listSessionCreated()).map((e) => e.uid).sort();
  check('list rewritten with the undecided entries', JSON.stringify(after) === JSON.stringify([c1.uid, x1.uid].sort()), JSON.stringify(after));
  const raw = JSON.parse(readFileSync(abs(SESSION_CREATED_REL), 'utf8')) as { version: number; files: string[]; entries: unknown[] };
  check('list shape', raw.version === 1 && raw.files.length === 2 && raw.entries.length === 2);

  const again = await sweepSessionCreated([]);
  check('job acked → deleted on the next sweep', !has(`Town/Merchant/${animImageFileName('Walk', c1.uid)}`) && again.deleted.length === 1, JSON.stringify(again));
  check('unparsable json still protects', has(`Town/Smith/${animImageFileName('Bad', x1.uid)}`) && (await listSessionCreated()).length === 1);
}

async function testPixelLabClient(): Promise<void> {
  console.log('PixelLab client (fake fetch)');
  const fixture = readFileSync(path.join(ROOT, 'testbed', 'fixtures', 'merchant_rightfacing_truepixel_128.estimate.json'), 'utf8');
  const seen: { url: string; method: string; auth: string; body?: string }[] = [];
  const respond = (status: number, body: unknown): { ok: boolean; status: number; text(): Promise<string> } =>
    ({ ok: status >= 200 && status < 300, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
  const fetch: FetchLike = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body });
    if (url.endsWith('/balance'))
      return respond(200, { credits: { type: 'usd', usd: 10.5 }, subscription: { type: 'generations', status: 'active', generations: 450, total: 2000 } });
    if (url.endsWith('/estimate-skeleton'))
      return respond(200, fixture);
    return respond(404, { detail: 'Not Found' });
  };
  let config = { apiKey: 'test-key', baseUrl: 'https://api.pixellab.ai/v2/' };
  const client = new PixelLabClient({ fetch, getConfig: async () => config });
  const bal = await client.balance();
  check('balance mapping', bal.ok && bal.data.generations === 450 && bal.data.total === 2000 && bal.data.usd === 10.5, JSON.stringify(bal));
  check('bearer + base url', seen[0].url === 'https://api.pixellab.ai/v2/balance' && seen[0].auth === 'Bearer test-key' && seen[0].method === 'GET');
  const png = new Uint8Array(readFileSync(FIXTURE_128));
  const est = await client.estimateSkeleton(png);
  check('estimate reordered to canonical labels', est.ok && est.data.keypoints.map((k) => k.label).join() === SKELETON_LABELS.join(), JSON.stringify(est).slice(0, 300));
  check('estimate usage', est.ok && est.data.usage?.generations === 0.1);
  const sent = JSON.parse(seen[1].body ?? '{}') as { image: { type: string; base64: string; format: string } };
  check('estimate body', sent.image.type === 'base64' && sent.image.format === 'png' && Buffer.from(sent.image.base64, 'base64').equals(Buffer.from(png))
    && Object.keys(sent).length === 1 && Object.keys(sent.image).length === 3);
  config = { apiKey: 'test-key', baseUrl: 'https://evil.example.com/v2' };
  const bad = await client.balance();
  check('non-pixellab base url refused', !bad.ok && /pixellab\.ai/.test(bad.error) && seen.length === 2);
  config = { apiKey: '', baseUrl: 'https://api.pixellab.ai/v2' };
  const noKey = await client.balance();
  check('missing key', !noKey.ok && /API key is not set/.test(noKey.error));
  const http401 = new PixelLabClient({ fetch: async () => respond(401, { detail: 'Invalid API token' }), getConfig: async () => ({ apiKey: 'k', baseUrl: 'https://api.pixellab.ai/v2' }) });
  const r401 = await http401.balance();
  check('401 message', !r401.ok && r401.status === 401 && /rejected the API key.*Invalid API token/.test(r401.error), JSON.stringify(r401));
  const thrower = new PixelLabClient({ fetch: async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  }, getConfig: async () => ({ apiKey: 'k', baseUrl: 'https://api.pixellab.ai/v2' }) });
  const net = await thrower.balance();
  check('network error is a value', !net.ok && /Could not reach PixelLab/.test(net.error));

  // maybeSent: could a POST have reached PixelLab (and been billed) although no usable answer came back?
  const cfg = async (): Promise<{ apiKey: string; baseUrl: string }> => ({ apiKey: 'key-123', baseUrl: 'https://api.pixellab.ai/v2' });
  const post = { method: 'POST', path: '/animate-with-skeleton-v3', body: {}, timeoutMs: 1000 } as const;
  const sentWith = async (fetchImpl: FetchLike): Promise<boolean | undefined> => (await new PixelLabClient({ fetch: fetchImpl, getConfig: cfg }).request(post)).maybeSent;
  const throwing = (msg: string): FetchLike => async () => {
    throw new Error(msg);
  };
  check('DNS / refused / offline: not sent', await sentWith(throwing('getaddrinfo ENOTFOUND api.pixellab.ai')) === false
    && await sentWith(throwing('net::ERR_CONNECTION_REFUSED')) === false && await sentWith(throwing('net::ERR_INTERNET_DISCONNECTED')) === false);
  check('reset / empty response: maybe sent', await sentWith(throwing('net::ERR_CONNECTION_RESET')) === true && await sentWith(throwing('net::ERR_EMPTY_RESPONSE')) === true);
  check('5xx maybe sent, 4xx not', await sentWith(async () => respond(502, 'Bad Gateway')) === true && await sentWith(async () => respond(429, { detail: 'busy' })) === false);
  const hang: FetchLike = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const timedOut = await new PixelLabClient({ fetch: hang, getConfig: cfg }).request(post);
  check('timeout: maybe sent', !timedOut.ok && timedOut.maybeSent === true && /did not answer within 1 s/.test(timedOut.error ?? ''), JSON.stringify(timedOut));
  const leaky = await new PixelLabClient({ fetch: throwing('Headers.append: "Bearer key-123" is an invalid header value.'), getConfig: cfg }).request(post);
  check('the key is never echoed in errors', !(leaky.error ?? '').includes('key-123') && (leaky.error ?? '').includes('***'), leaky.error);
  let fetched = false;
  const zeroWidth = new PixelLabClient({ fetch: async () => {
    fetched = true;
    return respond(200, {});
  }, getConfig: async () => ({ apiKey: 'key​123', baseUrl: 'https://api.pixellab.ai/v2' }) });
  const badKey = await zeroWidth.balance();
  check('a key with invisible characters is refused before sending', !badKey.ok && /invalid characters/.test(badKey.error) && !fetched, JSON.stringify(badKey));
  const short = new PixelLabClient({ fetch: async () => respond(200, { keypoints: [{ label: 'NOSE', x: 0.5, y: 0.5, z_index: 0 }] }), getConfig: async () => ({ apiKey: 'k', baseUrl: 'https://api.pixellab.ai/v2' }) });
  const shortRes = await short.estimateSkeleton(png);
  check('incomplete estimate rejected', !shortRes.ok && /expected each of the 18 labels/.test(shortRes.error));
}

async function main(): Promise<void> {
  const base = await fsp.mkdtemp(path.join(process.env['PT_TEST_TMP'] || os.tmpdir(), 'ptk-main-fs-'));
  try {
    await testFs(base);
    await testScan(base);
    testAssetUrls();
    await testImages(base);
    await testImageFiles(base);
    await testSweep(base);
    await testPixelLabClient();
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
  console.log(`${passes} passed, ${failures} failed`);
  if (failures > 0)
    process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
