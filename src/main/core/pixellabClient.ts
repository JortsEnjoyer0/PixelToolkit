// Authenticated PixelLab transport and the typed operations (resolved-facts R0, R1, R3). Electron-free: main injects
// net.fetch and a settings reader, the tsx tests inject a fake fetch. Never throws: every failure is a value.
import type { Balance, EstimateResult, Result } from '../../shared/api';
import { finiteOrNull, isObj, type Obj } from '../../shared/json';
import { SKELETON_LABELS, canonicalKeypoints, checkedBase, type KeypointOut, type SkeletonLabel, type Usage } from '../../shared/pixellab';

export type PixelLabMethod = 'GET' | 'POST' | 'DELETE';

export interface PixelLabRequest {
  method: PixelLabMethod;
  /** Path below the API base, e.g. "/balance". Checked against an allow-list. */
  path: string;
  body?: unknown;
  /** Default 120 s, clamped to 1..600 s. */
  timeoutMs?: number;
}

/**
 * status 0 = no HTTP response (network error, timeout, configuration). maybeSent: no usable answer, but the request may
 * have reached PixelLab (timeout, connection lost after connecting, 5xx), so a POST may have been accepted and billed.
 */
export interface PixelLabResponse<T = unknown> { ok: boolean; status: number; data: T | null; error?: string; maybeSent?: boolean }

export interface FetchResponseLike { ok: boolean; status: number; text(): Promise<string> }
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<FetchResponseLike>;
export interface PixelLabConfig { apiKey: string; baseUrl: string }

const ALLOWED_PATH = /^\/(estimate-skeleton|animate-with-skeleton-v3|background-jobs\/[A-Za-z0-9-]+|balance)$/;
const ALLOWED_METHODS: readonly PixelLabMethod[] = ['GET', 'POST', 'DELETE'];
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const BALANCE_TIMEOUT_MS = 30_000;
const ESTIMATE_TIMEOUT_MS = 120_000;
/** A key is one printable ASCII token; anything else (a pasted space, line break or zero-width char) breaks the header. */
const API_KEY_RE = /^[\x21-\x7e]+$/;
/** Network errors raised before any connection to PixelLab existed (net::ERR_* from net.fetch, Node codes): never sent. */
const NOT_SENT_RE = new RegExp([
  'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_INTERNET_DISCONNECTED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT',
  'ERR_ADDRESS_UNREACHABLE', 'ERR_ADDRESS_INVALID', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_CERT_',
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'
].join('|'));

const fail = (error: string, maybeSent = false): PixelLabResponse => ({ ok: false, status: 0, data: null, error, maybeSent });

function parseBody(text: string): unknown {
  if (!text)
    return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** FastAPI style { detail } when present (string, or the 422 list of { loc, msg }). */
function detailText(data: unknown, text: string, status: number): string {
  const detail = isObj(data) ? data.detail : undefined;
  if (typeof detail === 'string')
    return detail;
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => isObj(d) ? `${Array.isArray(d.loc) ? d.loc.join('.') + ': ' : ''}${String(d.msg ?? '')}` : String(d));
    return msgs.join('; ').slice(0, 2000);
  }
  if (detail !== undefined)
    return JSON.stringify(detail).slice(0, 2000);
  return text.slice(0, 2000) || `HTTP ${status}`;
}

const STATUS_HINTS: Record<number, string> = {
  401: 'PixelLab rejected the API key',
  402: 'Not enough PixelLab credits',
  403: 'PixelLab refused the request (this needs a higher subscription tier)',
  429: 'PixelLab is busy (too many requests or concurrent jobs)'
};

/** Billing info (spec Usage); null unless it has a known type. */
export function parseUsage(v: unknown): Usage | null {
  if (!isObj(v) || (v.type !== 'usd' && v.type !== 'generations'))
    return null;
  const usage: Usage = { type: v.type };
  if (v.usd !== undefined)
    usage.usd = finiteOrNull(v.usd);
  if (v.generations !== undefined)
    usage.generations = finiteOrNull(v.generations);
  return usage;
}

export class PixelLabClient {
  constructor(private readonly deps: { fetch: FetchLike; getConfig: () => Promise<PixelLabConfig> }) {}

  /** Authenticated request. The key and base URL are read at call time, so settings edits apply without a restart. */
  async request(req: PixelLabRequest): Promise<PixelLabResponse> {
    if (!req || typeof req.path !== 'string' || !ALLOWED_PATH.test(req.path))
      return fail(`Endpoint not allowed: ${String(req?.path)}`);
    if (!ALLOWED_METHODS.includes(req.method))
      return fail(`Method not allowed: ${String(req.method)}`);
    let config: PixelLabConfig;
    try {
      config = await this.deps.getConfig();
    } catch (e) {
      return fail(`Could not read appSettings.config: ${(e as Error).message}`);
    }
    if (!config.apiKey)
      return fail('The PixelLab API key is not set (Settings, or appSettings.config pixellab.apiKey)');
    if (!API_KEY_RE.test(config.apiKey))
      return fail('The PixelLab API key contains invalid characters (spaces, line breaks or invisible characters). Re-enter it in Settings.');
    const base = checkedBase(config.baseUrl);
    if (!base)
      return fail(`pixellab.baseUrl must be an https://*.pixellab.ai URL, got: ${config.baseUrl}`);

    const timeoutMs = Math.min(Math.max(1000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const hasBody = req.body !== undefined && req.method !== 'GET';
    try {
      const res = await this.deps.fetch(base + req.path, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {})
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: ctrl.signal
      });
      const text = await res.text();
      const data = parseBody(text);
      if (res.ok)
        return { ok: true, status: res.status, data };
      const detail = detailText(data, text, res.status);
      const hint = STATUS_HINTS[res.status];
      const error = hint ? `${hint} (${res.status}: ${detail})` : `PixelLab error ${res.status}: ${detail}`;
      return { ok: false, status: res.status, data, error, maybeSent: res.status >= 500 };
    } catch (e) {
      if (ctrl.signal.aborted)
        return fail(`PixelLab did not answer within ${Math.round(timeoutMs / 1000)} s`, true);
      const msg = String((e as Error)?.message ?? e).split(config.apiKey).join('***'); // never echo the key
      const code = String((e as { cause?: { code?: unknown } })?.cause?.code ?? '');
      return fail(`Could not reach PixelLab: ${msg}`, !NOT_SENT_RE.test(`${msg} ${code}`));
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /balance → remaining subscription generations / total, USD credits. */
  async balance(): Promise<Result<Balance>> {
    const res = await this.request({ method: 'GET', path: '/balance', timeoutMs: BALANCE_TIMEOUT_MS });
    if (!res.ok)
      return { ok: false, status: res.status || undefined, error: res.error ?? 'Balance request failed' };
    const data = isObj(res.data) ? res.data : {};
    const sub = isObj(data.subscription) ? data.subscription : {};
    const credits = isObj(data.credits) ? data.credits : {};
    return { ok: true, data: { generations: finiteOrNull(sub.generations), total: finiteOrNull(sub.total), usd: finiteOrNull(credits.usd) } };
  }

  /** POST /estimate-skeleton with a padded square PNG; keypoints come back in SKELETON_LABELS order (z_index stays float). */
  async estimateSkeleton(png: Uint8Array): Promise<Result<EstimateResult>> {
    const body = { image: { type: 'base64', base64: Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString('base64'), format: 'png' } };
    const res = await this.request({ method: 'POST', path: '/estimate-skeleton', body, timeoutMs: ESTIMATE_TIMEOUT_MS });
    if (!res.ok)
      return { ok: false, status: res.status || undefined, error: res.error ?? 'Estimate request failed' };
    const data = isObj(res.data) ? res.data : {};
    const raw = Array.isArray(data.keypoints) ? data.keypoints : [];
    const kps = raw.filter((k): k is Obj => isObj(k) && (SKELETON_LABELS as readonly unknown[]).includes(k.label)
      && [k.x, k.y, k.z_index].every((n) => typeof n === 'number' && Number.isFinite(n)))
      .map((k): KeypointOut => ({ label: k.label as SkeletonLabel, x: k.x as number, y: k.y as number, z_index: k.z_index as number }));
    const keypoints = canonicalKeypoints(kps);
    if (!keypoints || kps.length !== raw.length)
      return { ok: false, error: `estimate-skeleton returned ${raw.length} keypoints; expected each of the ${SKELETON_LABELS.length} labels exactly once` };
    return { ok: true, data: { keypoints, usage: parseUsage(data.usage) } };
  }
}
